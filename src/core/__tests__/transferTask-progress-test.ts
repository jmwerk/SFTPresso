jest.mock('fs');

import { vol } from 'memfs';
import * as fs from 'fs';
import * as path from 'path';
import TransferTask, { TransferDirection } from '../transferTask';
import { FileType } from '../fs';
import localFs from '../localFs';
import RemoteFs from '../../../test/helper/localRemoteFs';

function createRemoteFs() {
  return new RemoteFs(path, {
    clientOption: {} as any,
    remoteTimeOffsetInHours: 0,
  });
}

function makeUploadTask(size: number, { withSize = true } = {}) {
  vol.reset();
  vol.fromJSON({ '/local/big.bin': 'x'.repeat(size) }, '/');
  fs.mkdirSync('/remote');

  const remoteFs = createRemoteFs();
  return new TransferTask(
    { fsPath: '/local/big.bin', fileSystem: localFs },
    { fsPath: '/remote/big.bin', fileSystem: remoteFs as any },
    {
      fileType: FileType.File,
      transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      transferOption: {
        perserveTargetMode: false,
        atime: 0,
        mtime: 0,
        size: withSize ? size : undefined,
      },
    }
  );
}

describe('TransferTask progress', () => {
  afterEach(() => vol.reset());

  it('reports byte progress up to the total size', async () => {
    const size = 300 * 1024;
    const task = makeUploadTask(size);
    let progressCalls = 0;
    task.setProgressListener(() => {
      progressCalls += 1;
    });

    expect(task.totalBytes).toBe(size);
    await task.run();

    expect(progressCalls).toBeGreaterThan(0);
    expect(task.transferredBytes).toBe(size);
    // the file actually landed on the "remote"
    expect(fs.readFileSync('/remote/big.bin', 'utf8').length).toBe(size);
  });

  it('degrades to unknown total size', async () => {
    const size = 4096;
    const task = makeUploadTask(size, { withSize: false });
    await task.run();

    expect(task.totalBytes).toBeUndefined();
    expect(task.transferredBytes).toBe(size);
  });

  it('reset() clears state so the task can be retried', async () => {
    const size = 8192;
    const task = makeUploadTask(size);
    await task.run();
    expect(task.transferredBytes).toBe(size);

    // simulate the failed->retry path
    task.reset();
    expect(task.transferredBytes).toBe(0);
    expect(task.isCancelled()).toBe(false);

    await task.run();
    expect(task.transferredBytes).toBe(size);
    expect(fs.readFileSync('/remote/big.bin', 'utf8').length).toBe(size);
  });

  it('cancel still works with a progress listener attached', async () => {
    const size = 64 * 1024;
    const task = makeUploadTask(size);
    task.setProgressListener(() => undefined);
    task.cancel();
    expect(task.isCancelled()).toBe(true);
    // a task cancelled before start never transfers
    await task.run();
    expect(task.transferredBytes).toBe(0);
  });
});

describe('TransferTask bytesPerSecond', () => {
  // baseline system time; starting fake timers at 0 would make the very
  // first throttled sample fail the "now - lastReportAt >= interval" check
  const BASE_TIME = 1_000_000;

  // synthesize a throttled progress tick at `atMs` after BASE_TIME, bypassing
  // the real transfer stream so the sample timeline is fully deterministic
  function tick(task: TransferTask, atMs: number, bytes: number) {
    jest.setSystemTime(BASE_TIME + atMs);
    (task as any)._reportProgress(bytes);
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    jest.useRealTimers();
    vol.reset();
  });

  it('is undefined until a second sample is recorded', () => {
    const task = makeUploadTask(1024 * 1024);
    task.setProgressListener(() => undefined);

    tick(task, 0, 1000);
    expect(task.bytesPerSecond).toBeUndefined();
  });

  it('computes throughput from the oldest and newest sample in the window', () => {
    const task = makeUploadTask(1024 * 1024);
    task.setProgressListener(() => undefined);

    tick(task, 0, 0);
    tick(task, 500, 50_000);
    tick(task, 1000, 100_000);

    // 100,000 bytes transferred over the 1s spanned by the oldest and newest sample
    expect(task.bytesPerSecond).toBeCloseTo(100_000);
  });

  it('keeps only the last 5 samples so the rate reflects recent throughput', () => {
    const task = makeUploadTask(10 * 1024 * 1024);
    task.setProgressListener(() => undefined);

    tick(task, 0, 0);
    tick(task, 500, 500_000); // an initial burst
    for (let i = 1; i <= 5; i++) {
      // steady 100,000 B/s afterwards; pushes the burst sample out of the window
      tick(task, 500 + i * 500, 500_000 + i * 50_000);
    }

    expect(task.bytesPerSecond).toBeCloseTo(100_000);
  });

  it('does not sample or notify for calls inside the throttle window', () => {
    const task = makeUploadTask(1024 * 1024);
    let calls = 0;
    task.setProgressListener(() => {
      calls += 1;
    });

    tick(task, 0, 0);
    tick(task, 100, 999_999); // still inside the 500ms throttle window

    expect(calls).toBe(1);
    expect(task.bytesPerSecond).toBeUndefined();
  });

  it('reset() clears accumulated samples', () => {
    const task = makeUploadTask(1024 * 1024);
    task.setProgressListener(() => undefined);

    tick(task, 0, 0);
    tick(task, 500, 50_000);
    expect(task.bytesPerSecond).toBeDefined();

    task.reset();
    expect(task.bytesPerSecond).toBeUndefined();
  });
});
