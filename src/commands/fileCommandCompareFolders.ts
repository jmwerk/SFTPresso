import { Uri, window, ProgressLocation, CancellationToken } from 'vscode';
import { COMMAND_COMPARE_FOLDERS } from '../constants';
import { FileType } from '../core';
import { compareFolders, diff, uploadFile, downloadFile } from '../fileHandlers';
import { CompareResult, CompareStatus } from '../fileHandlers/compareFolders';
import { checkFileCommand } from './abstract/createCommand';
import { selectFolderFallbackToConfigContext, uriFromfspath, applySelector } from './shared';
import { reportError } from '../helper';

const STATUS_LABEL: { [key in CompareStatus]: string } = {
  modified: '$(diff-modified) Modified',
  localOnly: '$(diff-added) Local only',
  remoteOnly: '$(diff-removed) Remote only',
  same: '$(check) Identical',
  error: '$(warning) Could not read',
};

async function showResults(uri: Uri, results: CompareResult[]): Promise<void> {
  const changed = results.filter(r => r.status !== 'same');
  if (changed.length === 0) {
    window.showInformationMessage('Compare Folders: local and remote are identical.');
    return;
  }

  const items = changed.map(result => ({
    label: `${STATUS_LABEL[result.status]}  ${result.relativePath}`,
    description: result.type === FileType.Directory ? '(folder)' : '',
    result,
  }));

  const picked = await window.showQuickPick(items, {
    placeHolder: `${changed.length} difference(s) found. Select a file for actions...`,
    matchOnDescription: true,
  });

  if (!picked) {
    return;
  }

  await showActionsForResult(uri, picked.result, results);
}

async function showActionsForResult(
  uri: Uri,
  result: CompareResult,
  results: CompareResult[]
): Promise<void> {
  const actions: Array<{ label: string; action: () => Promise<void> }> = [];

  // Nothing is known about what is inside a directory we could not list, so
  // offering to transfer it either way would be acting on a guess.
  if (result.status === 'error') {
    window.showWarningMessage(
      `Compare Folders: ${result.relativePath} could not be compared — ${result.error}`
    );
    await showResults(uri, results);
    return;
  }

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

  actions.push({ label: '$(arrow-left) Back to list', action: () => showResults(uri, results) });

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
    const uri = Uri.file(ctx.target.localFsPath);
    let cancelToken: CancellationToken | undefined;
    const results = await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: 'Comparing local and remote folders...',
        cancellable: true,
      },
      (_progress, token) => {
        // cancelling stops the walk itself, not just the notification
        cancelToken = token;
        return compareFolders(ctx, { isCancelled: () => token.isCancellationRequested });
      }
    );

    // a cancelled walk leaves a partial diff — showing it would read as a
    // complete comparison
    if (cancelToken && cancelToken.isCancellationRequested) {
      return;
    }

    await showResults(uri, results);
  },
});
