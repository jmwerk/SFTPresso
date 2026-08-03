import { FileEntry, FileSystem, FileType } from '../core';
import { createLimiter, Limiter } from '../utils';
import { FileHandlerContext } from './createFileHandler';

export type CompareStatus = 'same' | 'modified' | 'localOnly' | 'remoteOnly';

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
  const [localEntries, remoteEntries] = await Promise.all([
    limiter(() => localFs.list(localDir)).catch(() => []),
    limiter(() => remoteFs.list(remoteDir)).catch(() => []),
  ]);

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
