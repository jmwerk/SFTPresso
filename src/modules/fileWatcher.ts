import * as vscode from 'vscode';
import debounce from 'lodash.debounce';
import logger from '../logger';
import { isValidFile, fileDepth, toRemotePath } from '../helper';
import { upload, removeRemote, renameRemote } from '../fileHandlers';
import { WatcherService, WatcherConfig, TransferDirection } from '../core';
import app from '../app';
import StatusBarItem from '../ui/statusBarItem';
import { getFileService, getRunningTransformTasks } from './serviceManager';
import {
  claimWatcherSuppression,
  releaseWatcherSuppression,
  isWatcherSuppressed,
} from './watcherSuppression';

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

  // Cheapest check first: a plain ignore-list lookup, ahead of the
  // suppression scan, which walks every currently-claimed path. A
  // node_modules-scale write burst is exactly the case both exist to filter
  // out cheaply, so the ignore list -- unaffected by how many renames or
  // downloads happen to be in flight -- should get first refusal.
  if (ignore && ignore(uri.fsPath)) {
    logger.debug(`[watcher/ignored] ${uri.fsPath}`);
    return true;
  }

  if (isWatcherSuppressed(uri.fsPath)) {
    logger.debug(`[watcher/suppressed] ${uri.fsPath}`);
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

function getAutoRenameConfig(uri: vscode.Uri) {
  const fileService = getFileService(uri);
  if (!fileService) {
    return undefined;
  }

  try {
    return { fileService, config: fileService.getConfig() };
  } catch (error) {
    logger.debug(`[watcher/rename] config not resolvable for ${uri.fsPath}: ${(error as Error).message}`);
    return undefined;
  }
}

// A rename that server-side rename can't (or shouldn't) handle still needs
// the remote to end up matching the new local state. Doing it as
// upload-then-delete -- never the other order -- means the only remote copy
// is never removed before its replacement exists.
async function fallbackToUpload(oldUri: vscode.Uri, newUri: vscode.Uri) {
  try {
    await upload(newUri);
    await removeRemote(oldUri);
  } catch (error) {
    logger.error(error, `rename fallback for ${oldUri.fsPath}`);
    app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
  }
}

// Claims armed by onWillRenameFiles, for onDidRenameFiles to pick up and
// release once the rename settles. Keyed by both paths so a claim can only
// ever be picked up by the rename it was armed for.
const pendingRenameClaims = new Map<string, () => void>();

function renameClaimKey(oldUri: vscode.Uri, newUri: vscode.Uri): string {
  return `${oldUri.fsPath}\u0000${newUri.fsPath}`;
}

async function handleRenamedFile(oldUri: vscode.Uri, newUri: vscode.Uri) {
  const claimKey = renameClaimKey(oldUri, newUri);
  const armedRelease = pendingRenameClaims.get(claimKey);
  pendingRenameClaims.delete(claimKey);
  // Falls back to a plain (idempotent, no-op-if-absent) release for a rename
  // onWillRenameFiles never armed a claim for -- autoRename could have been
  // turned on between the two events, in theory.
  const release = () =>
    armedRelease
      ? armedRelease()
      : (releaseWatcherSuppression(oldUri.fsPath), releaseWatcherSuppression(newUri.fsPath));

  try {
    if (!isValidFile(oldUri)) {
      return;
    }

    const resolved = getAutoRenameConfig(oldUri);
    if (!resolved || !resolved.config.watcher || !resolved.config.watcher.autoRename) {
      return;
    }

    const { fileService, config } = resolved;

    const destResolved = getAutoRenameConfig(newUri);
    if (!destResolved || destResolved.fileService !== fileService) {
      logger.info(`[watcher/rename] crosses config boundary, falling back to upload: ${oldUri.fsPath}`);
      await fallbackToUpload(oldUri, newUri);
      return;
    }

    try {
      const newRemotePath = toRemotePath(newUri.fsPath, fileService.baseDir, config.remotePath);
      logger.info(`[watcher/rename] ${oldUri.fsPath} -> ${newUri.fsPath}`);
      await renameRemote(oldUri, { newRemotePath });
    } catch (error) {
      logger.warn(
        `[watcher/rename] server-side rename failed, falling back to upload: ${(error as Error).message}`
      );
      await fallbackToUpload(oldUri, newUri);
    }
  } finally {
    // Covers the whole SFTP round trip, however long it takes -- a large
    // directory rename can take a while, and the OS keeps firing delete/create
    // events for the subtree's contents in the meantime. A claim renews itself
    // every few seconds until released, unlike a fixed-TTL suppression, which
    // would lapse mid-rename on a slow link and let those tail-end events
    // leak through to race the in-flight rename.
    release();
  }
}

// Registered once at module load, not per watcher root: renames are a
// workspace-global VSCode event, unlike the per-root FileSystemWatcher above.
vscode.workspace.onWillRenameFiles(e => {
  for (const { oldUri, newUri } of e.files) {
    if (!isValidFile(oldUri)) {
      continue;
    }

    const resolved = getAutoRenameConfig(oldUri);
    if (resolved && resolved.config.watcher && resolved.config.watcher.autoRename) {
      // Claimed before the rename touches disk, so the delete+create events
      // it fires are already being dropped by the time they arrive.
      const releaseOld = claimWatcherSuppression(oldUri.fsPath);
      const releaseNew = claimWatcherSuppression(newUri.fsPath);
      pendingRenameClaims.set(renameClaimKey(oldUri, newUri), () => {
        releaseOld();
        releaseNew();
      });
    }
  }
});

vscode.workspace.onDidRenameFiles(e => {
  e.files.forEach(({ oldUri, newUri }) => {
    handleRenamedFile(oldUri, newUri).catch(error => {
      logger.error(error, `handle rename ${oldUri.fsPath}`);
    });
  });
});

const watcherService: WatcherService = {
  create: createWatcher,
  dispose: removeWatcher,
};

export default watcherService;
