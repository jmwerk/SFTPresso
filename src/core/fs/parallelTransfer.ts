import { ERROR_MSG_STREAM_INTERRUPT, ParallelTransferToken } from './fileSystem';

export interface ChunkReader {
  read(buffer: Buffer, position: number, length: number): Promise<number>;
}

export interface ChunkWriter {
  write(buffer: Buffer, position: number, length: number): Promise<void>;
}

export interface ParallelCopyOptions {
  size: number;
  concurrency?: number;
  chunkSize?: number;
  onProgress?: (transferred: number) => void;
  token?: ParallelTransferToken;
}

const DEFAULT_CHUNK_SIZE = 32768;
const DEFAULT_CONCURRENCY = 16;

export function abortedError(): Error {
  return Object.assign(new Error('Transfer Aborted'), { code: ERROR_MSG_STREAM_INTERRUPT });
}

// Races one chunk I/O call against cancellation, so a request the server never
// answers doesn't leave the transfer waiting on it forever. There is no cancel
// message in the SFTP protocol, so the underlying read/write is abandoned, not
// actually stopped -- this only guarantees our side stops waiting on it, the
// same guarantee FileSystem.abortReadableStream gives the stream path via
// stream.destroy().
function abortable<T>(promise: Promise<T>, token: ParallelTransferToken | undefined): Promise<T> {
  if (!token) {
    return promise;
  }
  if (token.isCancellationRequested) {
    return Promise.reject(abortedError());
  }
  return new Promise<T>((resolve, reject) => {
    const sub = token.onCancellationRequested(() => reject(abortedError()));
    promise.then(
      value => {
        sub.dispose();
        resolve(value);
      },
      err => {
        sub.dispose();
        reject(err);
      }
    );
  });
}

/**
 * Copies `size` bytes from `src` to `dst` as concurrent, positional chunks
 * rather than one sequential stream -- the throughput win on a high-latency
 * link, where a single outstanding request bounds transfer speed to
 * chunkSize/RTT regardless of available bandwidth.
 */
export async function parallelCopy(
  src: ChunkReader,
  dst: ChunkWriter,
  opts: ParallelCopyOptions
): Promise<void> {
  const { size, token } = opts;
  if (size <= 0) {
    return;
  }
  if (token && token.isCancellationRequested) {
    throw abortedError();
  }

  const chunkSize = opts.chunkSize && opts.chunkSize > 0 ? opts.chunkSize : DEFAULT_CHUNK_SIZE;
  const concurrency = Math.max(
    1,
    Math.min(opts.concurrency || DEFAULT_CONCURRENCY, Math.ceil(size / chunkSize))
  );

  let nextOffset = 0;
  let transferred = 0;
  let firstError: unknown;

  function claim(): { offset: number; length: number } | null {
    if (firstError !== undefined || (token && token.isCancellationRequested) || nextOffset >= size) {
      return null;
    }
    const offset = nextOffset;
    const length = Math.min(chunkSize, size - offset);
    nextOffset += length;
    return { offset, length };
  }

  async function worker(): Promise<void> {
    // Reused across every chunk this worker claims -- safe because a worker
    // only ever has one read/write in flight at a time.
    const buffer = Buffer.allocUnsafe(chunkSize);
    for (;;) {
      const chunk = claim();
      if (!chunk) {
        return;
      }
      try {
        let done = 0;
        while (done < chunk.length) {
          const read = await abortable(
            src.read(buffer, chunk.offset + done, chunk.length - done),
            token
          );
          if (read <= 0) {
            throw new Error(`unexpected end of stream at offset ${chunk.offset + done}`);
          }
          await abortable(
            dst.write(buffer.subarray(0, read), chunk.offset + done, read),
            token
          );
          done += read;
          transferred += read;
          opts.onProgress?.(transferred);
        }
      } catch (err) {
        if (firstError === undefined) {
          firstError = err;
        }
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (firstError) {
    throw firstError;
  }
  if (token && token.isCancellationRequested) {
    throw abortedError();
  }
}
