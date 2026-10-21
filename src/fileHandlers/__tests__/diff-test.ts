// Same vscode stub as renameRemote-test.ts: a real Uri class so plain context objects take
// createFileHandler's "already a context" branch, everything else inert.
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

jest.mock('../../modules/serviceManager', () => ({ getFileService: () => undefined }));

const diffFiles = jest.fn(async () => undefined);
jest.mock('../../host', () => ({ diffFiles }));

import { diff } from '../diff';

function fakeFs(existing: string[], error?: Error) {
  return {
    lstat: async (fsPath: string) => {
      if (error) throw error;
      if (!existing.includes(fsPath)) {
        throw Object.assign(new Error(`no such file ${fsPath}`), { code: 2 });
      }
      return {};
    },
  };
}

function contextFor({ local = true, remote = true, remoteError }: { local?: boolean; remote?: boolean; remoteError?: Error } = {}) {
  const target = {
    localFsPath: '/work/site/index.php',
    remoteFsPath: '/www/index.php',
    localUri: { scheme: 'file', path: '/work/site/index.php' },
    remoteUri: { scheme: 'remote', path: '/www/index.php' },
  };
  return {
    target,
    config: {},
    fileService: {
      name: 'Live',
      getLocalFileSystem: () => fakeFs(local ? [target.localFsPath] : []),
      getRemoteFileSystem: async () => fakeFs(remote ? [target.remoteFsPath] : [], remoteError),
    },
  } as any;
}

beforeEach(() => diffFiles.mockClear());

describe('diff', () => {
  test('diffs the live remote file against the local one, remote on the left', async () => {
    const ctx = contextFor();

    await diff(ctx);

    expect(diffFiles).toHaveBeenCalledWith(
      ctx.target.remoteUri,
      ctx.target.localUri,
      'index.php (Live ↔ local)',
      undefined
    );
  });

  test('passes tab options through', async () => {
    await diff(contextFor(), { preview: false, preserveFocus: true });

    expect((diffFiles.mock.calls[0] as any[])[3]).toEqual({ preview: false, preserveFocus: true });
  });

  test('a file missing locally says so instead of opening an empty diff', async () => {
    await expect(diff(contextFor({ local: false }))).rejects.toThrow('has no local copy');
    expect(diffFiles).not.toHaveBeenCalled();
  });

  test('a file missing on the remote says so', async () => {
    await expect(diff(contextFor({ remote: false }))).rejects.toThrow("doesn't exist on the remote");
    expect(diffFiles).not.toHaveBeenCalled();
  });

  test('any other failure is not mistaken for a missing file', async () => {
    const ctx = contextFor({ remoteError: Object.assign(new Error('Permission denied'), { code: 3 }) });

    await expect(diff(ctx)).rejects.toThrow('Permission denied');
  });
});
