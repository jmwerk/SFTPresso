// createFileHandler's `ctx instanceof Uri` check needs a real class so plain
// context objects take the "already a context" branch (see renameRemote-test).
jest.mock('vscode', () => {
  const Nothing: any = (() => {
    function fn() {
      return Nothing;
    }
    fn.toString = fn.toLocaleString = (fn as any)[Symbol.toPrimitive] = () => '';
    (fn as any).valueOf = () => false;
    return new Proxy(fn, {
      get: (o: any, key) => (o.hasOwnProperty(key) ? o[key] : Nothing),
    });
  })();

  class Uri {}

  return new Proxy(Nothing, {
    get: (o, key) => (key === 'Uri' ? Uri : o[key]),
  });
});

jest.mock('../../app', () => ({
  __esModule: true,
  default: { sftpBarItem: { startSpinner() {}, stopSpinner() {} } },
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
}));

jest.mock('../../modules/serviceManager', () => ({
  getFileService: () => undefined,
}));

import { FileType } from '../../core';
import {
  formatMode,
  parseMode,
  setRemotePermissions,
  SetPermissionsResult,
} from '../setPermissions';

// path -> type; children are derived from the paths
type Tree = Record<string, FileType>;

class FakeRemoteFs {
  chmods: string[] = [];
  failChmod = new Set<string>();

  constructor(private readonly tree: Tree) {}

  async lstat(fsPath: string) {
    const type = this.tree[fsPath];
    if (type === undefined) {
      throw Object.assign(new Error(`no such file ${fsPath}`), { code: 'ENOENT' });
    }
    return { type, mode: 0o100644, size: 0, mtime: 0, atime: 0 };
  }

  async list(dir: string) {
    return Object.keys(this.tree)
      .filter(p => p !== dir && p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/'))
      .map(p => ({ fspath: p, name: p.slice(dir.length + 1), type: this.tree[p] }));
  }

  async chmod(fsPath: string, mode: number) {
    if (this.failChmod.has(fsPath)) {
      throw new Error('Permission denied');
    }
    this.chmods.push(`${mode.toString(8)} ${fsPath}`);
  }
}

const tree: Tree = {
  '/www': FileType.Directory,
  '/www/index.php': FileType.File,
  '/www/link': FileType.SymbolicLink,
  '/www/wp': FileType.Directory,
  '/www/wp/a.php': FileType.File,
};

function contextFor(remoteFsPath: string, remoteFs: FakeRemoteFs) {
  return {
    config: { remotePath: '/www' },
    target: { remoteFsPath },
    fileService: { getRemoteFileSystem: async () => remoteFs },
  } as any;
}

describe('parseMode / formatMode', () => {
  test('accepts 3 or 4 octal digits only', () => {
    expect(parseMode('644')).toBe(0o644);
    expect(parseMode(' 2775 ')).toBe(0o2775);
    expect(parseMode('64')).toBeUndefined();
    expect(parseMode('648')).toBeUndefined();
    expect(parseMode('rwxr-xr-x')).toBeUndefined();
  });

  test('drops the file-type bits from a stat mode', () => {
    expect(formatMode(0o100644)).toBe('644');
    expect(formatMode(0o40755)).toBe('755');
    expect(formatMode(0o2775)).toBe('2775');
  });
});

describe('setRemotePermissions', () => {
  test('changes only the target without fileMode', async () => {
    const fs = new FakeRemoteFs(tree);
    await setRemotePermissions(contextFor('/www/wp', fs), { mode: 0o750 });

    expect(fs.chmods).toEqual(['750 /www/wp']);
  });

  test('walks contents children-first, folders and files get their own modes, symlinks skipped', async () => {
    const fs = new FakeRemoteFs(tree);
    const result: SetPermissionsResult = { changed: 0, failed: [], cancelled: false };
    await setRemotePermissions(contextFor('/www', fs), { mode: 0o755, fileMode: 0o644, result });

    expect(fs.chmods).toEqual([
      '644 /www/index.php',
      '644 /www/wp/a.php',
      '755 /www/wp',
      '755 /www',
    ]);
    expect(result.changed).toBe(4);
  });

  test('keeps going past a failed chmod and records it', async () => {
    const fs = new FakeRemoteFs(tree);
    fs.failChmod.add('/www/index.php');
    const result: SetPermissionsResult = { changed: 0, failed: [], cancelled: false };
    await setRemotePermissions(contextFor('/www', fs), { mode: 0o755, fileMode: 0o644, result });

    expect(result.failed.map(f => f.fsPath)).toEqual(['/www/index.php']);
    expect(result.changed).toBe(3);
  });

  test('stops on cancellation without touching the top folder', async () => {
    const fs = new FakeRemoteFs(tree);
    const token = { isCancellationRequested: false };
    const result: SetPermissionsResult = { changed: 0, failed: [], cancelled: false };
    await setRemotePermissions(contextFor('/www', fs), {
      mode: 0o755,
      fileMode: 0o644,
      result,
      token,
      onProgress: () => (token.isCancellationRequested = true),
    });

    expect(fs.chmods).toEqual(['644 /www/index.php']);
    expect(result.cancelled).toBe(true);
  });

  test('refuses a symlink target', async () => {
    const fs = new FakeRemoteFs(tree);
    await expect(
      setRemotePermissions(contextFor('/www/link', fs), { mode: 0o644 })
    ).rejects.toThrow(/symbolic link/);
    expect(fs.chmods).toEqual([]);
  });
});
