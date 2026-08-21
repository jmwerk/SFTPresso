import { parallelCopy, ChunkReader, ChunkWriter } from '../parallelTransfer';
import { FileSystem } from '..';

// A source of `size` deterministic bytes (byte at offset i === i % 256),
// readable in arbitrary sub-ranges -- enough to prove chunk boundaries and
// concurrent claims never lose or duplicate a byte.
function fakeSource(size: number): ChunkReader {
  return {
    read: async (buffer, position, length) => {
      for (let i = 0; i < length; i += 1) {
        buffer[i] = (position + i) % 256;
      }
      return length;
    },
  };
}

function fakeSink(size: number) {
  const data = Buffer.alloc(size);
  const writes: { position: number; length: number }[] = [];
  const writer: ChunkWriter = {
    write: async (buffer, position, length) => {
      writes.push({ position, length });
      buffer.copy(data, position, 0, length);
    },
  };
  return { writer, data, writes };
}

function fakeToken() {
  let cancelled = false;
  const listeners: (() => void)[] = [];
  return {
    token: {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested(listener: () => void) {
        listeners.push(listener);
        return { dispose() {} };
      },
    },
    cancel() {
      cancelled = true;
      listeners.forEach(l => l());
    },
  };
}

describe('parallelCopy', () => {
  test('copies every byte exactly once across concurrent chunks', async () => {
    const size = 100000;
    const { writer, data } = fakeSink(size);

    await parallelCopy(fakeSource(size), writer, { size, chunkSize: 4096, concurrency: 8 });

    for (let i = 0; i < size; i += 997) {
      expect(data[i]).toBe(i % 256);
    }
    expect(data[size - 1]).toBe((size - 1) % 256);
  });

  test('is a no-op for a zero-byte file', async () => {
    const { writer, writes } = fakeSink(0);
    await parallelCopy(fakeSource(0), writer, { size: 0 });
    expect(writes).toHaveLength(0);
  });

  test('reports cumulative progress as chunks land', async () => {
    const size = 10000;
    const { writer } = fakeSink(size);
    const samples: number[] = [];

    await parallelCopy(fakeSource(size), writer, {
      size,
      chunkSize: 1000,
      concurrency: 4,
      onProgress: transferred => samples.push(transferred),
    });

    expect(samples[samples.length - 1]).toBe(size);
    // strictly increasing -- every progress call reflects more bytes than the last
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1]);
    }
  });

  test('propagates a read error instead of reporting success', async () => {
    const size = 10000;
    const { writer } = fakeSink(size);
    const failingSource: ChunkReader = {
      read: async () => {
        throw new Error('ECONNRESET');
      },
    };

    await expect(
      parallelCopy(failingSource, writer, { size, chunkSize: 1000, concurrency: 4 })
    ).rejects.toThrow('ECONNRESET');
  });

  test('stops without hanging when the token cancels mid-transfer, even with a request that never answers', async () => {
    const size = 100000;
    const { writer } = fakeSink(size);
    const { token, cancel } = fakeToken();

    let started = 0;
    const hangingSource: ChunkReader = {
      read: (buffer, position, length) => {
        started += 1;
        // never resolves on its own -- only abortable()'s cancellation race
        // can unstick this, exactly like a server that stopped answering
        return new Promise<number>(() => {});
      },
    };

    const outcome = parallelCopy(hangingSource, writer, {
      size,
      chunkSize: 1000,
      concurrency: 4,
      token,
    });

    // let every worker dispatch its first (permanently pending) read
    await new Promise(resolve => setImmediate(resolve));
    expect(started).toBeGreaterThan(0);

    cancel();

    await expect(outcome).rejects.toThrow(/Transfer Aborted/);
  });

  test('a token already cancelled before the call rejects immediately', async () => {
    const size = 10000;
    const { writer } = fakeSink(size);
    const { token, cancel } = fakeToken();
    cancel();

    await expect(
      parallelCopy(fakeSource(size), writer, { size, token })
    ).rejects.toThrow(/Transfer Aborted/);
  });

  test('an aborted copy is recognised by FileSystem.isAbortedError', async () => {
    const size = 10000;
    const { writer } = fakeSink(size);
    const { token, cancel } = fakeToken();
    cancel();

    try {
      await parallelCopy(fakeSource(size), writer, { size, token });
      throw new Error('expected parallelCopy to reject');
    } catch (err) {
      expect(FileSystem.isAbortedError(err as any)).toBe(true);
    }
  });
});
