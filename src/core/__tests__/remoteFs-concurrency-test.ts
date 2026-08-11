jest.mock('fs');

// A stand-in for the real SFTP/FTP filesystems. Connecting, probing and
// disconnecting are all driven by the test.
jest.mock('../fs', () => {
  class FakeRemoteFs {
    static instances: FakeRemoteFs[] = [];
    // lets a test hold every connect open so callers genuinely overlap
    static connectGate: Promise<void> = Promise.resolve();

    connectCount = 0;
    probeCount = 0;
    ended = false;
    probeImpl: () => Promise<void> = () => Promise.resolve();
    disconnectListeners: Array<(reason: string, err?: Error) => void> = [];

    constructor(public pathResolver: any, public option: any) {
      FakeRemoteFs.instances.push(this);
    }

    connect() {
      this.connectCount += 1;
      return FakeRemoteFs.connectGate;
    }

    onDisconnected(cb: (reason: string, err?: Error) => void) {
      this.disconnectListeners.push(cb);
    }

    // what a socket unwinding looks like from the pool's side
    emitDisconnect(reason: string, err?: Error) {
      this.disconnectListeners.forEach(cb => cb(reason, err));
    }

    end() {
      this.ended = true;
    }

    probe() {
      this.probeCount += 1;
      return this.probeImpl();
    }
  }

  return {
    __esModule: true,
    FileSystem: class {},
    LocalFileSystem: class {
      constructor(public pathResolver: any) {}
    },
    RemoteFileSystem: FakeRemoteFs,
    SFTPFileSystem: FakeRemoteFs,
    FTPFileSystem: FakeRemoteFs,
  };
});

import { createRemoteIfNoneExist } from '../remoteFs';
import { SFTPFileSystem } from '../fs';

const FakeRemoteFs = SFTPFileSystem as any;

// One pool entry per test, so give every test a distinct host
let hostCounter = 0;
function connectOption(overrides: Record<string, any> = {}) {
  hostCounter += 1;
  return {
    protocol: 'sftp',
    host: `host-${hostCounter}.example.com`,
    port: 22,
    username: 'bob',
    connectTimeout: 10 * 1000,
    remoteTimeOffsetInHours: 0,
    ...overrides,
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let now = 1_000_000;
let nowSpy: jest.SpyInstance;

beforeEach(() => {
  FakeRemoteFs.instances.length = 0;
  FakeRemoteFs.connectGate = Promise.resolve();
  now = 1_000_000;
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  nowSpy.mockRestore();
  jest.useRealTimers();
});

describe('concurrent acquisition', () => {
  test('three callers hitting a wedged connection share one probe and one reconnect', async () => {
    // The #50 case: three files uploaded at once run three commands, each of
    // which asks the pool for a connection. Before this was serialized, all
    // three probed, all three timed out, all three invalidated, and all three
    // opened a connection that overwrote the last.
    jest.useFakeTimers({ doNotFake: ['Date'] });

    const option = connectOption({ connectTimeout: 3000 });
    const policy = { idleTimeout: 5 * 60 * 1000 };

    const first: any = await createRemoteIfNoneExist(option, policy);
    // the channel is wedged: the probe is written but never answered
    first.probeImpl = () => new Promise<void>(() => undefined);

    now += 6 * 60 * 1000;
    const all = Promise.all([
      createRemoteIfNoneExist(option, policy),
      createRemoteIfNoneExist(option, policy),
      createRemoteIfNoneExist(option, policy),
    ]);

    await jest.advanceTimersByTimeAsync(3000);
    const [a, b, c] = await all;

    expect(first.probeCount).toBe(1);
    // the original plus exactly one replacement
    expect(FakeRemoteFs.instances).toHaveLength(2);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).not.toBe(first);
    expect((a as any).connectCount).toBe(1);
    expect(first.ended).toBe(true);
  });

  test('concurrent first-time callers open one connection between them', async () => {
    const option = connectOption();
    const gate = deferred();
    FakeRemoteFs.connectGate = gate.promise;

    const all = Promise.all([
      createRemoteIfNoneExist(option),
      createRemoteIfNoneExist(option),
      createRemoteIfNoneExist(option),
    ]);

    gate.resolve();
    const [a, b, c] = await all;

    expect(FakeRemoteFs.instances).toHaveLength(1);
    expect((a as any).connectCount).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test('concurrent callers on a healthy connection all get it, unprobed', async () => {
    const option = connectOption();
    const policy = { idleTimeout: 5 * 60 * 1000 };

    const first: any = await createRemoteIfNoneExist(option, policy);

    // well inside the idle window
    now += 60 * 1000;
    const [a, b, c] = await Promise.all([
      createRemoteIfNoneExist(option, policy),
      createRemoteIfNoneExist(option, policy),
      createRemoteIfNoneExist(option, policy),
    ]);

    expect(first.probeCount).toBe(0);
    expect(FakeRemoteFs.instances).toHaveLength(1);
    expect([a, b, c]).toEqual([first, first, first]);
  });

  test('a failed acquisition does not wedge the pool', async () => {
    const option = connectOption();
    const gate = deferred();
    FakeRemoteFs.connectGate = gate.promise;

    const failing = createRemoteIfNoneExist(option);
    gate.reject(new Error('connection refused'));
    await expect(failing).rejects.toThrow('connection refused');

    // the gate must have been released, or every later command inherits the
    // same rejected promise for the life of the window
    FakeRemoteFs.connectGate = Promise.resolve();
    const second = await createRemoteIfNoneExist(option);

    expect(second).toBe(FakeRemoteFs.instances[1]);
    expect(FakeRemoteFs.instances).toHaveLength(2);
  });
});

describe('a replaced connection', () => {
  test('cannot invalidate the connection that replaced it', async () => {
    const option = connectOption();
    const policy = { idleTimeout: 5 * 60 * 1000 };

    const first: any = await createRemoteIfNoneExist(option, policy);
    first.probeImpl = () => Promise.reject(new Error('not connected'));

    now += 6 * 60 * 1000;
    const second: any = await createRemoteIfNoneExist(option, policy);
    expect(second).not.toBe(first);

    // the orphaned socket finally unwinds and emits, as ssh2 always does
    second.ended = false;
    first.emitDisconnect('close');

    expect(second.ended).toBe(false);
    // and the live connection is still the one the pool hands out
    expect(await createRemoteIfNoneExist(option, policy)).toBe(second);
  });

  test('an error from a replaced connection does not drop the live one', async () => {
    const option = connectOption();
    const policy = { idleTimeout: 5 * 60 * 1000 };

    const first: any = await createRemoteIfNoneExist(option, policy);
    first.probeImpl = () => Promise.reject(new Error('not connected'));

    now += 6 * 60 * 1000;
    const second: any = await createRemoteIfNoneExist(option, policy);

    second.ended = false;
    first.emitDisconnect('error', new Error('read ECONNRESET'));

    expect(second.ended).toBe(false);
    expect(await createRemoteIfNoneExist(option, policy)).toBe(second);
  });

  test('the live connection still invalidates itself normally', async () => {
    const option = connectOption();

    const fs: any = await createRemoteIfNoneExist(option);
    fs.emitDisconnect('close');

    expect(fs.ended).toBe(true);
    // dropped, so the next caller gets a fresh one
    const next = await createRemoteIfNoneExist(option);
    expect(next).not.toBe(fs);
    expect(FakeRemoteFs.instances).toHaveLength(2);
  });
});
