import { Readable } from 'stream';
import { CancellationTokenSource, CancellationToken } from 'vscode';
import * as fileOperations from './fileBaseOperations';
import { FileSystem, FileType } from './fs';
import { Task } from './scheduler';
import logger from '../logger';

let taskId = 0;

let hasWarnedModifedTimePermission = false;

export enum TransferDirection {
  LOCAL_TO_REMOTE = 'local ➞ remote',
  REMOTE_TO_LOCAL = 'remote ➞ local',
}

interface FileHandle {
  fsPath: string;
  fileSystem: FileSystem;
}

export interface TransferOption {
  atime: number;
  mtime: number;
  mode?: number;
  filePerm?: number;
  dirPerm?: number;
  fallbackMode?: number;
  perserveTargetMode: boolean;
  useTempFile?: boolean;
  openSsh?: boolean;
  // total size of the file in bytes, used to render transfer progress.
  // undefined when unknown (progress then degrades to bytes-only).
  size?: number;
}

// throttle progress reporting to ~2 updates/sec per task
const PROGRESS_REPORT_INTERVAL = 500;

// number of throttled samples kept for the bytesPerSecond rolling window
const PROGRESS_SAMPLE_WINDOW = 5;

interface ProgressSample {
  time: number;
  bytes: number;
}

// network/transport hiccups: the same transfer has a decent chance of working
// on a fresh connection
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTCONN',
]);

// the transfer would fail the same way however many times we run it
const FATAL_ERROR_CODES = new Set(['EACCES', 'ENOENT']);

// SFTP_STATUS_CODE.PERMISSION_DENIED from ssh2
const SFTP_PERMISSION_DENIED = 3;

const RETRYABLE_MESSAGES = [
  /no response from server/i,
  // ssh2 tears the channel down under us when the connection drops
  /channel (?:is )?(?:closed|open failure)/i,
];

const FATAL_MESSAGES = [/permission denied/i, /no such file/i];

// Whether `error` looks transient enough to be worth transferring again.
// Unknown errors are treated as fatal so we don't hammer a server that is
// telling us something we don't understand.
export function isRetryable(error: any): boolean {
  if (!error) {
    return false;
  }

  const code = error.code;
  if (typeof code === 'string') {
    if (FATAL_ERROR_CODES.has(code)) {
      return false;
    }
    if (RETRYABLE_ERROR_CODES.has(code)) {
      return true;
    }
  } else if (typeof code === 'number') {
    if (code === SFTP_PERMISSION_DENIED) {
      return false;
    }
    // FTP reply codes: 4xx is a transient negative reply, 5xx is permanent
    if (code >= 400 && code < 500) {
      return true;
    }
    if (code >= 500 && code < 600) {
      return false;
    }
  }

  const message = typeof error.message === 'string' ? error.message : String(error);
  if (FATAL_MESSAGES.some(pattern => pattern.test(message))) {
    return false;
  }
  return RETRYABLE_MESSAGES.some(pattern => pattern.test(message));
}

export default class TransferTask implements Task {
  readonly id: number;
  readonly fileType: FileType;
  private readonly _srcFsPath: string;
  private readonly _targetFsPath: string;
  private readonly _srcFs: FileSystem;
  private readonly _targetFs: FileSystem;
  private readonly _transferDirection: TransferDirection;
  private readonly _TransferOption: TransferOption;
  private _cancelTokenSource: CancellationTokenSource | undefined;
  private _handle: Readable;
  private _cancelled: boolean;
  // private _fileStatus: FileStatus;

  // how many times this task has been retried after a failure. Owned by the
  // transfer scheduler, which bumps it as it re-queues the task; reset() leaves
  // it alone so the retry budget survives a re-run.
  attempts: number = 0;

  // progress state, read by the Transfers view
  transferredBytes: number = 0;
  readonly totalBytes: number | undefined;
  private _progressListener: (() => void) | undefined;
  private _lastProgressReportAt: number = 0;
  // rolling window of recent (timestamp, transferredBytes) samples, oldest first
  private _progressSamples: ProgressSample[] = [];

  constructor(
    src: FileHandle,
    target: FileHandle,
    option: {
      fileType: FileType;
      transferDirection: TransferDirection;
      transferOption: TransferOption;
    }
  ) {
    this.id = ++taskId;
    this._srcFsPath = src.fsPath;
    this._targetFsPath = target.fsPath;
    this._srcFs = src.fileSystem;
    this._targetFs = target.fileSystem;
    this._TransferOption = option.transferOption;
    this._transferDirection = option.transferDirection;
    this.fileType = option.fileType;
    this.totalBytes = option.transferOption.size;
  }

  // called by the scheduler wiring to receive throttled progress updates
  setProgressListener(listener: () => void) {
    this._progressListener = listener;
  }

  // reset transient state so this task can be re-run (used by Retry)
  reset() {
    this._cancelled = false;
    this._handle = undefined as any;
    this.transferredBytes = 0;
    this._lastProgressReportAt = 0;
    this._progressSamples = [];
    if (this._cancelTokenSource) {
      this._cancelTokenSource.dispose();
    }
    this._cancelTokenSource = undefined;
  }

  private _reportProgress(transferred: number) {
    this.transferredBytes = transferred;
    if (!this._progressListener) {
      return;
    }
    const now = Date.now();
    if (now - this._lastProgressReportAt >= PROGRESS_REPORT_INTERVAL) {
      this._lastProgressReportAt = now;
      this._progressSamples.push({ time: now, bytes: transferred });
      if (this._progressSamples.length > PROGRESS_SAMPLE_WINDOW) {
        this._progressSamples.shift();
      }
      this._progressListener();
    }
  }

  // throughput over the current sample window, or undefined until at least
  // 2 throttled samples have been recorded (~1s into the transfer)
  get bytesPerSecond(): number | undefined {
    if (this._progressSamples.length < 2) {
      return undefined;
    }
    const oldest = this._progressSamples[0];
    const newest = this._progressSamples[this._progressSamples.length - 1];
    const elapsedSeconds = (newest.time - oldest.time) / 1000;
    if (elapsedSeconds <= 0) {
      return undefined;
    }
    return (newest.bytes - oldest.bytes) / elapsedSeconds;
  }

  get localFsPath() {
    if (this._transferDirection === TransferDirection.REMOTE_TO_LOCAL) {
      return this._targetFsPath;
    } else {
      return this._srcFsPath;
    }
  }

  get srcFsPath() {
    return this._srcFsPath;
  }

  get targetFsPath() {
    return this._targetFsPath;
  }

  get transferType() {
    return this._transferDirection;
  }

  get token(): CancellationToken {
    return this._ensureCancelTokenSource().token;
  }

  async run() {
    if (this._cancelled) {
      // cancelled while still queued, never started transferring
      return;
    }

    const src = this._srcFsPath;
    const target = this._targetFsPath;
    const srcFs = this._srcFs;
    const targetFs = this._targetFs;
    switch (this.fileType) {
      case FileType.File:
        await this._transferFile();
        break;
      case FileType.SymbolicLink:
        await fileOperations.transferSymlink(
          src,
          target,
          srcFs,
          targetFs,
          this._TransferOption
        );
        break;
      default:
        logger.warn(`Unsupported file type (type = ${this.fileType}). File ${src}`);
    }
  }

  cancel() {
    if (this._cancelled) {
      return;
    }
    this._cancelled = true;
    if (this._cancelTokenSource) {
      this._cancelTokenSource.cancel();
    }
    if (this._handle) {
      FileSystem.abortReadableStream(this._handle);
    }
  }

  isCancelled(): boolean {
    return this._cancelled;
  }

  dispose() {
    if (this._cancelTokenSource) {
      this._cancelTokenSource.dispose();
    }
  }

  private _ensureCancelTokenSource(): CancellationTokenSource {
    if (!this._cancelTokenSource) {
      this._cancelTokenSource = new CancellationTokenSource();
    }
    return this._cancelTokenSource;
  }

  private async _transferFile() {
    const src = this._srcFsPath;
    const target = this._targetFsPath;
    const srcFs = this._srcFs;
    const targetFs = this._targetFs;
    const {
      perserveTargetMode,
      useTempFile,
      openSsh,
      fallbackMode,
      atime,
      mtime,
      filePerm
    } = this._TransferOption;
    // Set the mode if it's specified in the config, otherwise get mode from server.
    let mode = filePerm ? parseInt(String(filePerm), 8) : this._TransferOption.mode;
    let targetFd; // Destination file
    let uploadFd; // Temp file or destination file when no temp file is used
    const uploadTarget = target + (useTempFile ? ".new" : "");

    // Use mode first.
    // Then check perserveTargetMode and fallback to fallbackMode if fail to get mode of target
    if (mode === undefined && perserveTargetMode) {
      if (useTempFile) {
        [targetFd, uploadFd] = await Promise.all([
          targetFs.open(target, 'r')  // Get handle for reading the target mode
            .catch(() => null), // Return null if target file doesn't exist
          targetFs.open(uploadTarget, 'w')  // Get handle for the file upload
        ]);
      } else {
        targetFd = uploadFd = await targetFs.open(uploadTarget, 'w');
      }

      if (targetFd) {
        [this._handle, mode] = await Promise.all([
          srcFs.get(src),
          targetFs
            .fstat(targetFd)
            .then(stat => stat.mode)
            .catch(() => fallbackMode),
        ]);

        if (useTempFile) {
          targetFs.close(targetFd);
        }

      } else {
        this._handle = await srcFs.get(src);
        mode = fallbackMode;
      }

    } else {
      [this._handle, uploadFd] = await Promise.all([
        srcFs.get(src),
        targetFs.open(uploadTarget, 'w'),
      ]);
    }

    try {
      if (useTempFile) {
        logger.info("uploading temp file: " + uploadTarget);
      }
      await targetFs.put(this._handle, uploadTarget, {
        mode,
        fd: uploadFd,
        autoClose: false,
        onProgress: transferred => this._reportProgress(transferred),
      });
      if (atime && mtime) {
        try {
          await targetFs.futimes(
            uploadFd,
            Math.floor(atime / 1000),
            Math.floor(mtime / 1000)
          );
        } catch (error) {
          if (!hasWarnedModifedTimePermission) {
            hasWarnedModifedTimePermission = true;
            logger.warn(
              `Can't set modified time to the file because ${error.message}`
            );
          }
        }
      }

      if (useTempFile) {
        logger.info("moving from: " + target + ".new" + " to: " + target);
        if(openSsh) {
          await targetFs.renameAtomic(uploadTarget, target);
        } else {
          try {
            await targetFs.unlink(target);
          } catch(error) {
            // Just ignore
          }
          await targetFs.rename(uploadTarget, target);
        }
      }

    } finally {
      await targetFs.close(uploadFd);
    }
  }
}
