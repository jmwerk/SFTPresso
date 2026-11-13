import { l10n, ProgressLocation, window } from 'vscode';
import { TransferDirection } from '../core';
import { ContentHasher } from '../core/contentHash';
import { compareFolders, CompareResult } from './compareFolders';
import { describeHashProgress } from './hashProgress';
import { FileHandlerContext } from './createFileHandler';

// The subset of a sync's transferOption that affects what a sync would do.
export interface SyncPreviewOption {
  delete?: boolean;
  skipCreate?: boolean;
  ignoreExisting?: boolean;
  update?: boolean;
  bothDiretions?: boolean;
}

export interface SyncPlan {
  create: string[];
  overwrite: string[];
  delete: string[];
  // directories (or, comparing by content, files) the compare could not read.
  // They are never classified as anything else -- in particular never as a
  // deletion -- but the user is told the preview is incomplete, because the
  // real sync will fail on them.
  unreadable: string[];
  // files a size + mtime check would have overwritten, skipped because their
  // contents are identical
  identical: number;
}

const MAX_DETAIL_LINES = 40;

// Classify the recursive local/remote diff into the operations a sync would
// perform, honoring the same syncOption flags the real sync respects. A
// local-only / remote-only directory shows up as a single entry (its subtree
// is not expanded) — good enough for a summary preview.
export function computeSyncPlan(
  results: CompareResult[],
  direction: TransferDirection,
  option: SyncPreviewOption
): SyncPlan {
  const plan: SyncPlan = {
    create: [],
    overwrite: [],
    delete: [],
    unreadable: [],
    identical: results.filter(r => r.timestampOnly).length,
  };

  if (option.bothDiretions) {
    // Both-directions keeps the newest copy on each side and never deletes;
    // only skipCreate and ignoreExisting apply (matches the sync handler).
    for (const r of results) {
      if (r.status === 'error') {
        plan.unreadable.push(r.relativePath);
      } else if (r.status === 'localOnly' || r.status === 'remoteOnly') {
        if (!option.skipCreate) plan.create.push(r.relativePath);
      } else if (r.status === 'modified') {
        if (!option.ignoreExisting) plan.overwrite.push(r.relativePath);
      }
    }
    return plan;
  }

  const isLocalToRemote = direction === TransferDirection.LOCAL_TO_REMOTE;
  const srcOnly = isLocalToRemote ? 'localOnly' : 'remoteOnly';
  const destOnly = isLocalToRemote ? 'remoteOnly' : 'localOnly';

  for (const r of results) {
    if (r.status === 'error') {
      plan.unreadable.push(r.relativePath);
    } else if (r.status === srcOnly) {
      if (!option.skipCreate) plan.create.push(r.relativePath);
    } else if (r.status === destOnly) {
      if (option.delete) plan.delete.push(r.relativePath);
    } else if (r.status === 'modified') {
      const srcNewer = isLocalToRemote
        ? r.localMtime > r.remoteMtime
        : r.remoteMtime > r.localMtime;
      if (!option.ignoreExisting && (!option.update || srcNewer)) {
        plan.overwrite.push(r.relativePath);
      }
    }
  }

  return plan;
}

// Both forms are passed already translated so the l10n extractor sees each string.
function plural(count: number, one: string, other: string): string {
  return count === 1 ? one : other;
}

type CreateKind = 'transfer' | 'upload' | 'download';

function createCount(kind: CreateKind, count: number): string {
  switch (kind) {
    case 'upload':
      return plural(count, l10n.t('1 upload'), l10n.t('{0} uploads', count));
    case 'download':
      return plural(count, l10n.t('1 download'), l10n.t('{0} downloads', count));
    default:
      return plural(count, l10n.t('1 transfer'), l10n.t('{0} transfers', count));
  }
}

function createLine(kind: CreateKind, fsPath: string): string {
  switch (kind) {
    case 'upload':
      return l10n.t('+ upload: {0}', fsPath);
    case 'download':
      return l10n.t('+ download: {0}', fsPath);
    default:
      return l10n.t('+ transfer: {0}', fsPath);
  }
}

function buildDetail(plan: SyncPlan, createKind: CreateKind): string {
  const lines: string[] = [];
  if (plan.identical > 0) {
    lines.push(
      plural(
        plan.identical,
        l10n.t('= 1 file with different timestamps but identical contents, skipped'),
        l10n.t(
          '= {0} files with different timestamps but identical contents, skipped',
          plan.identical
        )
      )
    );
  }
  // first, so an incomplete preview is the first thing read
  plan.unreadable.forEach(p => lines.push(l10n.t('! could not read: {0}', p)));
  plan.create.forEach(p => lines.push(createLine(createKind, p)));
  plan.overwrite.forEach(p => lines.push(l10n.t('~ overwrite: {0}', p)));
  plan.delete.forEach(p => lines.push(l10n.t('- delete: {0}', p)));

  if (lines.length > MAX_DETAIL_LINES) {
    const shown = lines.slice(0, MAX_DETAIL_LINES);
    shown.push(l10n.t('… and {0} more', lines.length - MAX_DETAIL_LINES));
    return shown.join('\n');
  }
  return lines.join('\n');
}

// Decide whether the sync should proceed. When syncConfirm resolves to true,
// build a dry-run preview and ask for confirmation; otherwise run unchanged.
// The preview walks the tree once here and the sync walks it again — accepted
// for v1, and only paid when confirmation is actually enabled.
export async function confirmSyncOrProceed(
  ctx: FileHandlerContext,
  direction: TransferDirection,
  option: SyncPreviewOption,
  // the sync's own hasher when comparing by content, so it reuses these hashes
  hasher?: ContentHasher
): Promise<boolean> {
  const deleteEnabled = !!option.delete && !option.bothDiretions;

  // Explicit default: honor syncConfirm when set, otherwise default to true
  // only when a sync could delete files (the destructive case).
  const configConfirm = (ctx.config as any).syncConfirm;
  const enabled = configConfirm !== undefined ? !!configConfirm : deleteEnabled;
  if (!enabled) {
    return true;
  }

  let cancelled = false;
  const results = await window.withProgress(
    {
      location: ProgressLocation.Notification,
      title: l10n.t('SFTP: preparing sync preview'),
      cancellable: true,
    },
    (progress, token) => {
      const isCancelled = () => {
        cancelled = cancelled || token.isCancellationRequested;
        return cancelled;
      };
      if (hasher) {
        token.onCancellationRequested(() => hasher.cancel());
        hasher.onProgress(stats => progress.report({ message: describeHashProgress(stats) }));
      }
      // the sync creates its destination root, so a missing one is not an error
      const missingRoot =
        direction === TransferDirection.REMOTE_TO_LOCAL && !option.bothDiretions
          ? 'local'
          : 'remote';
      return compareFolders(ctx, { isCancelled }, { hasher, missingRoot });
    }
  );
  if (cancelled) {
    return false;
  }
  const plan = computeSyncPlan(results, direction, option);
  const total = plan.create.length + plan.overwrite.length + plan.delete.length;

  const dirLabel = option.bothDiretions
    ? l10n.t('Both Directions')
    : direction === TransferDirection.LOCAL_TO_REMOTE
      ? l10n.t('Local → Remote')
      : l10n.t('Remote → Local');

  if (total === 0 && plan.unreadable.length === 0) {
    window.showInformationMessage(
      l10n.t('SFTP Sync {0}: nothing to do — local and remote already match.', dirLabel)
    );
    return false;
  }

  const createKind: CreateKind = option.bothDiretions
    ? 'transfer'
    : direction === TransferDirection.LOCAL_TO_REMOTE
      ? 'upload'
      : 'download';

  const parts = [
    createCount(createKind, plan.create.length),
    plural(
      plan.overwrite.length,
      l10n.t('1 overwrite'),
      l10n.t('{0} overwrites', plan.overwrite.length)
    ),
  ];
  if (!option.bothDiretions) {
    parts.push(
      plural(plan.delete.length, l10n.t('1 deletion'), l10n.t('{0} deletions', plan.delete.length))
    );
  }

  let summary = l10n.t('Sync {0}: {1}. Proceed?', dirLabel, parts.join(', '));
  if (plan.unreadable.length > 0) {
    // The plan below is built from what could be read, so it is not the whole
    // picture -- say so before the user approves it. The sync itself will fail
    // on these directories rather than acting on the gap.
    summary = plural(
      plan.unreadable.length,
      l10n.t(
        'Sync {0}: 1 entry could not be read, so this preview is incomplete. Of what could be read: {1}. Proceed?',
        dirLabel,
        parts.join(', ')
      ),
      l10n.t(
        'Sync {0}: {1} entries could not be read, so this preview is incomplete. Of what could be read: {2}. Proceed?',
        dirLabel,
        plan.unreadable.length,
        parts.join(', ')
      )
    );
  }
  const detail = buildDetail(plan, createKind);

  const proceed = l10n.t('Proceed');
  const choice = await window.showWarningMessage(summary, { modal: true, detail }, proceed);
  return choice === proceed;
}
