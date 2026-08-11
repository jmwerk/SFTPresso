import { FileEntry, FileSystem, FileType } from '../core';
import upath from '../core/upath';
import { createLimiter, Limiter } from '../utils';
import logger from '../logger';
import { FileHandlerContext } from './createFileHandler';

function errorMessage(error: any): string {
  return error && error.message ? error.message : String(error);
}

// `error` marks a directory whose listing failed on at least one side. It is
// deliberately its own status rather than an absent entry: a directory we could
// not read is not a directory whose contents are missing, and treating the two
// the same is what let a failed listing be presented as "delete everything".
export type CompareStatus =
  | 'same'
  | 'modified'
  | 'localOnly'
  | 'remoteOnly'
  | 'error';

// Consulted while the tree is being walked so that dismissing the progress
// notification stops the scan. Mirrors TransferCancellationToken in
// transfer/transfer.ts.
export interface CompareCancellationToken {
  isCancelled(): boolean;
}

// matches `concurrency` in the config defaults; FTP resolves to 1 upstream
const DEFAULT_WALK_CONCURRENCY = 4;

interface WalkContext {
  localFs: FileSystem;
  remoteFs: FileSystem;
  // shared by the whole walk, so the fan-out below stays bounded across both
  // filesystems
  limiter: Limiter;
  token?: CompareCancellationToken;
}

export interface CompareResult {
  relativePath: string;
  name: string;
  type: FileType;
  status: CompareStatus;
  localFsPath: string;
  remoteFsPath: string;
  // last-modified times in ms; 0 when the side is absent. Used by the sync
  // preview to honor `syncOption.update` (only overwrite when src is newer).
  localMtime: number;
  remoteMtime: number;
  // why the directory could not be compared; only set when status is 'error'
  error?: string;
}

function isFileModified(a: FileEntry, b: FileEntry): boolean {
  return Math.floor(a.mtime / 1000) !== Math.floor(b.mtime / 1000) || a.size !== b.size;
}

function toHash(entries: FileEntry[]): { [name: string]: FileEntry } {
  return entries.reduce((hash, entry) => {
    hash[entry.name] = entry;
    return hash;
  }, {} as { [name: string]: FileEntry });
}

async function walk(
  ctx: WalkContext,
  localDir: string,
  remoteDir: string,
  relativeDir: string,
  results: CompareResult[]
): Promise<void> {
  if (ctx.token && ctx.token.isCancelled()) {
    return;
  }

  const { localFs, remoteFs, limiter } = ctx;
  // Both listings are allowed to settle before anything is decided. A failure
  // used to become an empty listing, which is indistinguishable from a
  // directory that really is empty -- so the compare reported every entry on
  // the other side as one-sided, and the sync preview built on top of it
  // presented that as a delete plan. A directory we could not read is reported
  // as such and its subtree is left alone.
  const [local, remote] = await Promise.allSettled([
    limiter(() => localFs.list(localDir)),
    limiter(() => remoteFs.list(remoteDir)),
  ]);

  if (local.status === 'rejected' || remote.status === 'rejected') {
    const failures = [
      local.status === 'rejected' ? `list ${localDir} failed: ${errorMessage(local.reason)}` : '',
      remote.status === 'rejected' ? `list ${remoteDir} failed: ${errorMessage(remote.reason)}` : '',
    ].filter(Boolean);
    const message = failures.join('; ');

    // Nothing was compared at all, so there is no partial result worth
    // returning -- fail the whole compare instead of reporting an empty one.
    if (!relativeDir) {
      throw new Error(message);
    }

    logger.warn(`compare skipped ${relativeDir}: ${message}`);
    results.push({
      relativePath: relativeDir,
      name: upath.basename(relativeDir),
      type: FileType.Directory,
      status: 'error',
      localFsPath: localDir,
      remoteFsPath: remoteDir,
      localMtime: 0,
      remoteMtime: 0,
      error: message,
    });
    return;
  }

  const localEntries = local.value;
  const remoteEntries = remote.value;

  const localTable = toHash(localEntries);
  const remoteTable = toHash(remoteEntries);
  const names = new Set([...Object.keys(localTable), ...Object.keys(remoteTable)]);

  const subDirs: Array<{ relativePath: string; localFsPath: string; remoteFsPath: string }> = [];

  for (const name of names) {
    const localEntry = localTable[name];
    const remoteEntry = remoteTable[name];
    const relativePath = relativeDir ? `${relativeDir}/${name}` : name;

    if (localEntry && remoteEntry) {
      if (localEntry.type === FileType.Directory && remoteEntry.type === FileType.Directory) {
        subDirs.push({
          relativePath,
          localFsPath: localEntry.fspath,
          remoteFsPath: remoteEntry.fspath,
        });
        continue;
      }

      results.push({
        relativePath,
        name,
        type: localEntry.type,
        status: isFileModified(localEntry, remoteEntry) ? 'modified' : 'same',
        localFsPath: localEntry.fspath,
        remoteFsPath: remoteEntry.fspath,
        localMtime: localEntry.mtime,
        remoteMtime: remoteEntry.mtime,
      });
    } else if (localEntry) {
      results.push({
        relativePath,
        name,
        type: localEntry.type,
        status: 'localOnly',
        localFsPath: localEntry.fspath,
        remoteFsPath: remoteFs.pathResolver.join(remoteDir, name),
        localMtime: localEntry.mtime,
        remoteMtime: 0,
      });
    } else if (remoteEntry) {
      results.push({
        relativePath,
        name,
        type: remoteEntry.type,
        status: 'remoteOnly',
        localFsPath: localFs.pathResolver.join(localDir, name),
        remoteFsPath: remoteEntry.fspath,
        localMtime: 0,
        remoteMtime: remoteEntry.mtime,
      });
    }
  }

  // Subtrees are walked concurrently; `limiter` above is what keeps the number
  // of listings in flight bounded. Recursion itself is deliberately not
  // limited — a parent holding a slot while it waits on its children would
  // deadlock.
  await Promise.all(
    subDirs.map(dir =>
      walk(ctx, dir.localFsPath, dir.remoteFsPath, dir.relativePath, results)
    )
  );
}

export async function compareFolders(
  ctx: FileHandlerContext,
  token?: CompareCancellationToken
): Promise<CompareResult[]> {
  const remoteFs = await ctx.fileService.getRemoteFileSystem(ctx.config);
  const localFs = ctx.fileService.getLocalFileSystem();
  const { localFsPath, remoteFsPath } = ctx.target;

  const results: CompareResult[] = [];
  const walkCtx: WalkContext = {
    localFs,
    remoteFs,
    limiter: createLimiter(ctx.config.concurrency || DEFAULT_WALK_CONCURRENCY),
    token,
  };
  await walk(walkCtx, localFsPath, remoteFsPath, '', results);
  // `results` now arrives in completion order rather than depth-first order, so
  // this sort is what makes the output deterministic. localeCompare can rank
  // two distinct paths equal (canonically equivalent accents, ignorable
  // characters), which a stable sort would then leave in arrival order — the
  // path tiebreak pins those down too.
  results.sort(
    (a, b) =>
      a.relativePath.localeCompare(b.relativePath) ||
      (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)
  );
  return results;
}
