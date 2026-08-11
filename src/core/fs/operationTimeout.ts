import logger from '../../logger';

// A remote operation that never answers is the worst kind of failure to
// recover from, because there is nothing to recover *from*: no error arrives,
// so the extension simply waits, and every later command queues up behind it.
//
// It happens for real. A server can leave the SSH transport up -- answering
// keepalive pings perfectly happily, so ssh2's own watchdog never fires --
// while the SFTP subsystem behind it stops reading its channel. Once the
// channel's send window drains to zero every request is buffered locally and
// nothing is ever written to the wire, let alone answered.
//
// Giving each single round-trip operation a deadline turns that silence into
// an ordinary ETIMEDOUT, which is already classified as retryable.

const TIMED_OUT_CODE = 'ETIMEDOUT';

export function createOperationTimeoutError(label: string, timeout: number): Error {
  return Object.assign(
    new Error(`remote operation "${label}" did not answer within ${timeout}ms`),
    { code: TIMED_OUT_CODE }
  );
}

// Runs `run()` with a deadline. A timeout of 0 (or less) runs it unguarded, so
// the whole mechanism can be switched off from config.
export function withOperationTimeout<T>(
  run: () => Promise<T>,
  timeout: number,
  label: string,
  onTimeout?: (error: Error) => void
): Promise<T> {
  if (!(timeout > 0)) {
    return run();
  }

  // .then(run) rather than run() so an operation that throws synchronously
  // still comes back as a rejected promise instead of blowing past the race
  const work = Promise.resolve().then(run);

  // The operation is abandoned, not cancelled -- neither ssh2 nor basic-ftp
  // can take a request back once it is out, so it may still settle long after
  // we have stopped waiting. Keep that late result from surfacing as an
  // unhandled rejection.
  work.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = createOperationTimeoutError(label, timeout);
      if (onTimeout) {
        onTimeout(error);
      }
      reject(error);
    }, timeout);
  });

  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

// Replaces the named methods on `target` with deadline-guarded versions of
// themselves. The replacements are own properties shadowing the prototype, so
// internal `this.lstat(...)` calls are guarded too -- which is what lets a
// composite operation like ensureDir() be covered without being wrapped
// itself, where one deadline would have to span an unbounded number of trips.
export function guardOperations(
  target: object,
  names: string[],
  timeout: number,
  onTimeout?: (error: Error) => void
): void {
  if (!(timeout > 0)) {
    return;
  }

  for (const name of names) {
    const original = target[name];
    if (typeof original !== 'function') {
      // a rename upstream would otherwise silently drop the guard
      logger.warn(`cannot apply operationTimeout to "${name}": not a method`);
      continue;
    }

    target[name] = function guarded(...args: any[]) {
      return withOperationTimeout(
        () => original.apply(this, args),
        timeout,
        name,
        onTimeout
      );
    };
  }
}
