// The default __mocks__/vscode.js stub makes every value satisfy
// `instanceof Uri` (a Proxy `get` trap stands in for Uri[Symbol.hasInstance]
// too, and always returns a truthy Proxy). createFileHandler's `ctx
// instanceof Uri` check needs a real class here so our plain context objects
// correctly take the "already a context" branch instead of being routed
// through handleCtxFromUri. Everything else keeps behaving like the default
// stub -- several real modules pulled in transitively (src/ui/output.ts,
// src/core/fileService.ts, ...) call arbitrary vscode APIs at import time.
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

// renameRemote is built with createFileHandler, which drags in the real
// vscode-backed `app` singleton and the service manager on import. Neither is
// exercised by this handler's own logic (we pass a plain context object,
// bypassing handleCtxFromUri entirely), so both are stubbed out the same way
// src/modules/__tests__/fileWatcher-test.ts does for its own dependencies.
jest.mock('../../app', () => ({
  __esModule: true,
  default: {
    sftpBarItem: { startSpinner() {}, stopSpinner() {} },
    remoteExplorer: { refresh: jest.fn() },
  },
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
}));

jest.mock('../../modules/serviceManager', () => ({
  getFileService: () => undefined,
}));

// afterHandle calls this with our fake target, which has no remoteUri (only
// remoteFsPath) -- the real implementation calls UResource.makeResource on
// it, which needs a full resource shape we have no reason to fake here.
jest.mock('../shared', () => ({
  refreshRemoteExplorer: jest.fn(),
}));

import { renameRemote } from '../renameRemote';

class FakeRemoteFs {
  ensureDirCalls: string[] = [];
  renameCalls: Array<[string, string]> = [];

  constructor(private readonly existing: Set<string>) {}

  async lstat(fsPath: string) {
    if (!this.existing.has(fsPath)) {
      throw Object.assign(new Error(`no such file ${fsPath}`), { code: 'ENOENT' });
    }
    return { type: 'file' };
  }

  async ensureDir(dir: string) {
    this.ensureDirCalls.push(dir);
  }
}

function contextFor(remoteFsPath: string, remotePath: string, existing: string[] = []) {
  const remoteFs = new FakeRemoteFs(new Set(existing));
  const ctx = {
    config: { remotePath },
    target: { remoteFsPath },
    fileService: { getRemoteFileSystem: async () => remoteFs },
  };
  return { ctx, remoteFs };
}

describe('renameRemote', () => {
  test('refuses when the destination already exists, without calling rename', async () => {
    const { ctx, remoteFs } = contextFor('/srv/www/a.txt', '/srv/www', ['/srv/www/b.txt']);

    await expect(
      renameRemote(ctx as any, { newRemotePath: '/srv/www/b.txt' })
    ).rejects.toThrow(/already exists/);

    expect(remoteFs.renameCalls).toHaveLength(0);
  });

  test('refuses a destination outside the configured remotePath', async () => {
    const { ctx, remoteFs } = contextFor('/srv/www/a.txt', '/srv/www');

    await expect(
      renameRemote(ctx as any, { newRemotePath: '/srv/other/a.txt' })
    ).rejects.toThrow(/outside/);

    expect(remoteFs.renameCalls).toHaveLength(0);
  });

  test('creates the destination parent only when it differs from the source parent', async () => {
    const { ctx, remoteFs } = contextFor('/srv/www/a.txt', '/srv/www');
    // fileOperations.rename ultimately calls fs.rename; give the fake one a
    // rename method so the real fileOperations wrapper has something to call.
    (remoteFs as any).rename = async (src: string, dest: string) => {
      remoteFs.renameCalls.push([src, dest]);
    };

    await renameRemote(ctx as any, { newRemotePath: '/srv/www/sub/a.txt' });

    expect(remoteFs.ensureDirCalls).toEqual(['/srv/www/sub']);
    expect(remoteFs.renameCalls).toEqual([['/srv/www/a.txt', '/srv/www/sub/a.txt']]);
  });

  test('does not create a parent directory for a plain rename in place', async () => {
    const { ctx, remoteFs } = contextFor('/srv/www/a.txt', '/srv/www');
    (remoteFs as any).rename = async (src: string, dest: string) => {
      remoteFs.renameCalls.push([src, dest]);
    };

    await renameRemote(ctx as any, { newRemotePath: '/srv/www/b.txt' });

    expect(remoteFs.ensureDirCalls).toEqual([]);
    expect(remoteFs.renameCalls).toEqual([['/srv/www/a.txt', '/srv/www/b.txt']]);
  });
});
