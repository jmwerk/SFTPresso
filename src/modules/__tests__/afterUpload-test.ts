jest.mock('../../app', () => {
  const state = new Map<string, any>();
  return {
    __esModule: true,
    default: {
      vscodeContext: {
        workspaceState: {
          get: (key: string) => state.get(key),
          update: (key: string, value: any) => {
            state.set(key, value);
            return Promise.resolve();
          },
        },
      },
      sftpBarItem: { showMsg: jest.fn(), updateStatus: jest.fn() },
    },
    __state: state,
  };
});

jest.mock('../../host', () => ({
  isWorkspaceTrusted: jest.fn(() => true),
  showErrorMessage: jest.fn(() => Promise.resolve(undefined)),
  showWarningMessage: jest.fn(() => Promise.resolve('Run')),
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../ui/output', () => ({ show: jest.fn(), print: jest.fn() }));

jest.mock('../../core/remote-client', () => {
  class SSHClient {
    getRawClient() {
      return 'raw-client';
    }
  }
  return { SSHClient };
});

jest.mock('../../core/remote-client/exec', () => ({
  execCommand: jest.fn(() => Promise.resolve({ code: 0, timedOut: false })),
}));

import {
  resolveAfterUpload,
  buildRemoteCommand,
  reportUploadBatch,
  cancelPendingAfterUpload,
} from '../afterUpload';
import { SSHClient } from '../../core/remote-client';
import { execCommand } from '../../core/remote-client/exec';
import * as host from '../../host';

const execMock = execCommand as jest.Mock;
const warnMock = host.showWarningMessage as jest.Mock;
const trustMock = host.isWorkspaceTrusted as jest.Mock;
const appState: Map<string, any> = jest.requireMock('../../app').__state;

const baseConfig = {
  protocol: 'sftp',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  remotePath: '/www/site',
} as any;

function makeService() {
  return {
    id: 1,
    getRemoteFileSystem: jest.fn(() =>
      Promise.resolve({ getClient: () => new (SSHClient as any)() })
    ),
  } as any;
}

// Runs the debounce timer and every promise the run chains off it.
async function flush() {
  jest.runAllTimers();
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

const ok = { changed: 1, failed: 0, automatic: false };

describe('resolveAfterUpload', () => {
  it('is undefined when unset or empty', () => {
    expect(resolveAfterUpload(baseConfig)).toBeUndefined();
    expect(resolveAfterUpload({ ...baseConfig, afterUpload: '' })).toBeUndefined();
    expect(resolveAfterUpload({ ...baseConfig, afterUpload: { command: [] } })).toBeUndefined();
  });

  it('accepts a string, an array, or an object', () => {
    expect(resolveAfterUpload({ ...baseConfig, afterUpload: 'wp cache flush' })).toEqual({
      commands: ['wp cache flush'],
      onSave: false,
      delay: 1000,
    });
    expect(resolveAfterUpload({ ...baseConfig, afterUpload: ['a', 'b'] })!.commands).toEqual([
      'a',
      'b',
    ]);
    expect(
      resolveAfterUpload({ ...baseConfig, afterUpload: { command: 'a', onSave: true, delay: 0 } })
    ).toEqual({ commands: ['a'], onSave: true, delay: 0 });
  });
});

describe('buildRemoteCommand', () => {
  it('runs in remotePath, quoted', () => {
    expect(buildRemoteCommand("/www/it's", 'wp cache flush')).toBe(
      "cd '/www/it'\\''s' && wp cache flush"
    );
  });
});

describe('reportUploadBatch', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    execMock.mockClear();
    warnMock.mockClear();
    warnMock.mockImplementation(() => Promise.resolve('Run'));
    trustMock.mockImplementation(() => true);
    appState.clear();
  });

  afterEach(() => {
    cancelPendingAfterUpload();
    jest.useRealTimers();
  });

  const config = { ...baseConfig, afterUpload: 'wp cache flush' };

  it('runs the command in remotePath after the batch', async () => {
    reportUploadBatch(makeService(), config, ok);
    await flush();

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0][0]).toBe('raw-client');
    expect(execMock.mock.calls[0][1]).toBe("cd '/www/site' && wp cache flush");
  });

  it('runs once for a burst of uploads', async () => {
    const service = makeService();
    reportUploadBatch(service, config, ok);
    jest.advanceTimersByTime(500);
    reportUploadBatch(service, config, ok);
    reportUploadBatch(service, config, ok);
    await flush();

    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('skips the run when any upload in the burst failed', async () => {
    const service = makeService();
    reportUploadBatch(service, config, { changed: 0, failed: 1, automatic: false });
    reportUploadBatch(service, config, ok);
    await flush();

    expect(execMock).not.toHaveBeenCalled();
    expect(warnMock.mock.calls[0][0]).toMatch(/skipped .*1 upload failed/);
  });

  it('does nothing when the batch changed nothing', async () => {
    reportUploadBatch(makeService(), config, { changed: 0, failed: 0, automatic: false });
    await flush();

    expect(execMock).not.toHaveBeenCalled();
  });

  it('ignores upload on save unless onSave is set', async () => {
    const automatic = { ...ok, automatic: true };
    reportUploadBatch(makeService(), config, automatic);
    await flush();
    expect(execMock).not.toHaveBeenCalled();

    const onSave = { ...baseConfig, afterUpload: { command: 'wp cache flush', onSave: true } };
    reportUploadBatch(makeService(), onSave, automatic);
    await flush();
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('stops at the first failing command', async () => {
    execMock.mockImplementationOnce(() => Promise.resolve({ code: 1, timedOut: false }));
    reportUploadBatch(makeService(), { ...baseConfig, afterUpload: ['a', 'b'] }, ok);
    await flush();

    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('does not run when the prompt is skipped, and asks again next time', async () => {
    warnMock.mockImplementation(() => Promise.resolve('Skip'));
    reportUploadBatch(makeService(), config, ok);
    await flush();
    reportUploadBatch(makeService(), config, ok);
    await flush();

    expect(execMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledTimes(2);
  });

  it('remembers Always Run until the command changes', async () => {
    warnMock.mockImplementation(() => Promise.resolve('Always Run'));
    reportUploadBatch(makeService(), config, ok);
    await flush();
    reportUploadBatch(makeService(), config, ok);
    await flush();

    expect(execMock).toHaveBeenCalledTimes(2);
    expect(warnMock).toHaveBeenCalledTimes(1);

    reportUploadBatch(makeService(), { ...baseConfig, afterUpload: 'rm -rf cache' }, ok);
    await flush();
    expect(warnMock).toHaveBeenCalledTimes(2);
  });

  it('never runs in an untrusted workspace', async () => {
    trustMock.mockImplementation(() => false);
    reportUploadBatch(makeService(), config, ok);
    await flush();

    expect(warnMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it('never runs over FTP', async () => {
    reportUploadBatch(makeService(), { ...config, protocol: 'ftp' }, ok);
    await flush();

    expect(execMock).not.toHaveBeenCalled();
  });
});
