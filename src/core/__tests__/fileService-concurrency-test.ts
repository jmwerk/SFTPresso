import FileService from '../fileService';
import TransferTask from '../transferTask';

// A stand-in for TransferTask exposing only what the scheduler touches.
function createFakeTask(run: () => Promise<void>) {
  return {
    attempts: 0,
    localFsPath: '/ws/file.txt',
    transferType: 'local ➞ remote',
    setProgressListener() {
      /* no progress in this test */
    },
    isCancelled: () => false,
    cancel() {
      /* not exercised here */
    },
    reset() {
      /* not exercised here */
    },
    dispose() {
      /* not exercised here */
    },
    run,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function createService(config: Record<string, any> = {}) {
  return new FileService('/ws', '/ws', config as any);
}

describe('FileService concurrency', () => {
  it('constructing a service with concurrency: 0 does not throw', () => {
    expect(() => createService({ concurrency: 0 })).not.toThrow();
  });

  it('createTransferScheduler(0, ...) does not throw and still runs tasks', async () => {
    const service = createService({ concurrency: 0 });
    const scheduler = service.createTransferScheduler(0);

    let ran = false;
    const task = createFakeTask(async () => {
      ran = true;
    });
    scheduler.add(task as unknown as TransferTask);

    await scheduler.run();

    expect(ran).toBe(true);
  });

  it("a batch starting with a lower concurrency does not throttle another batch's already-admitted work", async () => {
    const service = createService();

    let activeA = 0;
    let peakA = 0;
    const gatesA = [deferred(), deferred(), deferred()];
    const schedulerA = service.createTransferScheduler(3);
    gatesA.forEach(gate =>
      schedulerA.add(
        createFakeTask(async () => {
          activeA += 1;
          peakA = Math.max(peakA, activeA);
          await gate.promise;
          activeA -= 1;
        }) as unknown as TransferTask
      )
    );
    const runA = schedulerA.run();

    // let all three of batch A's tasks get admitted through the shared gate
    // before batch B ever starts
    await Promise.resolve();
    await Promise.resolve();
    expect(peakA).toBe(3);

    // batch B starts concurrently with a much stricter setting -- it must not
    // retroactively cap batch A's three already-running tasks down to 1
    const schedulerB = service.createTransferScheduler(1);
    const gateB = deferred();
    schedulerB.add(createFakeTask(() => gateB.promise) as unknown as TransferTask);
    const runB = schedulerB.run();

    await Promise.resolve();
    expect(peakA).toBe(3);

    gatesA.forEach(gate => gate.resolve());
    await runA;
    gateB.resolve();
    await runB;
  });
});
