import { window } from 'vscode';
import { FileEntry } from '../../core';
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
 * to check.
 */
function reportSkipped(label: string, skipped: SkippedEntry[]): void {
  if (skipped.length === 0) {
    return;
  }

  skipped.forEach(entry =>
    logger.info(`${label} skipped ${entry.fsPath} (${formatSize(entry.size)}, over maxFileSize)`)
  );
  const largest = skipped.reduce((a, b) => (b.size > a.size ? b : a));
  window.showInformationMessage(
    `SFTP ${label}: skipped ${skipped.length} oversized` +
      ` ${skipped.length === 1 ? 'file' : 'files'}` +
      ` (largest: ${largest.fsPath}, ${formatSize(largest.size)}).` +
      ' See the SFTP output for the full list.'
  );
}

/**
 * Make a sync's deletions visible after the fact.
 *
 * `sync()` has always returned what it removed and nobody looked at it, so a
 * sync run with `syncConfirm` off deleted files with no trace anywhere. The
 * paths go to the output channel and the count to a notification, so a
 * surprising deletion is always answerable.
 */
function reportDeletions(label: string, deleted: FileEntry[]): void {
  if (deleted.length === 0) {
    return;
  }

  deleted.forEach(entry => logger.info(`${label} deleted ${entry.fspath}`));
  window.showInformationMessage(
    `SFTP ${label}: deleted ${deleted.length} extraneous` +
      ` ${deleted.length === 1 ? 'entry' : 'entries'}. See the SFTP output for the full list.`
  );
}

function createTransferHandle(direction: TransferDirection) {
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
      this.config.stallTimeout
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
      await transfer(transferConfig, t => scheduler.add(t));
      await scheduler.run();
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
      this.config.stallTimeout
    );
    // Attach filePerm and dirPerm to transferOption
    option.filePerm = this.config.filePerm;
    option.dirPerm = this.config.dirPerm;
    const skipped: SkippedEntry[] = [];
    const deleted = await sync(
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
      t => scheduler.add(t)
    );
    await scheduler.run();
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
      this.config.stallTimeout
    );
    const skipped: SkippedEntry[] = [];
    let deleted: FileEntry[];
    try {
      deleted = await sync(
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
        t => scheduler.add(t)
      );
      await scheduler.run();
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
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, false);
  },
});

export const uploadFolder = createFileHandler<TransferOption>({
  name: 'upload folder',
  handle: uploadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      maxFileSize: config.maxFileSize,
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
    };
  },
});

export const downloadFolder = createFileHandler<TransferOption>({
  name: 'download folder',
  handle: downloadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: false,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      maxFileSize: config.maxFileSize,
    };
  },
});
