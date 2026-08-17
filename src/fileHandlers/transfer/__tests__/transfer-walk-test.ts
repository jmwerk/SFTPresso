import upath from '../../../core/upath';
import FileSystem, {
  FileEntry,
  FileStats,
  FileType,
} from '../../../core/fs/fileSystem';
import TransferTask from '../../../core/transferTask';
import logger from '../../../logger';
import { transfer, sync, TransferDirection } from '../transfer';

type Hook = (fsPath: string) => Promise<void> | void;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Minimal in-memory FileSystem that records the calls the tree walk makes, so
 * ordering, concurrency, and cancellation are observable. Only the operations
 * the walk itself performs are implemented — the collected TransferTasks are
 * never run in these tests.
 */
class FakeFs extends FileSystem {
  readonly calls: string[] = [];
  maxConcurrentList = 0;

  onList?: Hook;
  onChmod?: Hook;
  onUnlink?: Hook;
  onRmdir?: Hook;

  private readonly _entries = new Map<string, FileStats>();
  private _activeList = 0;

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

  has(fsPath: string): boolean {
    return this._entries.has(fsPath);
  }

  callsOf(kind: string): string[] {
    return this.calls.filter(call => call.startsWith(`${kind} `));
  }

  async lstat(fsPath: string): Promise<FileStats> {
    this.calls.push(`lstat ${fsPath}`);
    const stat = this._entries.get(fsPath);
    if (!stat) {
      throw Object.assign(new Error(`no such file ${fsPath}`), { code: 'ENOENT' });
    }
    return stat;
  }

  async list(dir: string): Promise<FileEntry[]> {
    this.calls.push(`list ${dir}`);
    this._activeList += 1;
    this.maxConcurrentList = Math.max(this.maxConcurrentList, this._activeList);
    try {
      if (this.onList) {
        await this.onList(dir);
      }
      const entries: FileEntry[] = [];
      this._entries.forEach((stat, fsPath) => {
        if (fsPath !== dir && upath.dirname(fsPath) === dir) {
          entries.push({ ...stat, fspath: fsPath, name: upath.basename(fsPath) });
        }
      });
      return entries;
    } finally {
      this._activeList -= 1;
    }
  }

  async ensureDir(dir: string): Promise<void> {
    this.calls.push(`ensureDir ${dir}`);
    this.addDir(dir);
  }

  async mkdir(dir: string): Promise<void> {
    return this.ensureDir(dir);
  }

  async chmod(fsPath: string, mode: number): Promise<void> {
    this.calls.push(`chmod ${fsPath} ${mode.toString(8)}`);
    if (this.onChmod) {
      await this.onChmod(fsPath);
    }
  }

  async unlink(fsPath: string): Promise<void> {
    this.calls.push(`unlink ${fsPath}`);
    if (this.onUnlink) {
      await this.onUnlink(fsPath);
    }
    this._entries.delete(fsPath);
  }

  async rmdir(fsPath: string): Promise<void> {
    this.calls.push(`rmdir ${fsPath}`);
    if (this.onRmdir) {
      await this.onRmdir(fsPath);
    }
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

function sourceTree(): FakeFs {
  return new FakeFs()
    .addDir('/local')
    .addFile('/local/a.txt')
    .addDir('/local/sub')
    .addFile('/local/sub/b.txt');
}

function uploadConfig(srcFs: FakeFs, targetFs: FakeFs, extra: any = {}) {
  return {
    srcFsPath: '/local',
    srcFs,
    targetFsPath: '/remote',
    targetFs,
    transferDirection: TransferDirection.LOCAL_TO_REMOTE,
    transferOption: { perserveTargetMode: false },
    ...extra,
  };
}

describe('transfer walk — dirPerm', () => {
  test('chmod resolves before any child is collected', async () => {
    const srcFs = sourceTree();
    const targetFs = new FakeFs();
    const gate = deferred();
    targetFs.onChmod = () => gate.promise;

    const tasks: TransferTask[] = [];
    const running = transfer(
      uploadConfig(srcFs, targetFs, { dirPerm: 755 }),
      t => tasks.push(t)
    );

    await tick();
    // blocked on the directory chmod: nothing listed, nothing collected
    expect(tasks).toHaveLength(0);
    expect(srcFs.callsOf('list')).toHaveLength(0);

    gate.resolve();
    await running;

    expect(targetFs.calls).toContain('chmod /remote 755');
    expect(tasks.map(t => t.targetFsPath).sort()).toEqual([
      '/remote/a.txt',
      '/remote/sub/b.txt',
    ]);
    // every directory got the mode, and always before it was listed
    expect(targetFs.calls.indexOf('chmod /remote/sub 755')).toBeGreaterThan(-1);
    expect(targetFs.calls.indexOf('chmod /remote 755')).toBeLessThan(
      targetFs.calls.indexOf('chmod /remote/sub 755')
    );
  });

  test('a rejecting chmod is logged and does not fail the transfer', async () => {
    const srcFs = sourceTree();
    const targetFs = new FakeFs();
    targetFs.onChmod = () => {
      throw new Error('SETSTAT unsupported');
    };
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const tasks: TransferTask[] = [];
    await expect(
      transfer(uploadConfig(srcFs, targetFs, { dirPerm: 755 }), t => tasks.push(t))
    ).resolves.toBeUndefined();

    expect(tasks).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('chmod /remote failed: SETSTAT unsupported')
    );
    warn.mockRestore();
  });

  test('no chmod is issued when dirPerm is not configured', async () => {
    const srcFs = sourceTree();
    const targetFs = new FakeFs();

    await transfer(uploadConfig(srcFs, targetFs), () => undefined);

    expect(targetFs.callsOf('chmod')).toHaveLength(0);
  });
});

describe('transfer walk — bounded concurrency', () => {
  function wideTree(width: number): FakeFs {
    const fs = new FakeFs().addDir('/local');
    for (let i = 0; i < width; i += 1) {
      fs.addDir(`/local/d${i}`).addFile(`/local/d${i}/f.txt`);
    }
    return fs;
  }

  test('never lists more directories at once than walkConcurrency', async () => {
    const srcFs = wideTree(12);
    srcFs.onList = () => tick() as Promise<void>;
    const targetFs = new FakeFs();

    await transfer(
      uploadConfig(srcFs, targetFs, { walkConcurrency: 2 }),
      () => undefined
    );

    expect(srcFs.callsOf('list')).toHaveLength(13);
    expect(srcFs.maxConcurrentList).toBeLessThanOrEqual(2);
  });

  test('a higher limit does let more listings overlap', async () => {
    const srcFs = wideTree(12);
    srcFs.onList = () => tick() as Promise<void>;
    const targetFs = new FakeFs();

    await transfer(
      uploadConfig(srcFs, targetFs, { walkConcurrency: 8 }),
      () => undefined
    );

    expect(srcFs.maxConcurrentList).toBeGreaterThan(2);
    expect(srcFs.maxConcurrentList).toBeLessThanOrEqual(8);
  });
});

describe('transfer walk — cancellation', () => {
  test('a cancelled token stops the scan and collects nothing further', async () => {
    const srcFs = sourceTree();
    const targetFs = new FakeFs();
    let cancelled = false;
    srcFs.onList = () => {
      // cancel as soon as the root listing happens
      cancelled = true;
    };

    const tasks: TransferTask[] = [];
    await transfer(
      uploadConfig(srcFs, targetFs, {
        token: { isCancelled: () => cancelled },
      }),
      t => tasks.push(t)
    );

    expect(srcFs.callsOf('list')).toEqual(['list /local']);
    expect(tasks).toHaveLength(0);
  });

  test('an already cancelled token does no work at all', async () => {
    const srcFs = sourceTree();
    const targetFs = new FakeFs();

    const tasks: TransferTask[] = [];
    await transfer(
      uploadConfig(srcFs, targetFs, { token: { isCancelled: () => true } }),
      t => tasks.push(t)
    );

    expect(tasks).toHaveLength(0);
    expect(targetFs.callsOf('ensureDir')).toHaveLength(0);
  });
});

describe('transfer walk — maxFileSize', () => {
  function sizedTree(): FakeFs {
    return new FakeFs()
      .addDir('/local')
      .addFile('/local/small.txt', { size: 500 * 1024 })
      .addFile('/local/big.txt', { size: 2 * 1024 * 1024 })
      .addDir('/local/sub')
      .addFile('/local/sub/big2.txt', { size: 5 * 1024 * 1024 });
  }

  test('oversized files are skipped and recorded during a folder walk, others still transfer', async () => {
    const srcFs = sizedTree();
    const targetFs = new FakeFs();
    const skipped: { fsPath: string; size: number }[] = [];

    const tasks: TransferTask[] = [];
    await transfer(
      uploadConfig(srcFs, targetFs, {
        transferOption: { perserveTargetMode: false, maxFileSize: 1 },
        skipped,
      }),
      t => tasks.push(t)
    );

    expect(tasks.map(t => t.targetFsPath).sort()).toEqual(['/remote/small.txt']);
    expect(skipped.map(s => s.fsPath).sort()).toEqual([
      '/local/big.txt',
      '/local/sub/big2.txt',
    ]);
  });

  test('an explicitly-requested single-file transfer is never skipped, however large', async () => {
    const srcFs = new FakeFs().addFile('/local/huge.txt', { size: 10 * 1024 * 1024 });
    const targetFs = new FakeFs();
    const skipped: { fsPath: string; size: number }[] = [];

    const tasks: TransferTask[] = [];
    await transfer(
      {
        srcFsPath: '/local/huge.txt',
        srcFs,
        targetFsPath: '/remote/huge.txt',
        targetFs,
        transferDirection: TransferDirection.LOCAL_TO_REMOTE,
        transferOption: { perserveTargetMode: false, maxFileSize: 1 },
        skipped,
      },
      t => tasks.push(t)
    );

    expect(tasks).toHaveLength(1);
    expect(tasks[0].targetFsPath).toBe('/remote/huge.txt');
    expect(skipped).toHaveLength(0);
  });

  test('0 (or unset) disables the cap', async () => {
    const srcFs = sizedTree();
    const targetFs = new FakeFs();

    const tasks: TransferTask[] = [];
    await transfer(
      uploadConfig(srcFs, targetFs, {
        transferOption: { perserveTargetMode: false, maxFileSize: 0 },
      }),
      t => tasks.push(t)
    );

    expect(tasks.map(t => t.targetFsPath).sort()).toEqual([
      '/remote/big.txt',
      '/remote/small.txt',
      '/remote/sub/big2.txt',
    ]);
  });

  test('sync skips oversized files from the transfer list and records them', async () => {
    const srcFs = sizedTree();
    const targetFs = new FakeFs();
    const skipped: { fsPath: string; size: number }[] = [];

    const tasks: TransferTask[] = [];
    await sync(
      {
        srcFsPath: '/local',
        srcFs,
        targetFsPath: '/remote',
        targetFs,
        transferDirection: TransferDirection.LOCAL_TO_REMOTE,
        transferOption: { perserveTargetMode: false, maxFileSize: 1 },
        skipped,
      },
      t => tasks.push(t)
    );

    expect(tasks.map(t => t.targetFsPath).sort()).toEqual(['/remote/small.txt']);
    expect(skipped.map(s => s.fsPath).sort()).toEqual([
      '/local/big.txt',
      '/local/sub/big2.txt',
    ]);
  });
});

describe('sync --delete removals', () => {
  function syncFixture() {
    const srcFs = new FakeFs().addDir('/local').addFile('/local/keep.txt');
    const targetFs = new FakeFs()
      .addDir('/remote')
      // identical mtime/size, so no transfer is queued for it
      .addFile('/remote/keep.txt')
      .addFile('/remote/stale.txt')
      .addDir('/remote/staledir')
      .addFile('/remote/staledir/x.txt');
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

  test('sync does not resolve until the removals have settled', async () => {
    const { srcFs, targetFs } = syncFixture();
    const gate = deferred();
    targetFs.onUnlink = () => gate.promise;

    let settled = false;
    const running = sync(syncConfig(srcFs, targetFs), () => undefined).then(
      result => {
        settled = true;
        return result;
      }
    );

    await tick();
    expect(settled).toBe(false);
    expect(targetFs.calls).toContain('unlink /remote/stale.txt');

    gate.resolve();
    const deleted = await running;

    expect(settled).toBe(true);
    expect(deleted.map(entry => entry.fspath).sort()).toEqual([
      '/remote/stale.txt',
      '/remote/staledir',
    ]);
    expect(targetFs.has('/remote/stale.txt')).toBe(false);
    expect(targetFs.has('/remote/staledir')).toBe(false);
  });

  test('a failing removal rejects the sync with the path in the message', async () => {
    const { srcFs, targetFs } = syncFixture();
    targetFs.onUnlink = () => {
      throw new Error('EPERM');
    };

    await expect(sync(syncConfig(srcFs, targetFs), () => undefined)).rejects.toThrow(
      'delete /remote/stale.txt failed: EPERM'
    );
  });

  test('files are removed before directories', async () => {
    const { srcFs, targetFs } = syncFixture();

    await sync(syncConfig(srcFs, targetFs), () => undefined);

    const unlinkAt = targetFs.calls.indexOf('unlink /remote/stale.txt');
    const rmdirAt = targetFs.calls.indexOf('rmdir /remote/staledir');
    expect(unlinkAt).toBeGreaterThan(-1);
    expect(rmdirAt).toBeGreaterThan(-1);
    expect(unlinkAt).toBeLessThan(rmdirAt);
  });

  test('nothing is removed without syncOption.delete', async () => {
    const { srcFs, targetFs } = syncFixture();

    const deleted = await sync(
      syncConfig(srcFs, targetFs, {
        transferOption: { perserveTargetMode: false },
      }),
      () => undefined
    );

    expect(deleted).toHaveLength(0);
    expect(targetFs.callsOf('unlink')).toHaveLength(0);
    expect(targetFs.callsOf('rmdir')).toHaveLength(0);
  });
});
