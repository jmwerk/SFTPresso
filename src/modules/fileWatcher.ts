import * as vscode from 'vscode';
import debounce from 'lodash.debounce';
import logger from '../logger';
import { isValidFile, fileDepth } from '../helper';
import { upload, removeRemote } from '../fileHandlers';
import { WatcherService, WatcherConfig, TransferDirection } from '../core';
import app from '../app';
import StatusBarItem from '../ui/statusBarItem';
import { getRunningTransformTasks } from './serviceManager';

const watchers: {
  [x: string]: vscode.FileSystemWatcher;
} = {};

// Keyed by fsPath, not by Uri. Every FileSystemWatcher event hands us a fresh
// Uri instance, so a Set would compare object identity and let the same file
// saved three times inside the debounce window enqueue three uploads -- which
// is the common case, not the corner one (autosave, formatters, build watchers
// touching their output).
const uploadQueue = new Map<string, vscode.Uri>();
const deleteQueue = new Map<string, vscode.Uri>();

// less than 550 will not work
const ACTION_INTEVAL = 550;

function doUpload() {
  const files = Array.from(uploadQueue.values()).sort(
    (a, b) => fileDepth(b.fsPath) - fileDepth(a.fsPath)
  );
  uploadQueue.clear();

  const currentDownloadTasks = getRunningTransformTasks().filter(
    task => task.transferType === TransferDirection.REMOTE_TO_LOCAL
  );

  files.forEach(async uri => {
    // current target is still in downloading, so don't upload it.
    if (currentDownloadTasks.find(task => task.localFsPath === uri.fsPath)) {
      return;
    }

    const fspath = uri.fsPath;
    logger.info(`[watcher/updated] ${fspath}`);
    try {
      await upload(uri);
    } catch (error) {
      logger.error(error, `upload ${fspath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  });
}

function doDelete() {
  const files = Array.from(deleteQueue.values()).sort(
    (a, b) => fileDepth(b.fsPath) - fileDepth(a.fsPath)
  );
  deleteQueue.clear();
  files.forEach(async uri => {
    const fspath = uri.fsPath;
    logger.info(`[watcher/removed] ${fspath}`);
    try {
      await removeRemote(uri);
    } catch (error) {
      logger.error(error, `remove ${fspath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  });
}

const debouncedUpload = debounce(doUpload, ACTION_INTEVAL, { leading: true, trailing: true });
const debouncedDelete = debounce(doDelete, ACTION_INTEVAL, { leading: true, trailing: true });

type IgnoreFn = ((fsPath: string) => boolean) | null | undefined;

// The ignore rules are consulted again further down the transfer path, but a
// path that will never be sent has no business occupying the queue, being
// depth-sorted, or crossing into the transfer machinery -- a node_modules-scale
// write burst would push hundreds of doomed entries through the debounce.
function shouldSkip(uri: vscode.Uri, ignore: IgnoreFn): boolean {
  if (!isValidFile(uri)) {
    return true;
  }

  if (ignore && ignore(uri.fsPath)) {
    logger.debug(`[watcher/ignored] ${uri.fsPath}`);
    return true;
  }

  return false;
}

function createUploadHandler(ignore: IgnoreFn) {
  return (uri: vscode.Uri) => {
    if (shouldSkip(uri, ignore)) {
      return;
    }

    uploadQueue.set(uri.fsPath, uri);
    debouncedUpload();
  };
}

function createDeleteHandler(ignore: IgnoreFn) {
  return (uri: vscode.Uri) => {
    if (shouldSkip(uri, ignore)) {
      return;
    }

    deleteQueue.set(uri.fsPath, uri);
    debouncedDelete();
  };
}

function addWatcher(id, watcher) {
  watchers[id] = watcher;
}

function getWatcher(id) {
  return watchers[id];
}

function removeWatcher(watcherBase: string) {
  const watcher = getWatcher(watcherBase);
  if (watcher) {
    watcher.dispose();
    delete watchers[watcherBase];
  }
}

function createWatcher(
  watcherBase: string,
  watcherConfig: WatcherConfig,
  ignore?: IgnoreFn
) {
  // Dispose *and* forget. Every early return below leaves no watcher behind,
  // and a disposed one left in the table is worse than none: getWatcher() would
  // still hand it out on the next lookup.
  removeWatcher(watcherBase);

  if (!watcherConfig) {
    return;
  }

  const shouldAddListenser = watcherConfig.autoUpload || watcherConfig.autoDelete;
  if (watcherConfig.files === false || watcherConfig.files === '' || !shouldAddListenser) {
    return;
  }

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(watcherBase, watcherConfig.files),
    false,
    false,
    false
  );
  addWatcher(watcherBase, watcher);

  if (watcherConfig.autoUpload) {
    const uploadHandler = createUploadHandler(ignore);
    watcher.onDidCreate(uploadHandler);
    watcher.onDidChange(uploadHandler);
  }

  if (watcherConfig.autoDelete) {
    watcher.onDidDelete(createDeleteHandler(ignore));
  }
}

const watcherService: WatcherService = {
  create: createWatcher,
  dispose: removeWatcher,
};

export default watcherService;
