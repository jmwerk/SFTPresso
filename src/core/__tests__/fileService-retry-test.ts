import FileService from '../fileService';
import TransferTask from '../transferTask';

// A stand-in for TransferTask exposing only what the scheduler touches, so the
// test can drive failures without a real file system.
function createFakeTask(
  results: (Error | null)[],
  option: { cancelled?: boolean } = {}
) {
  const runsAt: number[] = [];
  const refreshedFs: unknown[] = [];
  const task = {
    attempts: 0,
    resetCount: 0,
    disposeCount: 0,
    cancelCount: 0,
    runsAt,
    refreshedFs,
    localFsPath: '/ws/file.txt',
    transferType: 'local ➞ remote',
    setProgressListener() {
      /* no progress in this test */
    },
    isCancelled: () => Boolean(option.cancelled),
    cancel() {
      task.cancelCount += 1;
      option.cancelled = true;
    },
    reset() {
      task.resetCount += 1;
    },
    dispose() {
      task.disposeCount += 1;
    },
    refreshRemoteFs(fs: unknown) {
      refreshedFs.push(fs);
    },
    async run() {
      runsAt.push(Date.now());
      const result = results.length > 1 ? results.shift()! : results[0];
      if (result) {
        throw result;
      }
    },
  };

  return task;
}

function transientError() {
  return Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
}

function createService() {
  return new FileService('/ws', '/ws', {} as any);
}

// runs the scheduler to completion, letting every backoff elapse
async function runToCompletion(scheduler: { run(): Promise<void> }) {
  const done = scheduler.run();
  let settled = false;
  done.then(() => {
    settled = true;
  });

  // advance in retry-sized steps until nothing is left waiting
  for (let i = 0; i < 20 && !settled; i++) {
    await jest.advanceTimersByTimeAsync(20 * 1000);
  }

  return done;
}

let service: FileService;
let afterTransfer: jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  service = createService();
  afterTransfer = jest.fn();
  service.afterTransfer(afterTransfer);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('transfer retry', () => {
  it('retries a transient failure and reports success once it goes through', async () => {
    const task = createFakeTask([transientError(), null]);
    const scheduler = service.createTransferScheduler(1, { attempts: 2, delay: 1000 });
    scheduler.add(task as unknown as TransferTask);

    await runToCompletion(scheduler);

    expect(task.runsAt).toHaveLength(2);
    expect(task.attempts).toBe(1);
    expect(task.resetCount).toBe(1);
    expect(afterTransfer).toHaveBeenCalledTimes(1);
    expect(afterTransfer).toHaveBeenCalledWith(null, task);
  });

  it('backs off exponentially, doubling from the configured delay', async () => {
    const error = transientError();
    const task = createFakeTask([error]);
    const scheduler = service.createTransferScheduler(1, { attempts: 3, delay: 1000 });
    scheduler.add(task as unknown as TransferTask);

    await runToCompletion(scheduler);

    // one initial run plus `attempts` retries
    expect(task.runsAt).toHaveLength(4);
    const gaps = task.runsAt.slice(1).map((at, i) => at - task.runsAt[i]);
    expect(gaps).toEqual([2000, 4000, 8000]);
  });

  it('caps the backoff at 15s', async () => {
    const task = createFakeTask([transientError()]);
    const scheduler = service.createTransferScheduler(1, { attempts: 6, delay: 1000 });
    scheduler.add(task as unknown as TransferTask);

    await runToCompletion(scheduler);

    const gaps = task.runsAt.slice(1).map((at, i) => at - task.runsAt[i]);
    expect(gaps).toEqual([2000, 4000, 8000, 15000, 15000, 15000]);
  });

  it('scales the backoff with the configured delay', async () => {
    const task = createFakeTask([transientError()]);
    const scheduler = service.createTransferScheduler(1, { attempts: 2, delay: 250 });
    scheduler.add(task as unknown as TransferTask);

    await runToCompletion(scheduler);

    const gaps = task.runsAt.slice(1).map((at, i) => at - task.runsAt[i]);
    expect(gaps).toEqual([500, 1000]);
  });

  it('gives up after the configured number of attempts and reports the error', async () => {
    const error = transientError();
    const task = createFakeTask([error]);
    const scheduler = service.createTransferScheduler(1, { attempts: 2, delay: 1000 });
    scheduler.add(task as unknown as TransferTask);

    await runToCompletion(scheduler);

    expect(task.runsAt).toHaveLength(3);
    expect(task.attempts).toBe(2);
    expect(afterTransfer).toHaveBeenCalledTimes(1);
    expect(afterTransfer).toHaveBeenCalledWith(error, task);
    expect(task.disposeCount).toBe(1);
  });

  it('does not retry a permission failure', async () => {
    const error = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    const task = createFakeTask([error]);
    const scheduler = service.createTransferScheduler(1, { attempts: 2, delay: 1000 });
    scheduler.add(task as unknown as TransferTask);

    await runToCompletion(scheduler);

    expect(task.runsAt).toHaveLength(1);
    expect(task.attempts).toBe(0);
    expect(afterTransfer).toHaveBeenCalledWith(error, task);
  });

  it('does not retry a cancelled task', async () => {
    const task = createFakeTask([transientError()], { cancelled: true });
    const scheduler = service.createTransferScheduler(1, { attempts: 2, delay: 1000 });
    scheduler.add(task as unknown as TransferTask);

    await runToCompletion(scheduler);

    expect(task.runsAt).toHaveLength(1);
    expect(afterTransfer).toHaveBeenCalledTimes(1);
  });

  it('retries nothing when attempts is 0', async () => {
    const task = createFakeTask([transientError()]);
    const scheduler = service.createTransferScheduler(1, { attempts: 0, delay: 1000 });
    scheduler.add(task as unknown as TransferTask);

    await runToCompletion(scheduler);

    expect(task.runsAt).toHaveLength(1);
    expect(afterTransfer).toHaveBeenCalledTimes(1);
  });

  it('defaults to 2 attempts', async () => {
    const task = createFakeTask([transientError()]);
    const scheduler = service.createTransferScheduler(1);
    scheduler.add(task as unknown as TransferTask);

    await runToCompletion(scheduler);

    expect(task.runsAt).toHaveLength(3);
    const gaps = task.runsAt.slice(1).map((at, i) => at - task.runsAt[i]);
    expect(gaps).toEqual([2000, 4000]);
  });

  it('drops a task waiting on a backoff when the scheduler is stopped', async () => {
    const error = transientError();
    const task = createFakeTask([error]);
    const scheduler = service.createTransferScheduler(1, { attempts: 2, delay: 1000 });
    scheduler.add(task as unknown as TransferTask);

    const done = scheduler.run();
    // let the first attempt fail and schedule its retry
    await jest.advanceTimersByTimeAsync(0);
    expect(task.runsAt).toHaveLength(1);

    scheduler.stop();
    await jest.advanceTimersByTimeAsync(60 * 1000);
    await done;

    expect(task.runsAt).toHaveLength(1);
    // it still reports back, so the Transfers view and progress counters settle
    expect(task.cancelCount).toBe(1);
    expect(afterTransfer).toHaveBeenCalledWith(error, task);
    expect(task.disposeCount).toBe(1);
  });

  it('reconnects and refreshes the remote fs before re-running a retried task', async () => {
    const freshFs = { marker: 'fresh' };
    const getRemoteFileSystem = jest
      .spyOn(service, 'getRemoteFileSystem')
      .mockResolvedValue(freshFs as any);
    const task = createFakeTask([transientError(), null]);
    const config = { some: 'config' } as any;
    const scheduler = service.createTransferScheduler(
      1,
      { attempts: 2, delay: 1000 },
      0,
      config
    );
    scheduler.add(task as unknown as TransferTask);

    await runToCompletion(scheduler);

    expect(getRemoteFileSystem).toHaveBeenCalledWith(config);
    expect(task.refreshedFs).toEqual([freshFs]);
    expect(task.runsAt).toHaveLength(2);
    expect(afterTransfer).toHaveBeenCalledWith(null, task);
  });

  it('reports the task as failed, without hanging, when the reconnect itself fails', async () => {
    const reconnectError = new Error('ECONNREFUSED');
    jest.spyOn(service, 'getRemoteFileSystem').mockRejectedValue(reconnectError);
    const task = createFakeTask([transientError()]);
    const config = { some: 'config' } as any;
    const scheduler = service.createTransferScheduler(
      1,
      { attempts: 2, delay: 1000 },
      0,
      config
    );
    scheduler.add(task as unknown as TransferTask);

    await runToCompletion(scheduler);

    // the retry never actually re-ran the transfer
    expect(task.runsAt).toHaveLength(1);
    expect(task.refreshedFs).toHaveLength(0);
    expect(afterTransfer).toHaveBeenCalledWith(reconnectError, task);
    expect(task.disposeCount).toBe(1);
  });

  it('does not re-run or hang when stop() lands while a reconnect is in flight', async () => {
    const error = transientError();
    let resolveReconnect: (fs: unknown) => void;
    jest.spyOn(service, 'getRemoteFileSystem').mockReturnValue(
      new Promise(resolve => {
        resolveReconnect = resolve;
      }) as any
    );
    const task = createFakeTask([error]);
    const config = { some: 'config' } as any;
    const scheduler = service.createTransferScheduler(
      1,
      { attempts: 2, delay: 1000 },
      0,
      config
    );
    scheduler.add(task as unknown as TransferTask);

    const done = scheduler.run();
    // let the first attempt fail and its backoff elapse, landing us mid-reconnect
    await jest.advanceTimersByTimeAsync(2000);
    expect(task.runsAt).toHaveLength(1);

    scheduler.stop();
    // stop() should have already cancelled and reported the task synchronously
    expect(task.cancelCount).toBe(1);
    expect(afterTransfer).toHaveBeenCalledTimes(1);
    expect(afterTransfer).toHaveBeenCalledWith(error, task);

    // the reconnect now resolves after the fact -- must not re-run the task or
    // report it a second time, and run() must still settle
    resolveReconnect!({ marker: 'late' });
    await done;

    expect(task.runsAt).toHaveLength(1);
    expect(task.refreshedFs).toHaveLength(0);
    expect(afterTransfer).toHaveBeenCalledTimes(1);
  });
});
