import { FileEntry, FileSystem, FileType } from '../core';
import upath from '../core/upath';
import {
  ContentHasher,
  createContentHasher,
  HashCancelledError,
  HashTarget,
} from '../core/contentHash';
import { createLimiter, Limiter } from '../utils';
import logger from '../logger';
import { FileHandlerContext } from './createFileHandler';

function errorMessage(error: any): string {
  return error && error.message ? error.message : String(error);
}

// `error` marks a directory whose listing failed on at least one side, or a
// file whose contents could not be read for a content compare. It is
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
  // the config's ignore/ignoreFile rules; matching entries are never transferred
  // or deleted by a sync, so they are not part of the comparison either
  ignore?: ((fsPath: string) => boolean) | null;
  // set when comparing by content (`compareMode: "content"`)
  hasher?: ContentHasher;
}

export interface CompareOption {
  // Compare file contents instead of size + mtime. Defaults to one built from
  // the config's compareMode; a sync passes the hasher it will reuse, so the
  // preview's hashes are not computed twice.
  hasher?: ContentHasher;
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
  // sizes in bytes; 0 when the side is absent
  localSize: number;
  remoteSize: number;
  // set when the contents were compared and found identical even though size
  // + mtime alone would have called the file modified
  timestampOnly?: boolean;
  // why the entry could not be compared; only set when status is 'error'
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
      localSize: 0,
      remoteSize: 0,
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
  const contentChecks: ContentCheck[] = [];

  for (const name of names) {
    const localEntry = localTable[name];
    const remoteEntry = remoteTable[name];
    const relativePath = relativeDir ? `${relativeDir}/${name}` : name;

    // both paths resolve to the same workspace-relative path, so either one will do
    if (ctx.ignore && ctx.ignore((localEntry || remoteEntry).fspath)) {
      continue;
    }

    if (localEntry && remoteEntry) {
      if (localEntry.type === FileType.Directory && remoteEntry.type === FileType.Directory) {
        subDirs.push({
          relativePath,
          localFsPath: localEntry.fspath,
          remoteFsPath: remoteEntry.fspath,
        });
        continue;
      }

      const result: CompareResult = {
        relativePath,
        name,
        type: localEntry.type,
        status: isFileModified(localEntry, remoteEntry) ? 'modified' : 'same',
        localFsPath: localEntry.fspath,
        remoteFsPath: remoteEntry.fspath,
        localMtime: localEntry.mtime,
        remoteMtime: remoteEntry.mtime,
        localSize: localEntry.size,
        remoteSize: remoteEntry.size,
      };
      results.push(result);

      // Same-size regular files are hashed whatever their mtimes say: equal
      // timestamps do not prove equal contents (FTP's minute-granular times,
      // tools that preserve mtime), and a size difference already settles it.
      if (
        ctx.hasher &&
        localEntry.type === FileType.File &&
        remoteEntry.type === FileType.File &&
        localEntry.size === remoteEntry.size
      ) {
        contentChecks.push({ result, localEntry, remoteEntry });
      }
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
        localSize: localEntry.size,
        remoteSize: 0,
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
        localSize: 0,
        remoteSize: remoteEntry.size,
      });
    }
  }

  // Subtrees are walked concurrently; `limiter` above is what keeps the number
  // of listings in flight bounded. Recursion itself is deliberately not
  // limited — a parent holding a slot while it waits on its children would
  // deadlock.
  //
  // This directory's files are hashed alongside its subtrees, as one batch so
  // a server can hash them all in a single exec.
  await Promise.all([
    ctx.hasher && contentChecks.length > 0
      ? applyContentChecks(ctx.hasher, localFs, remoteFs, contentChecks)
      : undefined,
    ...subDirs.map(dir =>
      walk(ctx, dir.localFsPath, dir.remoteFsPath, dir.relativePath, results)
    ),
  ]);
}

interface ContentCheck {
  result: CompareResult;
  localEntry: HashTarget;
  remoteEntry: HashTarget;
}

async function applyContentChecks(
  hasher: ContentHasher,
  localFs: FileSystem,
  remoteFs: FileSystem,
  checks: ContentCheck[]
): Promise<void> {
  const outcomes = await hasher.contentDiffers(
    checks.map(check => [
      { fs: localFs, entry: check.localEntry },
      { fs: remoteFs, entry: check.remoteEntry },
    ])
  );
  outcomes.forEach((outcome, index) => {
    const { result } = checks[index];
    // a cancelled compare is thrown away by its caller; a cancelled recheck
    // keeps what the size + mtime compare said
    if (outcome instanceof HashCancelledError) {
      return;
    }
    if (outcome instanceof Error) {
      logger.warn(`compare could not hash ${result.relativePath}: ${errorMessage(outcome)}`);
      result.status = 'error';
      result.error = errorMessage(outcome);
    } else if (outcome) {
      result.status = 'modified';
    } else {
      result.timestampOnly = result.status === 'modified';
      result.status = 'same';
    }
  });
}

function isRecheckable(result: CompareResult): boolean {
  return (
    result.status === 'modified' &&
    result.type === FileType.File &&
    result.localSize === result.remoteSize
  );
}

// How many results a size + mtime compare called modified that
// recheckByContent could settle. A size difference is already conclusive.
export function countRecheckable(results: CompareResult[]): number {
  return results.filter(isRecheckable).length;
}

/**
 * Re-check the files a size + mtime compare called modified by reading their
 * contents, updating `results` in place. Lets Compare Folders clear
 * timestamp-only differences without switching the whole config to
 * `compareMode: "content"`.
 */
export async function recheckByContent(
  ctx: FileHandlerContext,
  results: CompareResult[],
  hasher: ContentHasher
): Promise<void> {
  const checks: ContentCheck[] = results.filter(isRecheckable).map(result => ({
    result,
    localEntry: { fspath: result.localFsPath, size: result.localSize, mtime: result.localMtime },
    remoteEntry: { fspath: result.remoteFsPath, size: result.remoteSize, mtime: result.remoteMtime },
  }));
  if (checks.length === 0) {
    return;
  }
  const localFs = ctx.fileService.getLocalFileSystem();
  const remoteFs = await ctx.fileService.getRemoteFileSystem(ctx.config);
  await applyContentChecks(hasher, localFs, remoteFs, checks);
}

export async function compareFolders(
  ctx: FileHandlerContext,
  token?: CompareCancellationToken,
  option: CompareOption = {}
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
    ignore: ctx.config.ignore,
    hasher:
      option.hasher ||
      createContentHasher(ctx.config, {
        isCancelled: token ? () => token.isCancelled() : undefined,
      }),
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
