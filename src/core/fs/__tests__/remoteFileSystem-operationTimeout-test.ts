import RemoteFileSystem from '../remoteFileSystem';

// RemoteFileSystem inherits a pile of abstract members from FileSystem that
// have nothing to do with what is under test here. Erase the type so the
// double can implement just the handful the timeout path touches.
const Base = RemoteFileSystem as unknown as new (pathResolver: any, option: any) => any;

class FakeRemoteFs extends Base {
  ended: boolean = false;
  answer: (() => Promise<any>) | undefined;

  _timedOperations() {
    return ['lstat', 'mkdir'];
  }

  _createClient() {
    throw new Error('_createClient should not be reached: a client was supplied');
  }

  probe() {
    return Promise.resolve();
  }

  end() {
    this.ended = true;
  }

  lstat(path: string) {
    return this.answer ? this.answer() : new Promise(() => undefined);
  }

  mkdir(_dir: string) {
    return new Promise(() => undefined);
  }

  // composite, unguarded on purpose -- covered by the mkdir/lstat above
  ensureDir(dir: string) {
    return this.mkdir(dir);
  }
}

function createFs(operationTimeout: number) {
  const disconnectListeners: Array<(reason: string) => void> = [];
  const client = {
    end: () => disconnectListeners.forEach(cb => cb('close')),
    onDisconnected: (cb: (reason: string) => void) => disconnectListeners.push(cb),
    getFsClient: () => ({}),
  };
  return new FakeRemoteFs({}, { client, operationTimeout });
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('RemoteFileSystem operationTimeout', () => {
  test('fails a request the server never answers', async () => {
    const fs = createFs(60 * 1000);
    const pending = fs.lstat('/srv/www');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'ETIMEDOUT' });

    await jest.advanceTimersByTimeAsync(60 * 1000);
    await assertion;
  });

  test('drops the connection on timeout, so the pool cannot hand it back', async () => {
    const fs = createFs(60 * 1000);
    const pending = fs.lstat('/srv/www');
    const assertion = expect(pending).rejects.toThrow();

    await jest.advanceTimersByTimeAsync(60 * 1000);
    await assertion;

    expect(fs.ended).toBe(true);
  });

  test('notifies the disconnect listener the pool evicts on', async () => {
    const disconnectListeners: Array<(reason: string) => void> = [];
    const client = {
      // the real clients both end up here: ssh2 emits close, basic-ftp's
      // wrapper calls _notifyDisconnected directly
      end: () => disconnectListeners.forEach(cb => cb('close')),
      onDisconnected: (cb: (reason: string) => void) => disconnectListeners.push(cb),
      getFsClient: () => ({}),
    };
    const fs = new FakeRemoteFs({}, { client, operationTimeout: 60 * 1000 });

    const evicted = jest.fn();
    fs.onDisconnected(evicted);
    // the double's end() short-circuits the client, so call through to it
    fs.end = () => client.end();

    const pending = fs.lstat('/srv/www');
    const assertion = expect(pending).rejects.toThrow();
    await jest.advanceTimersByTimeAsync(60 * 1000);
    await assertion;

    expect(evicted).toHaveBeenCalledWith('close');
  });

  test('the guard covers a composite through the primitive it calls', async () => {
    const fs = createFs(60 * 1000);
    const pending = fs.ensureDir('/srv/www');
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'ETIMEDOUT',
      message: expect.stringContaining('mkdir'),
    });

    await jest.advanceTimersByTimeAsync(60 * 1000);
    await assertion;
    expect(fs.ended).toBe(true);
  });

  test('leaves a healthy request alone and keeps the connection', async () => {
    const fs = createFs(60 * 1000);
    fs.answer = () => Promise.resolve({ size: 42 });

    await expect(fs.lstat('/srv/www')).resolves.toEqual({ size: 42 });
    expect(fs.ended).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('waits indefinitely when the timeout is 0, as it always did', async () => {
    const fs = createFs(0);
    let settled = false;
    fs.lstat('/srv/www').then(() => (settled = true), () => (settled = true));

    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(settled).toBe(false);
    expect(fs.ended).toBe(false);
  });
});
