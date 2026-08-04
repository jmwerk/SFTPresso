jest.mock('fs');

import TransferTask, { TransferDirection, isRetryable } from '../transferTask';
import { FileType } from '../fs/fileSystem';

// Drives a transfer by hand: `put` reports progress whenever the test says so
// and otherwise never settles, which is exactly what a connection the server
// dropped without telling us looks like from in here.
function createTask(stallTimeout: number) {
  let reportProgress: ((bytes: number) => void) | undefined;
  let finishPut: (() => void) | undefined;
  let aborted = false;

  const srcStream: any = {
    destroy() {
      aborted = true;
    },
    // abortReadableStream emits 'error' before destroying
    emit() {
      return true;
    },
    on() {
      return srcStream;
    },
    removeListener() {
      return srcStream;
    },
    pipe() {
      return srcStream;
    },
    unpipe() {
      return srcStream;
    },
  };

  const srcFs: any = {
    get: async () => srcStream,
  };

  const targetFs: any = {
    open: async () => 1,
    close: async () => undefined,
    fstat: async () => ({ mode: 0o644 }),
    futimes: async () => undefined,
    chmod: async () => undefined,
    put: (_stream: any, _path: string, option: any) =>
      new Promise<void>(resolve => {
        reportProgress = option.onProgress;
        finishPut = resolve;
      }),
  };

  const task = new TransferTask(
    { fsPath: '/local/file.txt', fileSystem: srcFs },
    { fsPath: '/remote/file.txt', fileSystem: targetFs },
    {
      fileType: FileType.File,
      transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      transferOption: { perserveTargetMode: false } as any,
    }
  );
  task.stallTimeout = stallTimeout;

  return {
    task,
    progress: (bytes: number) => reportProgress && reportProgress(bytes),
    finish: () => finishPut && finishPut(),
    wasAborted: () => aborted,
  };
}

// let the microtask queue drain so `put` has been reached and onProgress wired
const settle = () => new Promise(resolve => setImmediate(resolve));

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('stallTimeout', () => {
  test('fails a transfer that stops moving bytes', async () => {
    const { task, wasAborted } = createTask(5000);

    const run = task.run();
    const outcome = run.then(() => 'resolved', (err: Error) => err);
    await settle();

    await jest.advanceTimersByTimeAsync(5000);

    const err = (await outcome) as any;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/stalled/);
    // the stream is torn down so the transfer unwinds instead of sitting there
    expect(wasAborted()).toBe(true);
  });

  test('the failure is classified retryable, so the scheduler re-runs it', async () => {
    const { task } = createTask(5000);

    const run = task.run();
    const outcome = run.then(() => null, (err: Error) => err);
    await settle();
    await jest.advanceTimersByTimeAsync(5000);

    expect(isRetryable(await outcome)).toBe(true);
  });

  test('progress pushes the deadline out, so a slow transfer is never cut off', async () => {
    const { task, progress, finish, wasAborted } = createTask(5000);

    const run = task.run();
    const outcome = run.then(() => 'resolved', (err: Error) => err);
    await settle();

    // a byte every 4s for 40s: far longer than the timeout, never stalled
    for (let i = 1; i <= 10; i += 1) {
      await jest.advanceTimersByTimeAsync(4000);
      progress(i * 1024);
    }

    finish();
    expect(await outcome).toBe('resolved');
    expect(wasAborted()).toBe(false);
  });

  test('stalling is measured from the last byte, not from the start', async () => {
    const { task, progress } = createTask(5000);

    const run = task.run();
    const outcome = run.then(() => 'resolved', (err: Error) => err);
    await settle();

    await jest.advanceTimersByTimeAsync(4000);
    progress(1024);
    // 4s more is 8s in total, but only 4s since the last byte
    await jest.advanceTimersByTimeAsync(4000);

    const stillRunning = await Promise.race([
      outcome,
      Promise.resolve('pending'),
    ]);
    expect(stillRunning).toBe('pending');

    await jest.advanceTimersByTimeAsync(1000);
    expect((await outcome) as any).toBeInstanceOf(Error);
  });

  test('does nothing when it is disabled', async () => {
    const { task, finish, wasAborted } = createTask(0);

    const run = task.run();
    const outcome = run.then(() => 'resolved', (err: Error) => err);
    await settle();

    // an hour with no progress at all, and it still waits
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    const stillRunning = await Promise.race([
      outcome,
      Promise.resolve('pending'),
    ]);
    expect(stillRunning).toBe('pending');
    expect(wasAborted()).toBe(false);

    finish();
    expect(await outcome).toBe('resolved');
  });
});
