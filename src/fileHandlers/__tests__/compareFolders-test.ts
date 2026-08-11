import upath from '../../core/upath';
import FileSystem, { FileEntry, FileStats, FileType } from '../../core/fs/fileSystem';
import { compareFolders, CompareResult } from '../compareFolders';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Counts how many listings are in flight across *both* filesystems — the walk
 * shares one limiter between them, so that combined number is what the bound
 * applies to.
 */
class Meter {
  active = 0;
  max = 0;

  enter(): void {
    this.active += 1;
    this.max = Math.max(this.max, this.active);
  }

  leave(): void {
    this.active -= 1;
  }
}

/**
 * Minimal in-memory FileSystem exposing just what the compare walk calls, so
 * listing order and concurrency are observable.
 */
class FakeFs extends FileSystem {
  readonly listed: string[] = [];

  constructor(private readonly _meter: Meter, private readonly _slow = true) {
    super(upath);
  }

  private readonly _entries = new Map<string, FileStats>();

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

  async list(dir: string): Promise<FileEntry[]> {
    this.listed.push(dir);
    this._meter.enter();
    try {
      if (this._slow) {
        // yield, so overlapping listings actually overlap
        await tick();
      }
      const entries: FileEntry[] = [];
      this._entries.forEach((stat, fsPath) => {
        if (fsPath !== dir && upath.dirname(fsPath) === dir) {
          entries.push({ ...stat, fspath: fsPath, name: upath.basename(fsPath) });
        }
      });
      return entries;
    } finally {
      this._meter.leave();
    }
  }

  async lstat(fsPath: string): Promise<FileStats> {
    const stat = this._entries.get(fsPath);
    if (!stat) {
      throw Object.assign(new Error(`no such file ${fsPath}`), { code: 'ENOENT' });
    }
    return stat;
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
  mkdir(): never {
    return this._unsupported();
  }
  ensureDir(): never {
    return this._unsupported();
  }
  chmod(): never {
    return this._unsupported();
  }
  unlink(): never {
    return this._unsupported();
  }
  rmdir(): never {
    return this._unsupported();
  }
}

/**
 * A tree deep and wide enough that a sequential walk and a parallel one visit
 * directories in visibly different orders: `width` top-level directories, each
 * with `depth` nested levels holding a file per level. Some files differ
 * between the two sides so every CompareStatus shows up.
 */
function buildTrees(
  meter: Meter,
  { width = 4, depth = 3, slow = true }: { width?: number; depth?: number; slow?: boolean } = {}
) {
  const localFs = new FakeFs(meter, slow).addDir('/local');
  const remoteFs = new FakeFs(meter, slow).addDir('/remote');

  for (let i = 0; i < width; i += 1) {
    let relative = `d${i}`;
    for (let level = 0; level < depth; level += 1) {
      localFs.addDir(`/local/${relative}`);
      remoteFs.addDir(`/remote/${relative}`);

      // same on both sides
      localFs.addFile(`/local/${relative}/same.txt`);
      remoteFs.addFile(`/remote/${relative}/same.txt`);
      // differing size ⇒ modified
      localFs.addFile(`/local/${relative}/mod.txt`, { size: 1 });
      remoteFs.addFile(`/remote/${relative}/mod.txt`, { size: 2 });
      // one side only
      localFs.addFile(`/local/${relative}/localOnly.txt`);
      remoteFs.addFile(`/remote/${relative}/remoteOnly.txt`);

      relative = `${relative}/nested${level}`;
    }
  }

  return { localFs, remoteFs };
}

function contextFor(localFs: FakeFs, remoteFs: FakeFs, concurrency?: number): any {
  return {
    config: { concurrency },
    target: { localFsPath: '/local', remoteFsPath: '/remote' },
    fileService: {
      getLocalFileSystem: () => localFs,
      getRemoteFileSystem: async () => remoteFs,
    },
  };
}

/**
 * The pre-parallel implementation, kept here as the oracle: identical
 * classification, but strictly depth-first and one listing at a time.
 */
async function compareFoldersSequentially(
  localFs: FakeFs,
  remoteFs: FakeFs
): Promise<CompareResult[]> {
  const results: CompareResult[] = [];

  const toHash = (entries: FileEntry[]) =>
    entries.reduce((hash, entry) => {
      hash[entry.name] = entry;
      return hash;
    }, {} as { [name: string]: FileEntry });

  const walk = async (localDir: string, remoteDir: string, relativeDir: string) => {
    const [localEntries, remoteEntries] = await Promise.all([
      localFs.list(localDir).catch(() => [] as FileEntry[]),
      remoteFs.list(remoteDir).catch(() => [] as FileEntry[]),
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
        const modified =
          Math.floor(localEntry.mtime / 1000) !== Math.floor(remoteEntry.mtime / 1000) ||
          localEntry.size !== remoteEntry.size;
        results.push({
          relativePath,
          name,
          type: localEntry.type,
          status: modified ? 'modified' : 'same',
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

    for (const dir of subDirs) {
      await walk(dir.localFsPath, dir.remoteFsPath, dir.relativePath);
    }
  };

  await walk('/local', '/remote', '');
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

describe('compareFolders — bounded concurrency', () => {
  test('never has more listings in flight than config.concurrency', async () => {
    const meter = new Meter();
    const { localFs, remoteFs } = buildTrees(meter, { width: 6, depth: 3 });

    const results = await compareFolders(contextFor(localFs, remoteFs, 2));

    // 1 root + 6 * 3 nested directories, listed on both sides
    expect(localFs.listed).toHaveLength(19);
    expect(remoteFs.listed).toHaveLength(19);
    expect(meter.max).toBeGreaterThan(0);
    expect(meter.max).toBeLessThanOrEqual(2);
    expect(results.length).toBeGreaterThan(0);
  });

  test('defaults to 4 when config.concurrency is unset', async () => {
    const meter = new Meter();
    const { localFs, remoteFs } = buildTrees(meter, { width: 6, depth: 3 });

    await compareFolders(contextFor(localFs, remoteFs, undefined));

    expect(meter.max).toBeLessThanOrEqual(4);
  });

  test('a higher limit does let more listings overlap', async () => {
    const meter = new Meter();
    const { localFs, remoteFs } = buildTrees(meter, { width: 6, depth: 3 });

    await compareFolders(contextFor(localFs, remoteFs, 8));

    expect(meter.max).toBeGreaterThan(2);
    expect(meter.max).toBeLessThanOrEqual(8);
  });
});

describe('compareFolders — parallel result matches sequential', () => {
  test('sorted output is identical to the depth-first implementation', async () => {
    const meter = new Meter();
    const parallel = buildTrees(meter, { width: 4, depth: 3 });
    const sequential = buildTrees(new Meter(), { width: 4, depth: 3, slow: false });

    const parallelResults = await compareFolders(contextFor(parallel.localFs, parallel.remoteFs, 4));
    const sequentialResults = await compareFoldersSequentially(
      sequential.localFs,
      sequential.remoteFs
    );

    expect(parallelResults).toEqual(sequentialResults);
    // the two walks really did visit in different orders — otherwise the
    // assertion above is vacuous
    expect(parallel.localFs.listed).not.toEqual(sequential.localFs.listed);
    // and every status is represented
    expect(new Set(parallelResults.map(r => r.status))).toEqual(
      new Set(['same', 'modified', 'localOnly', 'remoteOnly'])
    );
  });

  test('the same tree compares identically across runs', async () => {
    const first = buildTrees(new Meter(), { width: 4, depth: 3 });
    const second = buildTrees(new Meter(), { width: 4, depth: 3 });

    const a = await compareFolders(contextFor(first.localFs, first.remoteFs, 4));
    const b = await compareFolders(contextFor(second.localFs, second.remoteFs, 3));

    expect(a).toEqual(b);
  });
});

/**
 * A listing failure used to resolve to `[]`, which is indistinguishable from an
 * empty directory — so a directory that could not be read was reported as one
 * whose entries all live on the other side, and the sync preview built on those
 * results presented that as a delete plan.
 */
describe('compareFolders — a failed listing is not an empty directory', () => {
  function treesWithFailure(failing: { local?: string; remote?: string }) {
    const meter = new Meter();
    const localFs = new FakeFs(meter, false)
      .addDir('/local')
      .addDir('/local/bad')
      .addFile('/local/bad/a.txt')
      .addDir('/local/good')
      .addFile('/local/good/only-local.txt');
    const remoteFs = new FakeFs(meter, false)
      .addDir('/remote')
      .addDir('/remote/bad')
      .addFile('/remote/bad/a.txt')
      .addFile('/remote/bad/b.txt')
      .addDir('/remote/good');

    if (failing.local) {
      jest.spyOn(localFs, 'list').mockImplementation(async (dir: string) => {
        if (dir === failing.local) {
          throw new Error('EACCES: permission denied');
        }
        return FakeFs.prototype.list.call(localFs, dir);
      });
    }
    if (failing.remote) {
      jest.spyOn(remoteFs, 'list').mockImplementation(async (dir: string) => {
        if (dir === failing.remote) {
          throw new Error('EMFILE: too many open files');
        }
        return FakeFs.prototype.list.call(remoteFs, dir);
      });
    }

    return { localFs, remoteFs };
  }

  test('an unreadable subtree is reported as errored, not as remote-only', async () => {
    const { localFs, remoteFs } = treesWithFailure({ local: '/local/bad' });

    const results = await compareFolders(contextFor(localFs, remoteFs, 4));

    const bad = results.filter(r => r.relativePath.startsWith('bad'));
    expect(bad).toHaveLength(1);
    expect(bad[0].status).toBe('error');
    expect(bad[0].error).toContain('list /local/bad failed: EACCES: permission denied');
    // nothing inside it was classified at all
    expect(results.some(r => r.relativePath === 'bad/b.txt')).toBe(false);
  });

  test('a failure on the remote side is reported the same way', async () => {
    const { localFs, remoteFs } = treesWithFailure({ remote: '/remote/bad' });

    const results = await compareFolders(contextFor(localFs, remoteFs, 4));

    const bad = results.find(r => r.relativePath === 'bad');
    expect(bad!.status).toBe('error');
    expect(bad!.error).toContain('list /remote/bad failed: EMFILE');
  });

  test('healthy siblings are still compared normally', async () => {
    const { localFs, remoteFs } = treesWithFailure({ local: '/local/bad' });

    const results = await compareFolders(contextFor(localFs, remoteFs, 4));

    expect(results.find(r => r.relativePath === 'good/only-local.txt')!.status).toBe(
      'localOnly'
    );
  });

  test('a failure at the root fails the whole compare rather than reporting nothing', async () => {
    const { localFs, remoteFs } = treesWithFailure({ local: '/local' });

    await expect(compareFolders(contextFor(localFs, remoteFs, 4))).rejects.toThrow(
      'list /local failed: EACCES: permission denied'
    );
  });
});

describe('compareFolders — cancellation', () => {
  test('an already cancelled token does no work at all', async () => {
    const { localFs, remoteFs } = buildTrees(new Meter(), { width: 4, depth: 3 });

    const results = await compareFolders(contextFor(localFs, remoteFs, 4), {
      isCancelled: () => true,
    });

    expect(results).toHaveLength(0);
    expect(localFs.listed).toHaveLength(0);
    expect(remoteFs.listed).toHaveLength(0);
  });

  test('an uncancelled token walks the whole tree', async () => {
    const { localFs, remoteFs } = buildTrees(new Meter(), { width: 4, depth: 3 });

    const results = await compareFolders(contextFor(localFs, remoteFs, 4), {
      isCancelled: () => false,
    });

    expect(localFs.listed).toHaveLength(13);
    expect(results.length).toBeGreaterThan(0);
  });

  test('cancelling mid-walk stops descending further', async () => {
    const meter = new Meter();
    const { localFs, remoteFs } = buildTrees(meter, { width: 4, depth: 4 });
    let cancelled = false;
    // cancel as soon as the root listing has happened
    const originalList = localFs.list.bind(localFs);
    jest.spyOn(localFs, 'list').mockImplementation(async (dir: string) => {
      const entries = await originalList(dir);
      cancelled = true;
      return entries;
    });

    const results = await compareFolders(contextFor(localFs, remoteFs, 4), {
      isCancelled: () => cancelled,
    });

    // only the root was listed; no subtree was descended into
    expect(localFs.listed).toEqual(['/local']);
    // root-level entries are still classified (all four top dirs are dirs, so
    // nothing but directories live at the root)
    expect(results).toHaveLength(0);
  });
});
