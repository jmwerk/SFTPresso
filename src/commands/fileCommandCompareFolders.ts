import { l10n, ProgressLocation, Uri, window } from 'vscode';
import { COMMAND_COMPARE_FOLDERS } from '../constants';
import { FileType, isNotFoundError } from '../core';
import { ContentHasher, createContentHasher } from '../core/contentHash';
import {
  compareFolders,
  countRecheckable,
  recheckByContent,
  diff,
  uploadFile,
  downloadFile,
  FileHandlerContext,
} from '../fileHandlers';
import { CompareResult, CompareStatus } from '../fileHandlers/compareFolders';
import { describeHashProgress } from '../fileHandlers/hashProgress';
import { checkFileCommand } from './abstract/createCommand';
import { selectFolderFallbackToConfigContext, uriFromfspath, applySelector } from './shared';
import { reportError } from '../helper';
import logger from '../logger';

function statusLabel(status: CompareStatus): string {
  switch (status) {
    case 'modified':
      return l10n.t('$(diff-modified) Modified');
    case 'localOnly':
      return l10n.t('$(diff-added) Local only');
    case 'remoteOnly':
      return l10n.t('$(diff-removed) Remote only');
    case 'same':
      return l10n.t('$(check) Identical');
    default:
      return l10n.t('$(warning) Could not read');
  }
}

// Opening more diff tabs than this at once asks first.
const OPEN_ALL_CONFIRM_THRESHOLD = 10;

interface CompareSession {
  ctx: FileHandlerContext;
  results: CompareResult[];
  // whether every same-size file has already been compared by content, either
  // by compareMode or by a recheck from this list
  byContent: boolean;
}

interface Pick {
  label: string;
  description?: string;
  detail?: string;
  run(): Promise<void>;
}

// Both forms are passed already translated so the l10n extractor sees each string.
function plural(count: number, one: string, other: string): string {
  return count === 1 ? one : other;
}

function modifiedFiles(results: CompareResult[]): CompareResult[] {
  return results.filter(r => r.status === 'modified' && r.type !== FileType.Directory);
}

// Runs `task` under a cancellable notification that shows hashing progress.
// Resolves to undefined when the user cancelled.
async function withHashProgress<T>(
  title: string,
  task: (hasher: ContentHasher | undefined, isCancelled: () => boolean) => Promise<T>,
  makeHasher: (isCancelled: () => boolean) => ContentHasher | undefined
): Promise<T | undefined> {
  let cancelled = false;
  const value = await window.withProgress(
    { location: ProgressLocation.Notification, title, cancellable: true },
    (progress, token) => {
      const isCancelled = () => {
        cancelled = cancelled || token.isCancellationRequested;
        return cancelled;
      };
      const hasher = makeHasher(isCancelled);
      if (hasher) {
        hasher.onProgress(stats => progress.report({ message: describeHashProgress(stats) }));
      }
      return task(hasher, isCancelled);
    }
  );
  return cancelled ? undefined : value;
}

async function showResults(session: CompareSession, note?: string): Promise<void> {
  const { results } = session;
  const changed = results.filter(r => r.status !== 'same');
  const timestampOnly = results.filter(r => r.timestampOnly).length;
  const timestampNote =
    timestampOnly > 0
      ? plural(
          timestampOnly,
          l10n.t('1 file differs only in timestamp and is treated as identical.'),
          l10n.t(
            '{0} files differ only in timestamp and are treated as identical.',
            timestampOnly.toLocaleString()
          )
        )
      : '';

  if (changed.length === 0) {
    window.showInformationMessage(
      [l10n.t('Compare Folders: local and remote are identical.'), timestampNote]
        .filter(Boolean)
        .join(' ')
    );
    return;
  }

  const picks: Pick[] = [];

  const modified = modifiedFiles(results);
  if (modified.length > 1) {
    picks.push({
      label: l10n.t('$(diff-multiple) Open All Diffs'),
      description: plural(
        modified.length,
        l10n.t('{0} modified file', modified.length.toLocaleString()),
        l10n.t('{0} modified files', modified.length.toLocaleString())
      ),
      detail: l10n.t(
        'Open each modified file side by side with its remote copy, one tab per file.'
      ),
      run: () => openAllDiffs(session, modified),
    });
  }

  const recheckable = session.byContent ? 0 : countRecheckable(results);
  if (recheckable > 0) {
    picks.push({
      label: l10n.t('$(search) Check Contents'),
      description: plural(
        recheckable,
        l10n.t('{0} same-size file', recheckable.toLocaleString()),
        l10n.t('{0} same-size files', recheckable.toLocaleString())
      ),
      detail: l10n.t(
        'Hash these to drop the ones that differ only in timestamp. Set "compareMode": "content" to always compare this way.'
      ),
      run: () => recheck(session),
    });
  }

  picks.push(
    ...changed.map(result => ({
      label: `${statusLabel(result.status)}  ${result.relativePath}`,
      description: result.type === FileType.Directory ? l10n.t('(folder)') : '',
      detail: result.status === 'error' ? result.error : undefined,
      run: () => showActionsForResult(session, result),
    }))
  );

  const summary = [
    note,
    plural(
      changed.length,
      l10n.t('1 difference found.'),
      l10n.t('{0} differences found.', changed.length.toLocaleString())
    ),
    timestampNote,
    l10n.t('Select a file for actions...'),
  ]
    .filter(Boolean)
    .join(' ');

  const picked = await window.showQuickPick(picks, {
    placeHolder: summary,
    matchOnDescription: true,
  });

  if (!picked) {
    return;
  }

  try {
    await picked.run();
  } catch (error) {
    reportError(error);
  }
}

async function recheck(session: CompareSession): Promise<void> {
  const before = modifiedFiles(session.results).length;
  const done = await withHashProgress(
    l10n.t('Comparing file contents...'),
    async hasher => {
      await recheckByContent(session.ctx, session.results, hasher!);
      return true;
    },
    isCancelled => new ContentHasher({ concurrency: session.ctx.config.concurrency, isCancelled })
  );
  if (!done) {
    await showResults(session, l10n.t('Content check cancelled.'));
    return;
  }

  session.byContent = true;
  const cleared = before - modifiedFiles(session.results).length;
  await showResults(
    session,
    cleared > 0
      ? plural(
          cleared,
          l10n.t('1 file turned out identical.'),
          l10n.t('{0} files turned out identical.', cleared.toLocaleString())
        )
      : l10n.t('Every modified file really differs.')
  );
}

async function openAllDiffs(session: CompareSession, files: CompareResult[]): Promise<void> {
  if (files.length > OPEN_ALL_CONFIRM_THRESHOLD) {
    const openAll = l10n.t('Open All');
    const choice = await window.showWarningMessage(
      l10n.t('Open {0} diff tabs?', files.length),
      { modal: true, detail: l10n.t('Each one downloads the remote copy of the file.') },
      openAll
    );
    if (choice !== openAll) {
      await showResults(session);
      return;
    }
  }

  const failed: string[] = [];
  let opened = 0;
  await window.withProgress(
    { location: ProgressLocation.Notification, title: l10n.t('Opening diffs'), cancellable: true },
    async (progress, token) => {
      for (const file of files) {
        if (token.isCancellationRequested) {
          break;
        }
        progress.report({
          message: `${opened + failed.length + 1}/${files.length} ${file.relativePath}`,
          increment: 100 / files.length,
        });
        try {
          // pinned tabs, so each diff does not replace the last; focus stays
          // put until the user picks one
          await diff(Uri.file(file.localFsPath), { preview: false, preserveFocus: true });
          opened += 1;
        } catch (error) {
          failed.push(`${file.relativePath}: ${error && error.message ? error.message : error}`);
        }
      }
    }
  );

  if (failed.length > 0) {
    failed.forEach(line => logger.warn(`open diff failed for ${line}`));
    window.showWarningMessage(
      l10n.t('Opened {0} of {1} diffs. Failed: {2}', opened, files.length, failed.join('; '))
    );
  }
}

async function showActionsForResult(session: CompareSession, result: CompareResult): Promise<void> {
  // Nothing is known about what is inside a directory we could not list, or a
  // file we could not read, so offering to transfer it either way would be
  // acting on a guess.
  if (result.status === 'error') {
    window.showWarningMessage(
      l10n.t(
        'Compare Folders: {0} could not be compared — {1}',
        result.relativePath,
        String(result.error)
      )
    );
    await showResults(session);
    return;
  }

  const actions: Array<{ label: string; action: () => Promise<void> }> = [];

  if (result.status === 'modified' && result.type !== FileType.Directory) {
    actions.push({
      label: l10n.t('$(diff) Open Diff'),
      action: () => diff(Uri.file(result.localFsPath)),
    });
  }

  actions.push({
    label: l10n.t('$(arrow-up) Upload Local -> Remote'),
    action: () => uploadFile(Uri.file(result.localFsPath)),
  });

  actions.push({
    label: l10n.t('$(arrow-down) Download Remote -> Local'),
    action: () => downloadFile(Uri.file(result.localFsPath)),
  });

  actions.push({ label: l10n.t('$(arrow-left) Back to list'), action: () => showResults(session) });

  const pickedAction = await window.showQuickPick(actions, {
    placeHolder: result.relativePath,
  });

  if (!pickedAction) {
    return;
  }

  try {
    await pickedAction.action();
  } catch (error) {
    reportError(error);
  }
}

export default checkFileCommand({
  id: COMMAND_COMPARE_FOLDERS,
  getFileTarget: applySelector(uriFromfspath, selectFolderFallbackToConfigContext),

  async handleFile(ctx) {
    const byContent = ctx.config.compareMode === 'content';
    // The folder that was clicked exists; its counterpart may not yet, which reads as empty
    // (everything one-sided) rather than failing the compare.
    let missingRoot: 'local' | 'remote' = 'remote';
    try {
      await ctx.fileService.getLocalFileSystem().lstat(ctx.target.localFsPath);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      missingRoot = 'local';
    }
    // A cancelled walk leaves a partial diff — showing it would read as a
    // complete comparison, so it resolves to undefined and nothing is shown.
    // Cancelling stops the walk itself, not just the notification.
    const results = await withHashProgress(
      byContent
        ? l10n.t('Comparing local and remote folders by content...')
        : l10n.t('Comparing local and remote folders...'),
      (hasher, isCancelled) => compareFolders(ctx, { isCancelled }, { hasher, missingRoot }),
      isCancelled => createContentHasher(ctx.config, { isCancelled })
    );

    if (!results) {
      return;
    }

    await showResults({ ctx, results, byContent });
  },
});
