import { withOperationTimeout, guardOperations } from '../operationTimeout';

// never settles: the failure this whole module exists for
const hang = () => new Promise<never>(() => undefined);

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('withOperationTimeout', () => {
  test('passes a value through untouched', async () => {
    await expect(withOperationTimeout(async () => 'ok', 1000, 'lstat')).resolves.toBe('ok');
  });

  test('passes a rejection through untouched', async () => {
    const err = Object.assign(new Error('no such file'), { code: 2 });
    await expect(withOperationTimeout(() => Promise.reject(err), 1000, 'lstat')).rejects.toBe(err);
  });

  test('turns an operation that never answers into a retryable ETIMEDOUT', async () => {
    const pending = withOperationTimeout(hang, 1000, 'mkdir');
    // asserted on before the clock moves, so a rejection cannot go unhandled
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'ETIMEDOUT',
      message: expect.stringContaining('mkdir'),
    });

    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  test('notifies onTimeout before rejecting, so the connection can be dropped', async () => {
    const onTimeout = jest.fn();
    const pending = withOperationTimeout(hang, 1000, 'mkdir', onTimeout);
    const assertion = expect(pending).rejects.toThrow(/mkdir/);

    await jest.advanceTimersByTimeAsync(1000);
    await assertion;

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout.mock.calls[0][0]).toMatchObject({ code: 'ETIMEDOUT' });
  });

  test('does not fire for an operation that answers in time', async () => {
    const onTimeout = jest.fn();
    const pending = withOperationTimeout(
      () => new Promise(resolve => setTimeout(() => resolve('ok'), 500)),
      1000,
      'lstat',
      onTimeout
    );

    await jest.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toBe('ok');
    expect(onTimeout).not.toHaveBeenCalled();
  });

  test('clears its timer once the operation settles', async () => {
    const before = jest.getTimerCount();
    await withOperationTimeout(async () => 'ok', 60 * 1000, 'lstat');
    expect(jest.getTimerCount()).toBe(before);
  });

  test('runs unguarded when the timeout is 0', async () => {
    const onTimeout = jest.fn();
    let settle: (v: string) => void = () => undefined;
    const pending = withOperationTimeout(
      () => new Promise<string>(resolve => (settle = resolve)),
      0,
      'lstat',
      onTimeout
    );

    // an hour on the clock and it is still waiting, exactly as before
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(jest.getTimerCount()).toBe(0);

    settle('ok');
    await expect(pending).resolves.toBe('ok');
    expect(onTimeout).not.toHaveBeenCalled();
  });

  test('an operation that throws synchronously still rejects', async () => {
    const boom = () => {
      throw new Error('boom');
    };
    await expect(withOperationTimeout(boom as any, 1000, 'lstat')).rejects.toThrow('boom');
  });

  test('a late answer after the deadline does not go unhandled', async () => {
    let fail: (e: Error) => void = () => undefined;
    const pending = withOperationTimeout(
      () => new Promise<string>((_, reject) => (fail = reject)),
      1000,
      'lstat'
    );
    const assertion = expect(pending).rejects.toMatchObject({ code: 'ETIMEDOUT' });

    await jest.advanceTimersByTimeAsync(1000);
    await assertion;

    // the abandoned request finally errors out; nothing is listening any more
    fail(new Error('too late'));
    await jest.advanceTimersByTimeAsync(0);
  });
});

describe('guardOperations', () => {
  function target() {
    return {
      calls: [] as string[],
      lstat(path: string) {
        this.calls.push(`lstat:${path}`);
        return hang();
      },
      mkdir(dir: string) {
        this.calls.push(`mkdir:${dir}`);
        return Promise.resolve();
      },
      // a composite deliberately left unguarded, built out of guarded parts
      ensureDir(dir: string) {
        return this.mkdir(dir).then(() => this.lstat(dir));
      },
      put() {
        return hang();
      },
    };
  }

  test('guards the named methods and leaves the rest alone', async () => {
    const obj = target();
    const put = obj.put;
    guardOperations(obj, ['lstat', 'mkdir'], 1000);

    expect(obj.put).toBe(put);

    const pending = obj.lstat('/srv');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;

    // the original still ran, with its arguments and `this` intact
    expect(obj.calls).toEqual(['lstat:/srv']);
  });

  test('guards calls a composite makes internally', async () => {
    const obj = target();
    guardOperations(obj, ['lstat', 'mkdir'], 1000);

    // ensureDir itself has no deadline, but the lstat it waits on does
    const pending = obj.ensureDir('/srv/www');
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'ETIMEDOUT',
      message: expect.stringContaining('lstat'),
    });

    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(obj.calls).toEqual(['mkdir:/srv/www', 'lstat:/srv/www']);
  });

  test('does nothing when the timeout is 0', async () => {
    const obj = target();
    const lstat = obj.lstat;
    guardOperations(obj, ['lstat'], 0);
    expect(obj.lstat).toBe(lstat);
  });

  test('skips a name that is not a method instead of throwing', () => {
    const obj = target();
    expect(() => guardOperations(obj, ['renamedUpstream'], 1000)).not.toThrow();
  });
});
