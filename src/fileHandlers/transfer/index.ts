import * as path from 'path';
import { window, ProgressLocation } from 'vscode';
import app from '../../app';
import StatusBarItem from '../../ui/statusBarItem';
import { FileEntry, TransferTask } from '../../core';
import logger from '../../logger';
import { refreshRemoteExplorer } from '../shared';
import createFileHandler, { FileHandlerContext } from '../createFileHandler';
import { confirmSyncOrProceed } from '../syncPreview';
import { diff } from '../diff';
import { confirmUpload, updateBaselineAfterTransfer } from './conflictCheck';
import {
  transfer,
  sync,
  TransferOption,
  SyncOption,
  TransferDirection,
  SkippedEntry,
} from './transfer';
import { claimWatcherSuppression } from '../../modules/watcherSuppression';
import { onTransferEvent } from '../../modules/serviceManager';

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Make maxFileSize skips visible after the fact.
 *
 * Skipped files never enter the transfer queue, so with no report a batch
 * transfer of a project with one stray oversized file would just look done --
 * one file quietly missing, no error, nothing in the log a user would think
 * to check. A transient toast here just adds to notification noise the user
 * has to keep up with in real time; the status bar warn icon persists until
 * they open the output panel, so it can't be missed by looking away.
 */
function reportSkipped(label: string, skipped: SkippedEntry[]): void {
  if (skipped.length === 0) {
    return;
  }

  skipped.forEach(entry =>
    logger.info(`${label} skipped ${entry.fsPath} (${formatSize(entry.size)}, over maxFileSize)`)
  );
  const largest = skipped.reduce((a, b) => (b.size > a.size ? b : a));
  logger.info(
    `${label}: skipped ${skipped.length} oversized` +
      ` ${skipped.length === 1 ? 'file' : 'files'}` +
      ` (largest: ${largest.fsPath}, ${formatSize(largest.size)})`
  );
  app.sftpBarItem.updateStatus(StatusBarItem.Status.warn);
}

/**
 * Make a sync's deletions visible after the fact.
 *
 * `sync()` has always returned what it removed and nobody looked at it, so a
 * sync run with `syncConfirm` off deleted files with no trace anywhere. Same
 * reasoning as reportSkipped: a persistent status bar indicator survives the
 * user looking away better than a toast that auto-dismisses.
 */
function reportDeletions(label: string, deleted: FileEntry[]): void {
  if (deleted.length === 0) {
    return;
  }

  deleted.forEach(entry => logger.info(`${label} deleted ${entry.fspath}`));
  logger.info(
    `${label}: deleted ${deleted.length} extraneous ${deleted.length === 1 ? 'entry' : 'entries'}`
  );
  app.sftpBarItem.updateStatus(StatusBarItem.Status.warn);
}

/**
 * Give bulk transfers (folder/project uploads & downloads, sync) a visible,
 * cancellable progress notification instead of only the status bar spinner --
 * those give no count, no ETA, and no way to stop a large batch without
 * digging into the Transfers view. `scheduler` here is only ever stopped,
 * never read from, so any object with that shape works.
 */
async function withTransferProgress<T>(
  title: string,
  scheduler: { stop(): void },
  body: (trackTask: (task: TransferTask) => void) => Promise<T>
): Promise<T> {
  return window.withProgress(
    { location: ProgressLocation.Notification, title, cancellable: true },
    async (progress, cancelToken) => {
      const batchTasks = new Set<TransferTask>();
      let completed = 0;
      let failed = 0;

      const eventSub = onTransferEvent(({ type, task, error }) => {
        if (type !== 'done' || !batchTasks.has(task)) {
          return;
        }
        completed++;
        if (error && !task.isCancelled()) {
          failed++;
        }
        // batchTasks.size keeps growing while the walk is still discovering
        // files, so this is a live count rather than a percentage of a known
        // total -- there's no total until the walk finishes.
        progress.report({
          message:
            failed > 0
              ? `${completed}/${batchTasks.size} files — ${failed} failed`
              : `${completed}/${batchTasks.size} files`,
        });
      });
      const cancelSub = cancelToken.onCancellationRequested(() => scheduler.stop());

      try {
        return await body(task => batchTasks.add(task));
      } finally {
        eventSub.dispose();
        cancelSub.dispose();
      }
    }
  );
}

function createTransferHandle(direction: TransferDirection, progressTitle?: (ctx: FileHandlerContext) => string) {
  return async function handle(this: FileHandlerContext, option) {
    // Stale-remote guard (gated by conflictCheck). Anything but "proceed"
    // leaves the remote untouched.
    if (direction === TransferDirection.LOCAL_TO_REMOTE) {
      const decision = await confirmUpload(this);
      if (decision === 'diff') {
        await diff(this);
        return;
      }
      if (decision === 'cancel') {
        return;
      }
    }

    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const localFs = this.fileService.getLocalFileSystem();
    const { localFsPath, remoteFsPath } = this.target;
    // Claim before any local write begins. This common path covers Download,
    // Edit in Local, download-on-open, and folder downloads.
    const releaseWatcherClaim =
      direction === TransferDirection.REMOTE_TO_LOCAL
        ? claimWatcherSuppression(localFsPath)
        : undefined;
    const scheduler = this.fileService.createTransferScheduler(
      this.config.concurrency,
      this.config.retry,
      this.config.stallTimeout,
      this.config
    );
    // cancelling stops the scan too, not just the tasks already queued
    const skipped: SkippedEntry[] = [];
    const walkOption = {
      walkConcurrency: this.config.concurrency,
      token: { isCancelled: () => scheduler.isStopped() },
      skipped,
    };
    let transferConfig;

    if (direction === TransferDirection.REMOTE_TO_LOCAL) {
      transferConfig = {
        ...walkOption,
        srcFsPath: remoteFsPath,
        srcFs: remoteFs,
        targetFsPath: localFsPath,
        targetFs: localFs,
        transferOption: option,
        transferDirection: TransferDirection.REMOTE_TO_LOCAL,
      };
    } else {
      transferConfig = {
        ...walkOption,
        srcFsPath: localFsPath,
        srcFs: localFs,
        targetFsPath: remoteFsPath,
        targetFs: remoteFs,
        transferOption: option,
        filePerm: this.config.filePerm,
        dirPerm: this.config.dirPerm,
        transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      };
    }
    try {
      if (progressTitle) {
        await withTransferProgress(progressTitle(this), scheduler, async trackTask => {
          await transfer(transferConfig, t => {
            trackTask(t);
            scheduler.add(t);
          });
          await scheduler.run();
        });
      } else {
        await transfer(transferConfig, t => scheduler.add(t));
        await scheduler.run();
      }
    } finally {
      releaseWatcherClaim?.();
    }
    reportSkipped(direction === TransferDirection.LOCAL_TO_REMOTE ? 'Upload' : 'Download', skipped);

    // Both directions leave us with a known-good remote to compare against next
    // time — a download is what establishes the baseline for later uploads.
    await updateBaselineAfterTransfer(this);
  };
}

const uploadHandle = createTransferHandle(TransferDirection.LOCAL_TO_REMOTE);
const downloadHandle = createTransferHandle(TransferDirection.REMOTE_TO_LOCAL);
// Folder/project transfers can run long enough to need visible progress and a
// way to cancel -- single-file transfers finish too fast for that to be
// anything but noise, so only these two variants show a notification.
const uploadFolderHandle = createTransferHandle(
  TransferDirection.LOCAL_TO_REMOTE,
  ctx => `SFTP: uploading ${path.basename(ctx.target.localFsPath)}`
);
const downloadFolderHandle = createTransferHandle(
  TransferDirection.REMOTE_TO_LOCAL,
  ctx => `SFTP: downloading ${path.basename(ctx.target.localFsPath)}`
);

export const sync2Remote = createFileHandler<SyncOption>({
  name: 'sync local ➞ remote',
  async handle(option) {
    // Dry-run preview + confirmation (gated by syncConfirm). Cancelling here
    // leaves everything untouched.
    if (!(await confirmSyncOrProceed(this, TransferDirection.LOCAL_TO_REMOTE, option))) {
      return;
    }
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const localFs = this.fileService.getLocalFileSystem();
    const { localFsPath, remoteFsPath } = this.target;
    const scheduler = this.fileService.createTransferScheduler(
      this.config.concurrency,
      this.config.retry,
      this.config.stallTimeout,
      this.config
    );
    // Attach filePerm and dirPerm to transferOption
    option.filePerm = this.config.filePerm;
    option.dirPerm = this.config.dirPerm;
    const skipped: SkippedEntry[] = [];
    const deleted = await withTransferProgress(
      `SFTP: sync local → remote (${path.basename(localFsPath)})`,
      scheduler,
      async trackTask => {
        const result = await sync(
          {
            srcFsPath: localFsPath,
            srcFs: localFs,
            targetFsPath: remoteFsPath,
            targetFs: remoteFs,
            transferOption: option,
            transferDirection: TransferDirection.LOCAL_TO_REMOTE,
            walkConcurrency: this.config.concurrency,
            token: { isCancelled: () => scheduler.isStopped() },
            skipped,
          },
          t => {
            trackTask(t);
            scheduler.add(t);
          }
        );
        await scheduler.run();
        return result;
      }
    );
    reportDeletions('Sync Local → Remote', deleted);
    reportSkipped('Sync Local → Remote', skipped);
  },
  transformOption() {
    const config = this.config;
    const syncOption = config.syncOption || {};
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.filePerm && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      maxFileSize: config.maxFileSize,
      transferMode: config.transferMode,
      batchConcurrency: config.concurrency,
      delete: syncOption.delete,
      skipCreate: syncOption.skipCreate,
      ignoreExisting: syncOption.ignoreExisting,
      update: syncOption.update,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, true);
  },
});

export const sync2Local = createFileHandler<SyncOption>({
  name: 'sync remote ➞ local',
  async handle(option) {
    // Dry-run preview + confirmation (gated by syncConfirm). Cancelling here
    // leaves everything untouched.
    if (!(await confirmSyncOrProceed(this, TransferDirection.REMOTE_TO_LOCAL, option))) {
      return;
    }
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const localFs = this.fileService.getLocalFileSystem();
    const { localFsPath, remoteFsPath } = this.target;
    // Claim before any local write begins, same as a plain download -- this
    // writes an arbitrary number of local files exactly like a folder
    // download does, and is just as able to echo back through the watcher as
    // a spurious upload/delete without it.
    const releaseWatcherClaim = claimWatcherSuppression(localFsPath);
    const scheduler = this.fileService.createTransferScheduler(
      this.config.concurrency,
      this.config.retry,
      this.config.stallTimeout,
      this.config
    );
    const skipped: SkippedEntry[] = [];
    let deleted: FileEntry[];
    try {
      deleted = await withTransferProgress(
        `SFTP: sync remote → local (${path.basename(localFsPath)})`,
        scheduler,
        async trackTask => {
          const result = await sync(
            {
              srcFsPath: remoteFsPath,
              srcFs: remoteFs,
              targetFsPath: localFsPath,
              targetFs: localFs,
              transferOption: option,
              transferDirection: TransferDirection.REMOTE_TO_LOCAL,
              walkConcurrency: this.config.concurrency,
              token: { isCancelled: () => scheduler.isStopped() },
              skipped,
            },
            t => {
              trackTask(t);
              scheduler.add(t);
            }
          );
          await scheduler.run();
          return result;
        }
      );
    } finally {
      releaseWatcherClaim();
    }
    reportDeletions('Sync Remote → Local', deleted);
    reportSkipped('Sync Remote → Local', skipped);
  },
  transformOption() {
    const config = this.config;
    const syncOption = config.syncOption || {};
    return {
      perserveTargetMode: false,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      maxFileSize: config.maxFileSize,
      transferMode: config.transferMode,
      batchConcurrency: config.concurrency,
      delete: syncOption.delete,
      skipCreate: syncOption.skipCreate,
      ignoreExisting: syncOption.ignoreExisting,
      update: syncOption.update,
    };
  },
});

export const upload = createFileHandler<TransferOption>({
  name: 'upload',
  handle: uploadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.filePerm && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      maxFileSize: config.maxFileSize,
      transferMode: config.transferMode,
      batchConcurrency: config.concurrency,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, this.fileService);
  },
});

export const uploadFile = createFileHandler<TransferOption>({
  name: 'upload file',
  handle: uploadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.filePerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      maxFileSize: config.maxFileSize,
      transferMode: config.transferMode,
      batchConcurrency: config.concurrency,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, false);
  },
});

export const uploadFolder = createFileHandler<TransferOption>({
  name: 'upload folder',
  handle: uploadFolderHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      maxFileSize: config.maxFileSize,
      transferMode: config.transferMode,
      batchConcurrency: config.concurrency,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, true);
  },
});

export const download = createFileHandler<TransferOption>({
  name: 'download',
  handle: downloadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: false,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      maxFileSize: config.maxFileSize,
      transferMode: config.transferMode,
      batchConcurrency: config.concurrency,
    };
  },
});

export const downloadFile = createFileHandler<TransferOption>({
  name: 'download file',
  handle: downloadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: false,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      maxFileSize: config.maxFileSize,
      transferMode: config.transferMode,
      batchConcurrency: config.concurrency,
    };
  },
});

export const downloadFolder = createFileHandler<TransferOption>({
  name: 'download folder',
  handle: downloadFolderHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: false,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      maxFileSize: config.maxFileSize,
      transferMode: config.transferMode,
      batchConcurrency: config.concurrency,
    };
  },
});
