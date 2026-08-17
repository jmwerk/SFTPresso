import {
  FileSystem,
  FileEntry,
  FileType,
  TransferTask,
  TransferOption as TransferTaskTransferOption,
  TransferDirection,
  fileOperations,
} from '../../core';
import { FileHandleOption } from '../option';
import { flatten, createLimiter, Limiter } from '../../utils';
import logger from '../../logger';
import { getOpenTextDocuments } from '../../host';

interface InternalTransferOption extends FileHandleOption, TransferTaskTransferOption {}

type ExternalTransferOption<T extends InternalTransferOption> = Pick<
  T,
  Exclude<keyof T, 'mtime' | 'atime' | 'mode' | 'fallbackMode'>
>;

type TransferOption = ExternalTransferOption<InternalTransferOption>;
interface SyncOption extends TransferOption {
  // delete extraneous files from dest dirs
  delete?: boolean;

  // skip creating new files on dest
  skipCreate?: boolean;

  // skip updating files that exist on dest
  ignoreExisting?: boolean;

  // update the dest only if a newer version is on the src filesystem
  update?: boolean;

  // make newest file to be present in both locations.
  bothDiretions?: boolean;
}

// Consulted while the tree is being walked so that cancelling a transfer stops
// the scan itself, not just the tasks already queued on the scheduler.
export interface TransferCancellationToken {
  isCancelled(): boolean;
}

// A file the walk left out of the transfer because it was over maxFileSize.
export interface SkippedEntry {
  fsPath: string;
  size: number;
}

interface BaseTransferHandleConfig {
  srcFsPath: string;
  targetFsPath: string;
  dirPerm?: number,
  filePerm?: number,
  srcFs: FileSystem;
  targetFs: FileSystem;
  transferDirection: TransferDirection;
  // how many remote operations the walk may have in flight at once
  walkConcurrency?: number;
  token?: TransferCancellationToken;
  // shared by the whole walk; installed by transfer()/sync(), then carried
  // along by the `{ ...config }` spreads below
  limiter?: Limiter;
  // shared by the whole walk, same as `limiter`. Passed in by the caller so it
  // can read the accumulated list back once the walk finishes.
  skipped?: SkippedEntry[];
}

interface TransferHandleConfig<T> extends BaseTransferHandleConfig {
  transferOption: T;
}

// matches `concurrency` in the config defaults; FTP resolves to 1 upstream
const DEFAULT_WALK_CONCURRENCY = 4;

function isCancelled(config: BaseTransferHandleConfig): boolean {
  return Boolean(config.token && config.token.isCancelled());
}

// Every remote call in the walk goes through here so the fan-out stays bounded.
function limited<T>(
  config: BaseTransferHandleConfig,
  fn: () => Promise<T>
): Promise<T> {
  return config.limiter ? config.limiter(fn) : fn();
}

function withLimiter<T extends BaseTransferHandleConfig>(config: T): T {
  return {
    ...config,
    limiter:
      config.limiter ||
      createLimiter(config.walkConcurrency || DEFAULT_WALK_CONCURRENCY),
    skipped: config.skipped || [],
  };
}

// `maxFileSize` is in megabytes; `size` (from the source-side stat/listing
// entry) is in bytes.
function exceedsMaxSize(size: number | undefined, maxFileSize: number | undefined): boolean {
  return !!maxFileSize && typeof size === 'number' && size > maxFileSize * 1024 * 1024;
}

function recordSkipped(config: BaseTransferHandleConfig, fsPath: string, size: number): void {
  if (config.skipped) {
    config.skipped.push({ fsPath, size });
  }
  logger.info(`skip ${fsPath}: ${size} bytes exceeds maxFileSize`);
}

function describeFailure(error: any, action: string, fsPath: string): Error {
  const message = error && error.message ? error.message : String(error);
  const wrapped = new Error(`${action} ${fsPath} failed: ${message}`);
  if (error && error.stack) {
    wrapped.stack = error.stack;
  }
  return wrapped;
}

/**
 * Apply `dirPerm` to a directory we just created.
 *
 * Awaited — it used to be fire-and-forget, so the mode could be applied after
 * the directory's contents had already been written and a rejection surfaced as
 * an unhandled promise rejection. A server that refuses SETSTAT still shouldn't
 * fail the transfer, so failures are logged instead of thrown.
 */
async function applyDirPerm(
  config: TransferHandleConfig<InternalTransferOption>,
  dirPath: string
): Promise<void> {
  const { dirPerm } = config.transferOption;
  if (!dirPerm) {
    return;
  }

  logger.info(`chmod remote directory ${dirPath} as configured by dirPerm: ${dirPerm}`);
  try {
    await limited(config, () =>
      config.targetFs.chmod(dirPath, parseInt(String(dirPerm), 8))
    );
  } catch (error) {
    logger.warn(describeFailure(error, 'chmod', dirPath).message);
  }
}

function getAltDirection(direction: TransferDirection) {
  return direction === TransferDirection.LOCAL_TO_REMOTE
    ? TransferDirection.REMOTE_TO_LOCAL
    : TransferDirection.LOCAL_TO_REMOTE;
}

function isFileModified(a: FileEntry, b: FileEntry): boolean {
  // compare time at seconds
  return Math.floor(a.mtime / 1000) !== Math.floor(b.mtime / 1000) || a.size !== b.size;
}

function toHash<T, R = T>(items: T[], key: string, transform?: (a: T) => R): { [key: string]: R } {
  return items.reduce((hash, item) => {
    const transformedItem = transform ? transform(item) : item;
    hash[transformedItem[key]] = transformedItem;
    return hash;
  }, {});
}

async function transferFolder(
  config: TransferHandleConfig<TransferOption>,
  collect: (t: TransferTask) => void
) {
  const { srcFsPath, targetFsPath, srcFs, targetFs, transferOption } = config;

  if (isCancelled(config)) {
    return;
  }

  if (transferOption.ignore && transferOption.ignore(srcFsPath)) {
    return;
  }

  // Need this to make sure file can correct transfer
  await limited(config, () => targetFs.ensureDir(targetFsPath));

  // If dirPerm is configured, chmod the directory before its contents land in it.
  await applyDirPerm(config as TransferHandleConfig<InternalTransferOption>, targetFsPath);

  const fileEntries = await limited(config, () => srcFs.list(srcFsPath));
  await Promise.all(
    fileEntries.map(file => {
      // Only entries discovered by this walk are capped -- an explicitly
      // requested single-file transfer never goes through transferFolder.
      if (
        (file.type === FileType.File || file.type === FileType.SymbolicLink) &&
        exceedsMaxSize(file.size, transferOption.maxFileSize)
      ) {
        recordSkipped(config, file.fspath, file.size);
        return;
      }

      return transferWithType(
        {
          ...config,
          transferOption: {
            ...config.transferOption,
            mtime: file.mtime,
            atime: file.atime,
            size: file.size,
          },
          srcFsPath: file.fspath,
          targetFsPath: targetFs.pathResolver.join(targetFsPath, file.name),
          ensureDirExist: false,
        },
        file.type,
        collect
      );
    })
  );

  logger.info('folder transfered.');
}

async function transferFile(
  config: TransferHandleConfig<InternalTransferOption>,
  fileType: FileType,
  collect: (t: TransferTask) => void
) {
  if (isCancelled(config)) {
    return;
  }

  if (config.transferOption.ignore && config.transferOption.ignore(config.srcFsPath)) {
    return;
  }

  collect(
    new TransferTask(
      {
        fsPath: config.srcFsPath,
        fileSystem: config.srcFs,
      },
      {
        fsPath: config.targetFsPath,
        fileSystem: config.targetFs,
      },
      {
        fileType,
        transferDirection: config.transferDirection,
        transferOption: config.transferOption,
      }
    )
  );
}

async function transferWithType(
  config: TransferHandleConfig<InternalTransferOption> & {
    ensureDirExist: boolean;
  },
  fileType: FileType,
  collect: (t: TransferTask) => void
) {
  if (isCancelled(config)) {
    return;
  }

  switch (fileType) {
    case FileType.Directory:
      await transferFolder(config, collect);
      break;
    case FileType.File:
    case FileType.SymbolicLink:
      if (config.ensureDirExist) {
        const { targetFs, targetFsPath } = config;
        const parentDir = targetFs.pathResolver.dirname(targetFsPath);
        await limited(config, () => targetFs.ensureDir(parentDir));
        // If dirPerm is configured, we chmod the remote directory after creation.
        await applyDirPerm(config, parentDir);
      }
      // <<< save before upload: start
      if (config.transferDirection === TransferDirection.LOCAL_TO_REMOTE) {
        const textDocuments = getOpenTextDocuments();
        const document = textDocuments.find(doc => doc.fileName === config.srcFsPath);
        if (document && !document.isClosed && document.isDirty) {
          await document.save();
          // Update mtime after file was saved
          const stat = await config.srcFs.lstat(config.srcFsPath);
          config.transferOption.mtime = stat.mtime;
          logger.info('save before upload.');
        }
      }
      // save before upload: end >>>
      transferFile(config, fileType, collect);
      break;
    default:
      logger.warn(`Unsupported file type (type = ${fileType}). File ${config.srcFsPath}`);
  }
}

async function removeFile(file: string, fs: FileSystem, fileType: FileType, option) {
  if (option.ignore && option.ignore(file)) {
    return;
  }

  switch (fileType) {
    case FileType.Directory:
      await fileOperations.removeDir(file, fs, option);
      // named, so a deletion is always traceable after the fact even when the
      // sync preview was skipped
      logger.info(`folder removed: ${file}`);
      break;
    case FileType.File:
    case FileType.SymbolicLink:
      await fileOperations.removeFile(file, fs, option);
      logger.info(`file removed: ${file}`);
      break;
    default:
      break;
  }
}

/**
 * Delete the entries `syncOption.delete` says are extraneous.
 *
 * These used to be fired without awaiting, so they raced the transfers into the
 * same tree and their failures were discarded — a sync could report success
 * while leaving files behind. Files go before directories so a recursive
 * directory removal can't race a removal of something inside it.
 */
async function removeMissing(
  config: TransferHandleConfig<SyncOption>,
  fileMissed: string[],
  dirMissed: string[]
): Promise<void> {
  const { targetFs, transferOption } = config;

  const remove = (fsPath: string, fileType: FileType) =>
    limited(config, () =>
      removeFile(fsPath, targetFs, fileType, transferOption)
    ).catch(error => {
      throw describeFailure(error, 'delete', fsPath);
    });

  await Promise.all(fileMissed.map(file => remove(file, FileType.File)));
  await Promise.all(dirMissed.map(dir => remove(dir, FileType.Directory)));
}

async function _sync(
  config: TransferHandleConfig<SyncOption>,
  collect: (t: TransferTask) => void,
  deleted: FileEntry[]
) {

  const { srcFsPath, targetFsPath, srcFs, targetFs, transferOption, transferDirection } = config;
  if (isCancelled(config)) {
    return;
  }

  if (transferOption.ignore && transferOption.ignore(srcFsPath)) {
    return;
  }

  const altDirection = getAltDirection(transferDirection);
  const syncFiles = (srcFileEntries: FileEntry[], desFileEntries: FileEntry[]) => {
    const srcFileTable = toHash(srcFileEntries, 'id', fileEntry => ({
      ...fileEntry,
      id: fileEntry.name,
    }));

    const desFileTable = toHash(desFileEntries, 'id', fileEntry => ({
      ...fileEntry,
      id: fileEntry.name,
    }));

    const file2trans: [string, string, TransferDirection, InternalTransferOption][] = [];
    const dir2trans: [string, string][] = [];
    const dir2sync: [string, string][] = [];

    const fileMissed: string[] = [];
    const dirMissed: string[] = [];

    Object.keys(srcFileTable).forEach(id => {
      const srcFile = srcFileTable[id];
      const desFile = desFileTable[id];
      delete desFileTable[id];

      // files exist on both side
      if (desFile) {
        if (transferOption.ignoreExisting) {
          return;
        }

        let from: FileEntry = srcFile;
        let to: FileEntry = desFile;
        let direction: TransferDirection = transferDirection;
        switch (from.type) {
          case FileType.Directory:
            dir2sync.push([from.fspath, to.fspath]);
            break;
          case FileType.File:
          case FileType.SymbolicLink:
            if (transferOption.bothDiretions) {
              // from new to old
              if (desFile.mtime > srcFile.mtime) {
                from = desFile;
                to = srcFile;
                direction = altDirection;
              }
            }

            if (transferOption.update) {
              if (from.mtime <= to.mtime) {
                return;
              }
            }

            // only transfer changed files
            if (isFileModified(from, to)) {
              if (exceedsMaxSize(from.size, transferOption.maxFileSize)) {
                recordSkipped(config, from.fspath, from.size);
                return;
              }
              file2trans.push([
                from.fspath,
                to.fspath,
                direction,
                {
                  ...transferOption,
                  mode: to.mode, // prefer target mode
                  mtime: from.mtime,
                  atime: from.atime,
                  size: from.size,
                },
              ]);
            }
            break;
          default:
          // do not process
        }
        return;
      }

      // files exist only on src
      if (transferOption.skipCreate) {
        return;
      }

      const fspath = targetFs.pathResolver.join(targetFsPath, srcFile.name);
      switch (srcFile.type) {
        case FileType.Directory:
          dir2trans.push([srcFile.fspath, fspath]);
          break;
        case FileType.File:
        case FileType.SymbolicLink:
          if (exceedsMaxSize(srcFile.size, transferOption.maxFileSize)) {
            recordSkipped(config, srcFile.fspath, srcFile.size);
            break;
          }
          file2trans.push([
            srcFile.fspath,
            fspath,
            transferDirection,
            {
              ...transferOption,
              fallbackMode: srcFile.mode,
              mtime: srcFile.mtime,
              atime: srcFile.atime,
              size: srcFile.size,
            },
          ]);
          break;
        default:
        // do not process
      }
    });

    // files exist only on target
    if (transferOption.bothDiretions) {
      if (transferOption.skipCreate !== true) {
        Object.keys(desFileTable).forEach(id => {
          const file = desFileTable[id];
          const fspath = srcFs.pathResolver.join(srcFsPath, file.name);
          switch (file.type) {
            case FileType.Directory:
              dir2trans.push([file.fspath, fspath]);
              break;
            case FileType.File:
            case FileType.SymbolicLink:
              if (exceedsMaxSize(file.size, transferOption.maxFileSize)) {
                recordSkipped(config, file.fspath, file.size);
                break;
              }
              file2trans.push([
                file.fspath,
                fspath,
                altDirection,
                {
                  ...transferOption,
                  fallbackMode: file.mode,
                  mtime: file.mtime,
                  atime: file.atime,
                  size: file.size,
                },
              ]);
              break;
            default:
            // do not process
          }
        });
      }
    } else if (transferOption.delete) {
      Object.keys(desFileTable).forEach(id => {
        const file = desFileTable[id];
        deleted.push(file);
        switch (file.type) {
          case FileType.Directory:
            dirMissed.push(file.fspath);
            break;
          case FileType.File:
          case FileType.SymbolicLink:
            fileMissed.push(file.fspath);
            break;
          default:
          // do not process
        }
      });
    }

    // awaited below with everything else, so a failed delete fails the sync
    const removePromise = removeMissing(config, fileMissed, dirMissed);

    const transFilePromise = file2trans.map(([src, target, direction, option]) =>
      transferFile(
        {
          ...config,
          transferDirection: direction,
          transferOption: option,
          srcFsPath: src,
          targetFsPath: target,
        },
        FileType.File,
        collect
      )
    );

    const transDirPromise = dir2trans.map(([src, target]) =>
      transferFolder(
        {
          ...config,
          srcFsPath: src,
          targetFsPath: target,
        },
        collect
      )
    );

    const syncPromise = dir2sync.map(([src, target]) =>
      _sync(
        {
          ...config,
          srcFsPath: src,
          targetFsPath: target,
        },
        collect,
        deleted
      )
    );

    return Promise.all([
      removePromise,
      ...transFilePromise,
      ...transDirPromise,
      ...syncPromise,
    ]).then(flatten);
  };

  // create dir here so we don't have to ensure it for children files.
  await limited(config, () => targetFs.ensureDir(targetFsPath));

  // A failed listing used to resolve to []. With syncOption.delete that made
  // every entry on the other side look extraneous, so one transient error was
  // enough to wipe a directory the user never intended to touch. Deletion may
  // only ever be driven by a listing that actually succeeded, so a failure here
  // is fatal for this subtree.
  const files = await Promise.all([
    limited(config, () => srcFs.list(srcFsPath)).catch(error => {
      throw describeFailure(error, 'list', srcFsPath);
    }),
    limited(config, () => targetFs.list(targetFsPath)).catch(error => {
      throw describeFailure(error, 'list', targetFsPath);
    }),
  ]);
  await syncFiles(...files);
}

export { TransferOption, SyncOption, TransferDirection };

export async function transfer(
  config: TransferHandleConfig<TransferOption>,
  collect: (t: TransferTask) => void
) {
  const walkConfig = withLimiter(config);
  const stat = await limited(walkConfig, () =>
    walkConfig.srcFs.lstat(walkConfig.srcFsPath)
  );
  const transferOption = {
    ...walkConfig.transferOption,
    fallbackMode: stat.mode,
    mtime: stat.mtime,
    atime: stat.atime,
    filePerm: walkConfig?.filePerm,
    dirPerm: walkConfig?.dirPerm,
    size: stat.size,
  };
  await transferWithType(
    { ...walkConfig, transferOption, ensureDirExist: true },
    stat.type,
    collect
  );
}

export async function sync(
  config: TransferHandleConfig<SyncOption>,
  collect: (t: TransferTask) => void
): Promise<FileEntry[]> {
  const deleted: FileEntry[] = [];
  await _sync(withLimiter(config), collect, deleted);
  return deleted;
}
