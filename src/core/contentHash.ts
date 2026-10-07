import { createHash } from 'crypto';
import { Readable } from 'stream';
import { Client } from 'ssh2';
import { FileSystem, LocalFileSystem, RemoteFileSystem } from './fs';
import { SSHClient } from './remote-client';
import { execCommand, ExecResult } from './remote-client/exec';
import { createLimiter, Limiter } from '../utils';
import logger from '../logger';

// What a hash is keyed on. `size` and `mtime` come from the listing, so a file
// that changes between two compares misses the cache instead of returning a
// stale hash.
export interface HashTarget {
  fspath: string;
  size: number;
  mtime: number;
}

export interface HashSide {
  fs: FileSystem;
  entry: HashTarget;
}

export interface HashStats {
  files: number;
  bytes: number;
  // how many of `files` were hashed by the server rather than downloaded
  serverSide: number;
}

// Hashes `paths` on the server and returns one lowercase hex digest per path in
// the same order, or null when the batch could not be hashed there (the
// caller then streams those files instead).
export type ServerHasher = (paths: string[], totalBytes: number) => Promise<string[] | null>;

export interface ContentHasherOption {
  // files hashed at once per filesystem
  concurrency?: number;
  // Hash on the server over an SSH exec channel when it has sha256sum or
  // shasum, so a remote file is read where it lives instead of downloaded.
  // On by default; anything that goes wrong falls back to streaming.
  serverSide?: boolean;
  // test seam: replaces server detection
  resolveServerHasher?: (fs: FileSystem) => ServerHasher | undefined;
  onProgress?: (stats: HashStats) => void;
  isCancelled?: () => boolean;
}

export class HashCancelledError extends Error {
  constructor() {
    super('cancelled');
  }
}

const DEFAULT_CONCURRENCY = 4;

// Server batches stay well under ARG_MAX and the channel's window, and small
// enough that one slow file does not hold up hundreds of others.
const MAX_BATCH_FILES = 128;
const MAX_BATCH_ARG_BYTES = 48 * 1024;

// A batch is given 30s plus time to read its bytes at 25 MB/s before it is
// abandoned for streaming. A server that slow is better streamed anyway.
const BATCH_BASE_TIMEOUT = 30 * 1000;
const BATCH_BYTES_PER_MS = (25 * 1024 * 1024) / 1000;

// Local hashes outlive a single command, keyed on path + size + mtime the way
// git's index is. A file modified within this window of being hashed could
// change again inside the same mtime tick, so it is not cached.
const LOCAL_CACHE_MAX = 20000;
const RACY_WINDOW_MS = 2000;
const localCache = new Map<string, string>();

function cacheKey(entry: HashTarget): string {
  return `${entry.fspath}\0${entry.size}\0${entry.mtime}`;
}

function rememberLocal(key: string, hash: string): void {
  if (localCache.size >= LOCAL_CACHE_MAX) {
    // Map iterates in insertion order, so this drops the oldest entry
    const oldest = localCache.keys().next().value;
    if (oldest !== undefined) {
      localCache.delete(oldest);
    }
  }
  localCache.set(key, hash);
}

// for tests
export function clearLocalHashCache(): void {
  localCache.clear();
}

function hashStream(stream: Readable): Promise<{ hash: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.once('error', error => {
      stream.destroy();
      reject(error);
    });
    stream.once('end', () => resolve({ hash: hash.digest('hex'), bytes }));
  });
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const DIGEST_LINE = /^\\?([0-9a-fA-F]{64})[ \t]/;

// sha256sum and shasum print one `<digest>  <name>` line per file, in argument
// order. GNU sha256sum prefixes the line with a backslash when it had to
// escape the name. Only the digest is read, so names never need unescaping.
export function parseDigests(stdout: string, count: number): string[] | null {
  const lines = stdout.split('\n').filter(line => line.length > 0);
  if (lines.length !== count) {
    return null;
  }
  const digests: string[] = [];
  for (const line of lines) {
    const match = DIGEST_LINE.exec(line);
    if (!match) {
      return null;
    }
    digests.push(match[1].toLowerCase());
  }
  return digests;
}

const SERVER_TOOLS = ['sha256sum', 'shasum -a 256'];

interface ServerState {
  // the tool that worked, once one has; false once none is usable
  tool?: string | false;
}

// One entry per SSH connection, so a server without a hashing tool is probed
// once rather than on every compare.
const serverStates = new WeakMap<Client, ServerState>();

export function sshServerHasher(client: Client): ServerHasher {
  let state = serverStates.get(client);
  if (!state) {
    state = {};
    serverStates.set(client, state);
  }
  const s = state;

  return async (paths, totalBytes) => {
    if (s.tool === false) {
      return null;
    }

    const args = paths.map(shellQuote).join(' ');
    const timeout = BATCH_BASE_TIMEOUT + Math.ceil(totalBytes / BATCH_BYTES_PER_MS);
    const tools = s.tool ? [s.tool] : SERVER_TOOLS;

    for (const tool of tools) {
      let result: ExecResult;
      try {
        result = await execCommand(client, `${tool} -- ${args}`, { timeout, closeStdin: true });
      } catch (error) {
        // exec refused outright: a restricted shell, or no session channels
        logger.info(`server-side hashing unavailable (${error && error.message}); streaming instead`);
        s.tool = false;
        return null;
      }

      if (result.timedOut) {
        logger.info('server-side hashing timed out; streaming instead');
        s.tool = false;
        return null;
      }

      const digests = result.code === 0 ? parseDigests(result.stdout, paths.length) : null;
      if (digests) {
        s.tool = tool;
        return digests;
      }

      // A file in this batch could not be read, but the tool ran. Keep using
      // it; this batch is streamed so the failure is reported per file.
      if (result.code === 1 && DIGEST_LINE.test(result.stdout)) {
        s.tool = tool;
        return null;
      }

      if (s.tool) {
        return null;
      }
    }

    logger.info('no sha256sum or shasum on the server; streaming files to hash them');
    s.tool = false;
    return null;
  };
}

function defaultServerHasher(fs: FileSystem): ServerHasher | undefined {
  if (!(fs instanceof RemoteFileSystem)) {
    return undefined;
  }
  let client;
  try {
    client = fs.getClient();
  } catch {
    return undefined;
  }
  return client instanceof SSHClient ? sshServerHasher(client.getRawClient()) : undefined;
}

interface Pending {
  entry: HashTarget;
  key: string;
  resolve(hash: string): void;
  reject(error: Error): void;
}

/**
 * SHA-256 content comparison for files on any two filesystems.
 *
 * One instance is meant to live for one user action (a compare, or a sync and
 * its preview), so the preview's hashes are reused by the sync that follows.
 * Remote hashes are only cached for that long; local ones are also kept in a
 * process-wide cache.
 */
export class ContentHasher {
  readonly stats: HashStats = { files: 0, bytes: 0, serverSide: 0 };

  private readonly _option: ContentHasherOption;
  private _listener?: (stats: HashStats) => void;
  private _cancelled = false;
  private readonly _limiters = new Map<FileSystem, Limiter>();
  private readonly _hashes = new Map<FileSystem, Map<string, Promise<string>>>();
  private readonly _serverHashers = new Map<FileSystem, ServerHasher | undefined>();

  constructor(option: ContentHasherOption = {}) {
    this._option = option;
    this._listener = option.onProgress;
  }

  // Replaces the progress listener, for a hasher that moves from one progress
  // notification (a sync preview) to another (the sync).
  onProgress(listener: ((stats: HashStats) => void) | undefined): void {
    this._listener = listener;
  }

  // Fails every hash not yet started. In-flight ones run to completion.
  cancel(): void {
    this._cancelled = true;
  }

  /**
   * For each pair, whether the two files' contents differ. A pair that could
   * not be read resolves to the Error instead; one bad file never fails the
   * others. Files of different sizes are reported as different without
   * reading either.
   */
  async contentDiffers(pairs: Array<[HashSide, HashSide]>): Promise<Array<boolean | Error>> {
    const needed = new Map<FileSystem, HashTarget[]>();
    const need = (side: HashSide) => {
      const list = needed.get(side.fs) || [];
      list.push(side.entry);
      needed.set(side.fs, list);
    };

    for (const [a, b] of pairs) {
      if (a.entry.size === b.entry.size) {
        need(a);
        need(b);
      }
    }

    // Each filesystem's files are batched together, so a server hashes a
    // whole directory's worth in one exec.
    needed.forEach((entries, fs) => this._schedule(fs, entries));

    return Promise.all(
      pairs.map(async ([a, b]) => {
        if (a.entry.size !== b.entry.size) {
          return true;
        }
        try {
          const [hashA, hashB] = await Promise.all([this._lookup(a), this._lookup(b)]);
          return hashA !== hashB;
        } catch (error) {
          return error instanceof Error ? error : new Error(String(error));
        }
      })
    );
  }

  private _cacheFor(fs: FileSystem): Map<string, Promise<string>> {
    let cache = this._hashes.get(fs);
    if (!cache) {
      cache = new Map();
      this._hashes.set(fs, cache);
    }
    return cache;
  }

  private _lookup(side: HashSide): Promise<string> {
    const pending = this._cacheFor(side.fs).get(cacheKey(side.entry));
    return pending || Promise.reject(new Error(`${side.entry.fspath} was not scheduled`));
  }

  private _limiter(fs: FileSystem): Limiter {
    let limiter = this._limiters.get(fs);
    if (!limiter) {
      limiter = createLimiter(this._option.concurrency || DEFAULT_CONCURRENCY);
      this._limiters.set(fs, limiter);
    }
    return limiter;
  }

  private _serverHasher(fs: FileSystem): ServerHasher | undefined {
    if (this._option.serverSide === false) {
      return undefined;
    }
    if (!this._serverHashers.has(fs)) {
      const resolve = this._option.resolveServerHasher || defaultServerHasher;
      this._serverHashers.set(fs, resolve(fs));
    }
    return this._serverHashers.get(fs);
  }

  private _isCancelled(): boolean {
    return this._cancelled || Boolean(this._option.isCancelled && this._option.isCancelled());
  }

  private _record(bytes: number, serverSide: boolean): void {
    this.stats.files += 1;
    this.stats.bytes += bytes;
    if (serverSide) {
      this.stats.serverSide += 1;
    }
    if (this._listener) {
      this._listener(this.stats);
    }
  }

  private _schedule(fs: FileSystem, entries: HashTarget[]): void {
    const cache = this._cacheFor(fs);
    const isLocal = fs instanceof LocalFileSystem;
    const pending: Pending[] = [];

    for (const entry of entries) {
      const key = cacheKey(entry);
      if (cache.has(key)) {
        continue;
      }
      const known = isLocal ? localCache.get(key) : undefined;
      if (known) {
        cache.set(key, Promise.resolve(known));
        continue;
      }
      let resolve!: (hash: string) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // A rejection is surfaced through contentDiffers; this only stops an
      // entry nobody awaits from being reported as unhandled.
      promise.catch(() => undefined);
      cache.set(key, promise);
      pending.push({ entry, key, resolve, reject });
    }

    if (pending.length === 0) {
      return;
    }

    const server = this._serverHasher(fs);
    if (server) {
      for (const batch of this._batches(pending)) {
        this._hashOnServer(fs, server, batch, isLocal);
      }
    } else {
      pending.forEach(item => this._stream(fs, item, isLocal));
    }
  }

  private _batches(pending: Pending[]): Pending[][] {
    const batches: Pending[][] = [];
    let current: Pending[] = [];
    let argBytes = 0;
    for (const item of pending) {
      // a newline would split the tool's output line; such a file is streamed
      if (item.entry.fspath.includes('\n')) {
        batches.push([item]);
        continue;
      }
      const size = Buffer.byteLength(item.entry.fspath) + 3;
      if (
        current.length > 0 &&
        (current.length >= MAX_BATCH_FILES || argBytes + size > MAX_BATCH_ARG_BYTES)
      ) {
        batches.push(current);
        current = [];
        argBytes = 0;
      }
      current.push(item);
      argBytes += size;
    }
    if (current.length > 0) {
      batches.push(current);
    }
    return batches;
  }

  private _hashOnServer(fs: FileSystem, server: ServerHasher, batch: Pending[], isLocal: boolean) {
    const streamAll = () => batch.forEach(item => this._stream(fs, item, isLocal));
    if (batch.length === 1 && batch[0].entry.fspath.includes('\n')) {
      streamAll();
      return;
    }

    const totalBytes = batch.reduce((sum, item) => sum + item.entry.size, 0);
    this._limiter(fs)(async () => {
      if (this._isCancelled()) {
        throw new HashCancelledError();
      }
      return server(
        batch.map(item => item.entry.fspath),
        totalBytes
      );
    }).then(
      digests => {
        if (!digests) {
          streamAll();
          return;
        }
        batch.forEach((item, index) => {
          this._record(item.entry.size, true);
          item.resolve(digests[index]);
        });
      },
      error => {
        if (error instanceof HashCancelledError) {
          batch.forEach(item => item.reject(error));
        } else {
          streamAll();
        }
      }
    );
  }

  private _stream(fs: FileSystem, item: Pending, isLocal: boolean): void {
    const hashedAt = Date.now();
    this._limiter(fs)(async () => {
      if (this._isCancelled()) {
        throw new HashCancelledError();
      }
      return hashStream(await fs.get(item.entry.fspath));
    }).then(
      ({ hash, bytes }) => {
        this._record(bytes, false);
        // A byte count that disagrees with the listing means the file changed
        // since it was listed. The hash is still the file's current content,
        // which is what the compare wants, but it does not belong to that key.
        if (isLocal && bytes === item.entry.size && hashedAt - item.entry.mtime > RACY_WINDOW_MS) {
          rememberLocal(item.key, hash);
        }
        item.resolve(hash);
      },
      error => item.reject(error instanceof Error ? error : new Error(String(error)))
    );
  }
}

export type CompareMode = 'mtime' | 'content';

export function createContentHasher(
  config: { compareMode?: CompareMode; concurrency?: number },
  option: ContentHasherOption = {}
): ContentHasher | undefined {
  if (config.compareMode !== 'content') {
    return undefined;
  }
  return new ContentHasher({ concurrency: config.concurrency, ...option });
}
