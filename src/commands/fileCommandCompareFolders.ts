import { Uri, window, ProgressLocation } from 'vscode';
import { COMMAND_COMPARE_FOLDERS } from '../constants';
import { FileType } from '../core';
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

const STATUS_LABEL: { [key in CompareStatus]: string } = {
  modified: '$(diff-modified) Modified',
  localOnly: '$(diff-added) Local only',
  remoteOnly: '$(diff-removed) Remote only',
  same: '$(check) Identical',
  error: '$(warning) Could not read',
};

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

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
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
      ? `${plural(timestampOnly, 'file')} differ only in timestamp and ${
          timestampOnly === 1 ? 'is' : 'are'
        } treated as identical.`
      : '';

  if (changed.length === 0) {
    window.showInformationMessage(
      ['Compare Folders: local and remote are identical.', timestampNote].filter(Boolean).join(' ')
    );
    return;
  }

  const picks: Pick[] = [];

  const modified = modifiedFiles(results);
  if (modified.length > 1) {
    picks.push({
      label: '$(diff-multiple) Open All Diffs',
      description: plural(modified.length, 'modified file'),
      detail: 'Open each modified file side by side with its remote copy, one tab per file.',
      run: () => openAllDiffs(session, modified),
    });
  }

  const recheckable = session.byContent ? 0 : countRecheckable(results);
  if (recheckable > 0) {
    picks.push({
      label: '$(search) Check Contents',
      description: plural(recheckable, 'same-size file'),
      detail:
        'Hash these to drop the ones that differ only in timestamp. ' +
        'Set "compareMode": "content" to always compare this way.',
      run: () => recheck(session),
    });
  }

  picks.push(
    ...changed.map(result => ({
      label: `${STATUS_LABEL[result.status]}  ${result.relativePath}`,
      description: result.type === FileType.Directory ? '(folder)' : '',
      detail: result.status === 'error' ? result.error : undefined,
      run: () => showActionsForResult(session, result),
    }))
  );

  const summary = [
    note,
    `${plural(changed.length, 'difference')} found.`,
    timestampNote,
    'Select a file for actions...',
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
    'Comparing file contents...',
    async hasher => {
      await recheckByContent(session.ctx, session.results, hasher!);
      return true;
    },
    isCancelled => new ContentHasher({ concurrency: session.ctx.config.concurrency, isCancelled })
  );
  if (!done) {
    await showResults(session, 'Content check cancelled.');
    return;
  }

  session.byContent = true;
  const cleared = before - modifiedFiles(session.results).length;
  await showResults(
    session,
    cleared > 0
      ? `${plural(cleared, 'file')} turned out identical.`
      : 'Every modified file really differs.'
  );
}

async function openAllDiffs(session: CompareSession, files: CompareResult[]): Promise<void> {
  if (files.length > OPEN_ALL_CONFIRM_THRESHOLD) {
    const choice = await window.showWarningMessage(
      `Open ${files.length} diff tabs?`,
      { modal: true, detail: 'Each one downloads the remote copy of the file.' },
      'Open All'
    );
    if (choice !== 'Open All') {
      await showResults(session);
      return;
    }
  }

  const failed: string[] = [];
  let opened = 0;
  await window.withProgress(
    { location: ProgressLocation.Notification, title: 'Opening diffs', cancellable: true },
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
      `Opened ${opened} of ${plural(files.length, 'diff')}. Failed: ${failed.join('; ')}`
    );
  }
}

async function showActionsForResult(session: CompareSession, result: CompareResult): Promise<void> {
  // Nothing is known about what is inside a directory we could not list, or a
  // file we could not read, so offering to transfer it either way would be
  // acting on a guess.
  if (result.status === 'error') {
    window.showWarningMessage(
      `Compare Folders: ${result.relativePath} could not be compared — ${result.error}`
    );
    await showResults(session);
    return;
  }

  const actions: Array<{ label: string; action: () => Promise<void> }> = [];

  if (result.status === 'modified' && result.type !== FileType.Directory) {
    actions.push({
      label: '$(diff) Open Diff',
      action: () => diff(Uri.file(result.localFsPath)),
    });
  }

  actions.push({
    label: '$(arrow-up) Upload Local -> Remote',
    action: () => uploadFile(Uri.file(result.localFsPath)),
  });

  actions.push({
    label: '$(arrow-down) Download Remote -> Local',
    action: () => downloadFile(Uri.file(result.localFsPath)),
  });

  actions.push({ label: '$(arrow-left) Back to list', action: () => showResults(session) });

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
    // A cancelled walk leaves a partial diff — showing it would read as a
    // complete comparison, so it resolves to undefined and nothing is shown.
    // Cancelling stops the walk itself, not just the notification.
    const results = await withHashProgress(
      byContent
        ? 'Comparing local and remote folders by content...'
        : 'Comparing local and remote folders...',
      (hasher, isCancelled) => compareFolders(ctx, { isCancelled }, { hasher }),
      isCancelled => createContentHasher(ctx.config, { isCancelled })
    );

    if (!results) {
      return;
    }

    await showResults({ ctx, results, byContent });
  },
});
