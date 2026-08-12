// Covers what the watcher decides *before* anything reaches the transfer path:
// which events survive dedup and the ignore rules, and what the watcher table
// holds afterwards.
//
// Every dependency is faked inside its own jest.mock factory rather than closed
// over, so nothing here depends on when the module under test is first required.

jest.mock('vscode', () => {
  const created: any[] = [];
  let onWillRenameHandler: ((e: any) => void) | undefined;
  let onDidRenameHandler: ((e: any) => void) | undefined;

  class FakeWatcher {
    disposeCount = 0;
    createHandlers: Array<(uri: any) => void> = [];
    changeHandlers: Array<(uri: any) => void> = [];
    deleteHandlers: Array<(uri: any) => void> = [];

    constructor(public base: string, public pattern: string) {
      created.push(this);
    }

    onDidCreate(fn) {
      this.createHandlers.push(fn);
    }
    onDidChange(fn) {
      this.changeHandlers.push(fn);
    }
    onDidDelete(fn) {
      this.deleteHandlers.push(fn);
    }
    dispose() {
      this.disposeCount += 1;
    }
  }

  return {
    __created: created,
    // test-only hooks: fire the rename events fileWatcher.ts registered at
    // module load, the same way VSCode would call them.
    __fireWillRename: (files: any[]) => onWillRenameHandler && onWillRenameHandler({ files }),
    __fireDidRename: (files: any[]) => onDidRenameHandler && onDidRenameHandler({ files }),
    workspace: {
      createFileSystemWatcher: (pattern: any) =>
        new FakeWatcher(pattern.base, pattern.pattern),
      onWillRenameFiles: (fn: any) => {
        onWillRenameHandler = fn;
      },
      onDidRenameFiles: (fn: any) => {
        onDidRenameHandler = fn;
      },
    },
    RelativePattern: class {
      constructor(public base: string, public pattern: string) {}
    },
  };
});

jest.mock('../../fileHandlers', () => ({
  upload: jest.fn(() => Promise.resolve()),
  removeRemote: jest.fn(() => Promise.resolve()),
  renameRemote: jest.fn(() => Promise.resolve()),
}));

// the real one drags in ../core and the whole vscode-backed app singleton.
// isLocalPathAtOrUnder is pure (no vscode dependency of its own), so pull the
// real implementation in directly rather than re-fake it -- watcherSuppression
// relies on its actual boundary semantics, not just any stand-in.
jest.mock('../../helper', () => ({
  isValidFile: (uri: any) => uri.scheme === 'file',
  fileDepth: (file: string) => file.split('/').length,
  toRemotePath: (localPath: string, localContext: string, remoteContext: string) =>
    remoteContext + localPath.slice(localContext.length),
  isLocalPathAtOrUnder: jest.requireActual('../../helper/paths').isLocalPathAtOrUnder,
}));

jest.mock('../serviceManager', () => ({
  getRunningTransformTasks: () => [],
  getFileService: jest.fn(),
}));

// only TransferDirection is needed at runtime; the rest of the barrel is types,
// and importing it for real would construct the whole vscode-backed app
jest.mock('../../core', () => ({
  TransferDirection: {
    LOCAL_TO_REMOTE: 'local ➞ remote',
    REMOTE_TO_LOCAL: 'remote ➞ local',
  },
}));

jest.mock('../../app', () => ({
  __esModule: true,
  default: { sftpBarItem: { updateStatus() {} } },
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { info() {}, debug() {}, warn() {}, error() {} },
}));

jest.mock('../../ui/statusBarItem', () => ({
  __esModule: true,
  default: { Status: { error: 'error' } },
}));

import * as vscode from 'vscode';
import { upload, removeRemote, renameRemote } from '../../fileHandlers';
import { getFileService } from '../serviceManager';
import watcherService from '../fileWatcher';

interface FakeWatcher {
  disposeCount: number;
  base: string;
  pattern: string;
  createHandlers: Array<(uri: any) => void>;
  changeHandlers: Array<(uri: any) => void>;
  deleteHandlers: Array<(uri: any) => void>;
}

const createdWatchers: FakeWatcher[] = (vscode as any).__created;
const uploadMock = upload as unknown as jest.Mock;
const removeRemoteMock = removeRemote as unknown as jest.Mock;
const renameRemoteMock = renameRemote as unknown as jest.Mock;
const getFileServiceMock = getFileService as unknown as jest.Mock;

const uri = (fsPath: string) => ({ fsPath, scheme: 'file' });
const fireWillRename = (files: Array<{ oldUri: any; newUri: any }>) =>
  (vscode as any).__fireWillRename(files);
const fireDidRename = (files: Array<{ oldUri: any; newUri: any }>) =>
  (vscode as any).__fireDidRename(files);
// handleRenamedFile is fire-and-forget from fileWatcher's own
// onDidRenameFiles listener, so tests need to let its microtask chain settle
// before asserting on what it did.
const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
};

const watcherConfig = {
  files: '**/*',
  autoUpload: true,
  autoDelete: true,
} as any;

function lastWatcher(): FakeWatcher {
  return createdWatchers[createdWatchers.length - 1];
}

function fireChange(watcher: FakeWatcher, fsPath: string) {
  // vscode hands out a fresh Uri instance per event -- the whole point of
  // keying the queue by fsPath rather than by object identity
  watcher.changeHandlers.forEach(fn => fn(uri(fsPath)));
}

function fireDelete(watcher: FakeWatcher, fsPath: string) {
  watcher.deleteHandlers.forEach(fn => fn(uri(fsPath)));
}

function uploadedPaths(): string[] {
  return uploadMock.mock.calls.map(([u]) => u.fsPath);
}

// The debounce is leading+trailing and its state lives at module scope, so each
// test installs a clock strictly *after* the last one's. Every test then starts
// on a leading edge, which is what makes the call counts below predictable.
let clockBase = 0;

beforeEach(() => {
  clockBase += 60 * 1000;
  jest.useFakeTimers({ now: clockBase });

  createdWatchers.length = 0;
  uploadMock.mockClear();
  removeRemoteMock.mockClear();
  renameRemoteMock.mockReset().mockResolvedValue(undefined);
  getFileServiceMock.mockReset();
});

afterEach(() => {
  watcherService.dispose('/ws');
  jest.useRealTimers();
});

describe('watcher queue', () => {
  test('collapses repeated events for one file', () => {
    watcherService.create('/ws', watcherConfig);
    const watcher = lastWatcher();

    // the first event is taken by the debounce's leading edge; the next three
    // share the trailing flush, and must collapse into one upload there
    fireChange(watcher, '/ws/prime.ts');
    fireChange(watcher, '/ws/a.ts');
    fireChange(watcher, '/ws/a.ts');
    fireChange(watcher, '/ws/a.ts');
    jest.runOnlyPendingTimers();

    expect(uploadedPaths()).toEqual(['/ws/prime.ts', '/ws/a.ts']);
  });

  test('keeps distinct paths, deepest first', () => {
    watcherService.create('/ws', watcherConfig);
    const watcher = lastWatcher();

    fireChange(watcher, '/ws/prime.ts');
    fireChange(watcher, '/ws/a.ts');
    fireChange(watcher, '/ws/deep/nested/b.ts');
    jest.runOnlyPendingTimers();

    expect(uploadedPaths()).toEqual([
      '/ws/prime.ts',
      '/ws/deep/nested/b.ts',
      '/ws/a.ts',
    ]);
  });

  test('deletes are deduped the same way', () => {
    watcherService.create('/ws', watcherConfig);
    const watcher = lastWatcher();

    fireDelete(watcher, '/ws/prime.ts');
    fireDelete(watcher, '/ws/gone.ts');
    fireDelete(watcher, '/ws/gone.ts');
    fireDelete(watcher, '/ws/gone.ts');
    jest.runOnlyPendingTimers();

    expect(removeRemoteMock.mock.calls.map(([u]) => u.fsPath)).toEqual([
      '/ws/prime.ts',
      '/ws/gone.ts',
    ]);
  });
});

describe('watcher ignore rules', () => {
  const ignore = (fsPath: string) => fsPath.endsWith('.log');

  test('an ignored path never reaches the transfer path', () => {
    watcherService.create('/ws', watcherConfig, ignore);
    const watcher = lastWatcher();

    fireChange(watcher, '/ws/debug.log');
    fireChange(watcher, '/ws/a.ts');
    jest.runOnlyPendingTimers();

    expect(uploadedPaths()).toEqual(['/ws/a.ts']);
  });

  test('ignored deletes are dropped too', () => {
    watcherService.create('/ws', watcherConfig, ignore);
    const watcher = lastWatcher();

    fireDelete(watcher, '/ws/debug.log');
    jest.runOnlyPendingTimers();

    expect(removeRemoteMock).not.toHaveBeenCalled();
  });

  test('without an ignore function everything still goes through', () => {
    watcherService.create('/ws', watcherConfig);
    const watcher = lastWatcher();

    fireChange(watcher, '/ws/debug.log');
    jest.runOnlyPendingTimers();

    expect(uploadedPaths()).toEqual(['/ws/debug.log']);
  });

  test('a non-file scheme is still rejected', () => {
    watcherService.create('/ws', watcherConfig);
    const watcher = lastWatcher();

    watcher.changeHandlers.forEach(fn =>
      fn({ fsPath: '/ws/a.ts', scheme: 'sftp' })
    );
    jest.runOnlyPendingTimers();

    expect(uploadMock).not.toHaveBeenCalled();
  });
});

describe('watcher lifecycle', () => {
  test('recreating with watching disabled leaves nothing in the table', () => {
    watcherService.create('/ws', watcherConfig);
    const first = lastWatcher();

    watcherService.create('/ws', { ...watcherConfig, files: false });

    expect(first.disposeCount).toBe(1);
    // nothing new was built...
    expect(lastWatcher()).toBe(first);

    // ...and the disposed one was dropped from the table rather than left there
    // for the next lookup to hand back out. If it were still there, this would
    // find it and dispose it a second time.
    watcherService.dispose('/ws');
    expect(first.disposeCount).toBe(1);
  });

  test('recreating replaces the previous watcher rather than stacking', () => {
    watcherService.create('/ws', watcherConfig);
    const first = lastWatcher();

    watcherService.create('/ws', watcherConfig);
    const second = lastWatcher();

    expect(second).not.toBe(first);
    expect(first.disposeCount).toBe(1);
    expect(second.disposeCount).toBe(0);

    fireChange(second, '/ws/a.ts');
    jest.runOnlyPendingTimers();
    expect(uploadedPaths()).toEqual(['/ws/a.ts']);
  });

  test('autoDelete alone registers no upload listener', () => {
    watcherService.create('/ws', {
      ...watcherConfig,
      autoUpload: false,
    });
    const watcher = lastWatcher();

    expect(watcher.changeHandlers).toHaveLength(0);
    expect(watcher.createHandlers).toHaveLength(0);
    expect(watcher.deleteHandlers).toHaveLength(1);
  });
});

describe('watcher rename (autoRename)', () => {
  function fakeFileService(remotePath: string, baseDir: string, autoRename = true) {
    return {
      baseDir,
      getConfig: () => ({ remotePath, watcher: { ...watcherConfig, autoRename } }),
    };
  }

  test('autoRename on: suppresses the local delete+create and performs a server-side rename', async () => {
    const fs = fakeFileService('/remote', '/ws');
    getFileServiceMock.mockImplementation(() => fs);

    watcherService.create('/ws', watcherConfig);
    const watcher = lastWatcher();

    fireWillRename([{ oldUri: uri('/ws/a.txt'), newUri: uri('/ws/b.txt') }]);

    // the OS-level rename fires these on the per-root watcher; suppression --
    // armed before the disk rename happens -- must drop both.
    fireDelete(watcher, '/ws/a.txt');
    fireChange(watcher, '/ws/b.txt');
    jest.runOnlyPendingTimers();

    expect(uploadedPaths()).toEqual([]);
    expect(removeRemoteMock).not.toHaveBeenCalled();

    fireDidRename([{ oldUri: uri('/ws/a.txt'), newUri: uri('/ws/b.txt') }]);
    await flushMicrotasks();

    expect(renameRemoteMock).toHaveBeenCalledTimes(1);
    const [ctxArg, optionArg] = renameRemoteMock.mock.calls[0];
    expect(ctxArg).toEqual(uri('/ws/a.txt'));
    expect(optionArg).toEqual({ newRemotePath: '/remote/b.txt' });
    // the cheap path succeeded, so the expensive fallback must never run
    expect(uploadMock).not.toHaveBeenCalled();
    expect(removeRemoteMock).not.toHaveBeenCalled();
  });

  test('autoRename off leaves the normal delete+create flow untouched', async () => {
    const fs = fakeFileService('/remote', '/ws', false);
    getFileServiceMock.mockImplementation(() => fs);

    watcherService.create('/ws', watcherConfig);
    const watcher = lastWatcher();

    fireWillRename([{ oldUri: uri('/ws/a.txt'), newUri: uri('/ws/b.txt') }]);
    fireDelete(watcher, '/ws/a.txt');
    fireChange(watcher, '/ws/b.txt');
    jest.runOnlyPendingTimers();

    expect(uploadedPaths()).toEqual(['/ws/b.txt']);
    expect(removeRemoteMock.mock.calls.map(([u]) => u.fsPath)).toEqual(['/ws/a.txt']);

    fireDidRename([{ oldUri: uri('/ws/a.txt'), newUri: uri('/ws/b.txt') }]);
    await flushMicrotasks();

    expect(renameRemoteMock).not.toHaveBeenCalled();
  });

  test('a move that crosses config roots falls back to upload then delete, in that order', async () => {
    const fsA = fakeFileService('/remoteA', '/ws/a');
    const fsB = fakeFileService('/remoteB', '/ws/b');
    getFileServiceMock.mockImplementation((u: any) => (u.fsPath.startsWith('/ws/a') ? fsA : fsB));

    fireWillRename([{ oldUri: uri('/ws/a/file.txt'), newUri: uri('/ws/b/file.txt') }]);
    fireDidRename([{ oldUri: uri('/ws/a/file.txt'), newUri: uri('/ws/b/file.txt') }]);
    await flushMicrotasks();

    expect(renameRemoteMock).not.toHaveBeenCalled();
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock.mock.calls[0][0]).toEqual(uri('/ws/b/file.txt'));
    expect(removeRemoteMock).toHaveBeenCalledTimes(1);
    expect(removeRemoteMock.mock.calls[0][0]).toEqual(uri('/ws/a/file.txt'));
    // upload before delete -- the only remote copy is never removed before
    // its replacement exists
    expect(uploadMock.mock.invocationCallOrder[0]).toBeLessThan(
      removeRemoteMock.mock.invocationCallOrder[0]
    );
  });

  test('a failed server-side rename falls back to upload then delete', async () => {
    const fs = fakeFileService('/remote', '/ws');
    getFileServiceMock.mockImplementation(() => fs);
    renameRemoteMock.mockRejectedValueOnce(new Error('boom'));

    fireWillRename([{ oldUri: uri('/ws/a.txt'), newUri: uri('/ws/b.txt') }]);
    fireDidRename([{ oldUri: uri('/ws/a.txt'), newUri: uri('/ws/b.txt') }]);
    await flushMicrotasks();

    expect(renameRemoteMock).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock.mock.calls[0][0]).toEqual(uri('/ws/b.txt'));
    expect(removeRemoteMock).toHaveBeenCalledTimes(1);
    expect(removeRemoteMock.mock.calls[0][0]).toEqual(uri('/ws/a.txt'));
  });

  test('suppression is released once the rename settles, so later activity uploads normally', async () => {
    const fs = fakeFileService('/remote', '/ws');
    getFileServiceMock.mockImplementation(() => fs);

    watcherService.create('/ws', watcherConfig);
    const watcher = lastWatcher();

    fireWillRename([{ oldUri: uri('/ws/a.txt'), newUri: uri('/ws/b.txt') }]);
    fireDidRename([{ oldUri: uri('/ws/a.txt'), newUri: uri('/ws/b.txt') }]);
    await flushMicrotasks();

    // an unrelated later edit of the renamed file must upload normally --
    // suppression must not still be covering it
    fireChange(watcher, '/ws/b.txt');
    jest.runOnlyPendingTimers();

    expect(uploadedPaths()).toEqual(['/ws/b.txt']);
  });
});
