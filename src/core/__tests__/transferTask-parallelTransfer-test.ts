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

// Well over the 256KB auto threshold, so 'auto' picks the parallel path too.
const BIG_SIZE = 500 * 1024;

function makeTask(
  direction: TransferDirection,
  transferOption: Record<string, any>
) {
  const remoteFs = createRemoteFs();
  const [srcFs, targetFs] =
    direction === TransferDirection.LOCAL_TO_REMOTE
      ? [localFs, remoteFs]
      : [remoteFs, localFs];
  const [srcPath, targetPath] =
    direction === TransferDirection.LOCAL_TO_REMOTE
      ? ['/local/big.bin', '/remote/big.bin']
      : ['/remote/big.bin', '/local/big.bin'];

  return new TransferTask(
    { fsPath: srcPath, fileSystem: srcFs as any },
    { fsPath: targetPath, fileSystem: targetFs as any },
    {
      fileType: FileType.File,
      transferDirection: direction,
      transferOption: { atime: 0, mtime: 0, ...transferOption } as any,
    }
  );
}

function content(size: number, byte = 0x61) {
  return Buffer.alloc(size, byte);
}

describe('TransferTask parallel-chunk transfer', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync('/local', { recursive: true });
    vol.mkdirSync('/remote', { recursive: true });
  });

  it('uploads a large file byte-for-byte via the parallel path', async () => {
    fs.writeFileSync('/local/big.bin', content(BIG_SIZE, 0x41));

    const task = makeTask(TransferDirection.LOCAL_TO_REMOTE, {
      perserveTargetMode: false,
      size: BIG_SIZE,
      transferMode: 'parallel',
    });

    let progressCalls = 0;
    task.setProgressListener(() => (progressCalls += 1));

    await task.run();

    expect(fs.readFileSync('/remote/big.bin')).toEqual(content(BIG_SIZE, 0x41));
    expect(task.transferredBytes).toBe(BIG_SIZE);
    expect(progressCalls).toBeGreaterThan(0);
  });

  it('downloads a large file byte-for-byte via the parallel path', async () => {
    fs.writeFileSync('/remote/big.bin', content(BIG_SIZE, 0x42));

    const task = makeTask(TransferDirection.REMOTE_TO_LOCAL, {
      perserveTargetMode: false,
      size: BIG_SIZE,
      transferMode: 'parallel',
    });

    await task.run();

    expect(fs.readFileSync('/local/big.bin')).toEqual(content(BIG_SIZE, 0x42));
    expect(task.transferredBytes).toBe(BIG_SIZE);
  });

  it('stays on the stream path below the auto threshold', async () => {
    const size = 4096;
    fs.writeFileSync('/local/big.bin', content(size, 0x43));

    const task = makeTask(TransferDirection.LOCAL_TO_REMOTE, {
      perserveTargetMode: false,
      size,
      // transferMode omitted -> 'auto'
    });

    expect((task as any)._shouldUseParallelTransfer()).toBe(false);
    await task.run();
    expect(fs.readFileSync('/remote/big.bin')).toEqual(content(size, 0x43));
  });

  it('honours useTempFile with the same rename dance as the stream path', async () => {
    fs.writeFileSync('/local/big.bin', content(BIG_SIZE, 0x44));
    fs.writeFileSync('/remote/big.bin', 'stale previous content');

    const task = makeTask(TransferDirection.LOCAL_TO_REMOTE, {
      perserveTargetMode: false,
      size: BIG_SIZE,
      transferMode: 'parallel',
      useTempFile: true,
    });

    await task.run();

    expect(fs.existsSync('/remote/big.bin.new')).toBe(false);
    expect(fs.readFileSync('/remote/big.bin')).toEqual(content(BIG_SIZE, 0x44));
  });

  it('preserves the existing target mode when perserveTargetMode is set', async () => {
    fs.writeFileSync('/local/big.bin', content(BIG_SIZE, 0x45));
    fs.writeFileSync('/remote/big.bin', 'stale');
    fs.chmodSync('/remote/big.bin', 0o640);

    const task = makeTask(TransferDirection.LOCAL_TO_REMOTE, {
      perserveTargetMode: true,
      size: BIG_SIZE,
      transferMode: 'parallel',
    });

    await task.run();

    expect(fs.statSync('/remote/big.bin').mode & 0o777).toBe(0o640);
  });

  it('applies atime/mtime after a parallel transfer', async () => {
    fs.writeFileSync('/local/big.bin', content(BIG_SIZE, 0x46));
    const atime = 1_600_000_000_000;
    const mtime = 1_600_000_100_000;

    const task = makeTask(TransferDirection.LOCAL_TO_REMOTE, {
      perserveTargetMode: false,
      size: BIG_SIZE,
      transferMode: 'parallel',
      atime,
      mtime,
    });

    await task.run();

    const stat = fs.statSync('/remote/big.bin');
    expect(Math.floor(stat.mtime.getTime() / 1000)).toBe(Math.floor(mtime / 1000));
  });

  it('cancelling mid-transfer unwinds instead of hanging', async () => {
    fs.writeFileSync('/local/big.bin', content(5 * 1024 * 1024, 0x47));

    const task = makeTask(TransferDirection.LOCAL_TO_REMOTE, {
      perserveTargetMode: false,
      size: 5 * 1024 * 1024,
      transferMode: 'parallel',
    });

    const run = task.run().catch((err: Error) => err);
    // let the transfer actually start before cancelling
    await new Promise(resolve => setImmediate(resolve));
    task.cancel();

    const outcome = await run;
    expect(task.isCancelled()).toBe(true);
    expect(outcome).toBeDefined();
  });
});
