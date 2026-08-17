// Same vscode stub renameRemote-test.ts uses -- `createFileHandler`'s
// `ctx instanceof Uri` check needs a real class here so our plain context
// object correctly takes the "already a context" branch, while everything
// else keeps behaving like a harmless no-op stand-in for the real vscode API.
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

jest.mock('../../../app', () => ({
  __esModule: true,
  default: {
    sftpBarItem: { startSpinner() {}, stopSpinner() {} },
  },
}));

jest.mock('../../../logger', () => ({
  __esModule: true,
  default: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
}));

jest.mock('../../../modules/serviceManager', () => ({
  getFileService: () => undefined,
}));

jest.mock('../../shared', () => ({
  refreshRemoteExplorer: jest.fn(),
}));

jest.mock('../../syncPreview', () => ({
  confirmSyncOrProceed: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../../diff', () => ({
  diff: jest.fn(),
}));

jest.mock('../conflictCheck', () => ({
  confirmUpload: jest.fn(() => Promise.resolve('proceed')),
  updateBaselineAfterTransfer: jest.fn(() => Promise.resolve()),
}));

const syncMock = jest.fn();
jest.mock('../transfer', () => ({
  ...jest.requireActual('../transfer'),
  transfer: jest.fn(),
  sync: (...args: any[]) => syncMock(...args),
}));

const claimWatcherSuppressionMock = jest.fn();
jest.mock('../../../modules/watcherSuppression', () => ({
  claimWatcherSuppression: (...args: any[]) => claimWatcherSuppressionMock(...args),
}));

import { sync2Local } from '../index';

function contextFor(remotePath: string, localPath: string) {
  return {
    config: { remotePath, concurrency: 4, retry: undefined, stallTimeout: 0 },
    target: { remoteFsPath: remotePath, localFsPath: localPath },
    fileService: {
      getRemoteFileSystem: async () => ({}),
      getLocalFileSystem: () => ({}),
      createTransferScheduler: () => ({
        add: () => undefined,
        run: () => Promise.resolve(),
        stop: () => undefined,
        isStopped: () => false,
      }),
    },
  } as any;
}

beforeEach(() => {
  claimWatcherSuppressionMock.mockReset();
  syncMock.mockReset();
});

describe('sync2Local watcher suppression', () => {
  test('claims suppression for the local path before syncing and releases it afterward', async () => {
    const release = jest.fn();
    claimWatcherSuppressionMock.mockReturnValue(release);
    syncMock.mockResolvedValue([]);

    const ctx = contextFor('/srv/www', '/ws');
    await sync2Local(ctx, {} as any);

    expect(claimWatcherSuppressionMock).toHaveBeenCalledWith('/ws');
    expect(release).toHaveBeenCalledTimes(1);
    // claimed before the sync ran, released only after
    expect(claimWatcherSuppressionMock.mock.invocationCallOrder[0]).toBeLessThan(
      syncMock.mock.invocationCallOrder[0]
    );
    expect(syncMock.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]);
  });

  test('still releases the claim when sync() throws', async () => {
    const release = jest.fn();
    claimWatcherSuppressionMock.mockReturnValue(release);
    syncMock.mockRejectedValue(new Error('connection dropped'));

    const ctx = contextFor('/srv/www', '/ws');
    await expect(sync2Local(ctx, {} as any)).rejects.toThrow('connection dropped');

    expect(release).toHaveBeenCalledTimes(1);
  });
});
