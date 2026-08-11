import upath from '../../../core/upath';
import FileSystem, {
  FileEntry,
  FileStats,
  FileType,
} from '../../../core/fs/fileSystem';
import { sync, TransferDirection } from '../transfer';

/**
 * The failure this file exists for: `_sync` used to turn a failed listing into
 * an empty one (`.catch(err => [])`). With `syncOption.delete` every entry on
 * the other side was then absent from the source table, so a single transient
 * SFTP error, an EACCES, or an EMFILE under concurrency deleted the whole
 * directory — silently, unlogged, and uncounted.
 *
 * Deletion may only ever be driven by a listing that actually succeeded, so a
 * listing failure has to be fatal for that subtree.
 */

class FakeFs extends FileSystem {
  readonly calls: string[] = [];

  // directories whose list() rejects, keyed by path
  readonly listFailures = new Map<string, Error>();

  private readonly _entries = new Map<string, FileStats>();

  constructor() {
    super(upath);
  }

  addDir(dir: string): this {
    this._entries.set(dir, {
      type: FileType.Directory,
      mode: 0o755,
      size: 0,
      mtime: 1000,
      atime: 1000,
    });
    return this;
  }

  addFile(fsPath: string, { size = 1, mtime = 1000 } = {}): this {
    this._entries.set(fsPath, {
      type: FileType.File,
      mode: 0o644,
      size,
      mtime,
      atime: mtime,
    });
    return this;
  }

  failListing(dir: string, error: Error): this {
    this.listFailures.set(dir, error);
    return this;
  }

  has(fsPath: string): boolean {
    return this._entries.has(fsPath);
  }

  callsOf(kind: string): string[] {
    return this.calls.filter(call => call.startsWith(`${kind} `));
  }

  async lstat(fsPath: string): Promise<FileStats> {
    const stat = this._entries.get(fsPath);
    if (!stat) {
      throw Object.assign(new Error(`no such file ${fsPath}`), { code: 'ENOENT' });
    }
    return stat;
  }

  async list(dir: string): Promise<FileEntry[]> {
    this.calls.push(`list ${dir}`);
    const failure = this.listFailures.get(dir);
    if (failure) {
      throw failure;
    }

    const entries: FileEntry[] = [];
    this._entries.forEach((stat, fsPath) => {
      if (fsPath !== dir && upath.dirname(fsPath) === dir) {
        entries.push({ ...stat, fspath: fsPath, name: upath.basename(fsPath) });
      }
    });
    return entries;
  }

  async ensureDir(dir: string): Promise<void> {
    this.calls.push(`ensureDir ${dir}`);
    this.addDir(dir);
  }

  async mkdir(dir: string): Promise<void> {
    return this.ensureDir(dir);
  }

  async chmod(): Promise<void> {
    /* not exercised here */
  }

  async unlink(fsPath: string): Promise<void> {
    this.calls.push(`unlink ${fsPath}`);
    this._entries.delete(fsPath);
  }

  async rmdir(fsPath: string): Promise<void> {
    this.calls.push(`rmdir ${fsPath}`);
    Array.from(this._entries.keys())
      .filter(key => key === fsPath || key.startsWith(`${fsPath}/`))
      .forEach(key => this._entries.delete(key));
  }

  private _unsupported(): never {
    throw new Error('not implemented in FakeFs');
  }

  readFile(): never {
    return this._unsupported();
  }
  open(): never {
    return this._unsupported();
  }
  close(): never {
    return this._unsupported();
  }
  fstat(): never {
    return this._unsupported();
  }
  futimes(): never {
    return this._unsupported();
  }
  get(): never {
    return this._unsupported();
  }
  put(): never {
    return this._unsupported();
  }
  readlink(): never {
    return this._unsupported();
  }
  symlink(): never {
    return this._unsupported();
  }
  rename(): never {
    return this._unsupported();
  }
  renameAtomic(): never {
    return this._unsupported();
  }
}

/**
 * Two sibling subtrees under the sync root. `bad` is where a listing is made to
 * fail; `good` is the control that must still be synced normally.
 */
function trees() {
  const srcFs = new FakeFs()
    .addDir('/local')
    .addDir('/local/bad')
    .addFile('/local/bad/kept.txt')
    .addDir('/local/good')
    .addFile('/local/good/kept.txt');

  const targetFs = new FakeFs()
    .addDir('/remote')
    .addDir('/remote/bad')
    // identical mtime/size, so nothing is queued for transfer
    .addFile('/remote/bad/kept.txt')
    .addFile('/remote/bad/extraneous.txt')
    .addDir('/remote/bad/extraneousDir')
    .addDir('/remote/good')
    .addFile('/remote/good/kept.txt')
    .addFile('/remote/good/extraneous.txt');

  return { srcFs, targetFs };
}

function syncConfig(srcFs: FakeFs, targetFs: FakeFs, extra: any = {}) {
  return {
    srcFsPath: '/local',
    srcFs,
    targetFsPath: '/remote',
    targetFs,
    transferDirection: TransferDirection.LOCAL_TO_REMOTE,
    transferOption: { perserveTargetMode: false, delete: true },
    ...extra,
  };
}

describe('sync — a failed source listing never becomes a deletion', () => {
  test('a rejecting source listing rejects the sync, naming path and operation', async () => {
    const { srcFs, targetFs } = trees();
    srcFs.failListing('/local/bad', new Error('EACCES: permission denied'));

    await expect(sync(syncConfig(srcFs, targetFs), () => undefined)).rejects.toThrow(
      'list /local/bad failed: EACCES: permission denied'
    );
  });

  test('nothing under the unreadable subtree is removed', async () => {
    const { srcFs, targetFs } = trees();
    srcFs.failListing('/local/bad', new Error('EACCES'));

    await expect(sync(syncConfig(srcFs, targetFs), () => undefined)).rejects.toThrow();

    // the entries that used to be wiped are all still there
    expect(targetFs.has('/remote/bad/extraneous.txt')).toBe(true);
    expect(targetFs.has('/remote/bad/extraneousDir')).toBe(true);
    expect(targetFs.has('/remote/bad/kept.txt')).toBe(true);
    expect(targetFs.callsOf('unlink')).not.toContain('unlink /remote/bad/extraneous.txt');
    expect(targetFs.callsOf('rmdir')).not.toContain('rmdir /remote/bad/extraneousDir');
  });

  test('a failing target listing is fatal too, rather than deleting nothing quietly', async () => {
    const { srcFs, targetFs } = trees();
    targetFs.failListing('/remote/bad', new Error('EMFILE'));

    await expect(sync(syncConfig(srcFs, targetFs), () => undefined)).rejects.toThrow(
      'list /remote/bad failed: EMFILE'
    );
  });

  test('a healthy sibling subtree is still synced', async () => {
    const { srcFs, targetFs } = trees();
    srcFs.failListing('/local/bad', new Error('EACCES'));

    await expect(sync(syncConfig(srcFs, targetFs), () => undefined)).rejects.toThrow();

    // Both siblings are walked concurrently, so the healthy one completes its
    // own removals before the rejection propagates.
    expect(targetFs.calls).toContain('unlink /remote/good/extraneous.txt');
    expect(targetFs.has('/remote/good/kept.txt')).toBe(true);
  });

  test('without a failure the same tree syncs and deletes as before', async () => {
    const { srcFs, targetFs } = trees();

    const deleted = await sync(syncConfig(srcFs, targetFs), () => undefined);

    expect(deleted.map(entry => entry.fspath).sort()).toEqual([
      '/remote/bad/extraneous.txt',
      '/remote/bad/extraneousDir',
      '/remote/good/extraneous.txt',
    ]);
  });

  test('a listing failure is fatal even without delete, instead of silently skipping', async () => {
    const { srcFs, targetFs } = trees();
    srcFs.failListing('/local/bad', new Error('ECONNRESET'));

    await expect(
      sync(
        syncConfig(srcFs, targetFs, {
          transferOption: { perserveTargetMode: false },
        }),
        () => undefined
      )
    ).rejects.toThrow('list /local/bad failed: ECONNRESET');
  });
});
