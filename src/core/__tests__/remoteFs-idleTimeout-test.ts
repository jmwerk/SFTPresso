jest.mock('fs');

// A stand-in for the real SFTP/FTP filesystems: connecting always succeeds and
// the probe is driven by the test.
jest.mock('../fs', () => {
  class FakeRemoteFs {
    static instances: FakeRemoteFs[] = [];

    connectCount = 0;
    probeCount = 0;
    ended = false;
    probeImpl: () => Promise<void> = () => Promise.resolve();

    constructor(public pathResolver: any, public option: any) {
      FakeRemoteFs.instances.push(this);
    }

    connect() {
      this.connectCount += 1;
      return Promise.resolve();
    }

    onDisconnected() {
      /* the pool registers a callback it never fires in these tests */
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
    // localFs constructs one of these at import time
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

// Each test needs its own entry in the module-level pool, so give every one a
// distinct host rather than reaching into the table.
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

let now = 1_000_000;
let nowSpy: jest.SpyInstance;

beforeEach(() => {
  FakeRemoteFs.instances.length = 0;
  now = 1_000_000;
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  nowSpy.mockRestore();
  jest.useRealTimers();
});

describe('idleTimeout', () => {
  test('reuses the pooled connection without probing when it is disabled', async () => {
    const option = connectOption();

    const first = await createRemoteIfNoneExist(option);
    now += 60 * 60 * 1000;
    const second = await createRemoteIfNoneExist(option);

    expect(second).toBe(first);
    expect(FakeRemoteFs.instances).toHaveLength(1);
    expect((first as any).probeCount).toBe(0);
  });

  test('does not probe until the connection has been idle past the threshold', async () => {
    const option = connectOption();
    const policy = { idleTimeout: 5 * 60 * 1000 };

    const first = await createRemoteIfNoneExist(option, policy);
    now += 4 * 60 * 1000;
    const second = await createRemoteIfNoneExist(option, policy);

    expect(second).toBe(first);
    expect((first as any).probeCount).toBe(0);
  });

  test('probes past the threshold and keeps the connection when the server answers', async () => {
    const option = connectOption();
    const policy = { idleTimeout: 5 * 60 * 1000 };

    const first = await createRemoteIfNoneExist(option, policy);
    now += 6 * 60 * 1000;
    const second = await createRemoteIfNoneExist(option, policy);

    expect(second).toBe(first);
    expect((first as any).probeCount).toBe(1);
    expect((first as any).ended).toBe(false);
    // still the one connection -- a live remote is never reconnected
    expect(FakeRemoteFs.instances).toHaveLength(1);
  });

  test('reconnects when the probe is refused', async () => {
    const option = connectOption();
    const policy = { idleTimeout: 5 * 60 * 1000 };

    const first: any = await createRemoteIfNoneExist(option, policy);
    first.probeImpl = () => Promise.reject(new Error('not connected'));

    now += 6 * 60 * 1000;
    const second = await createRemoteIfNoneExist(option, policy);

    expect(second).not.toBe(first);
    expect(first.ended).toBe(true);
    expect(FakeRemoteFs.instances).toHaveLength(2);
    expect((second as any).connectCount).toBe(1);
  });

  test('reconnects when a half-open connection never answers the probe', async () => {
    // leave Date alone: the idle window is driven by the Date.now spy above,
    // and letting fake timers own the clock too would freeze it at 0 elapsed
    jest.useFakeTimers({ doNotFake: ['Date'] });

    const option = connectOption({ connectTimeout: 3000 });
    const policy = { idleTimeout: 5 * 60 * 1000 };

    const first: any = await createRemoteIfNoneExist(option, policy);
    // the case that hangs in the wild: no response, no error, nothing
    first.probeImpl = () => new Promise<void>(() => undefined);

    now += 6 * 60 * 1000;
    const pending = createRemoteIfNoneExist(option, policy);

    await jest.advanceTimersByTimeAsync(3000);
    const second = await pending;

    expect(second).not.toBe(first);
    expect(first.ended).toBe(true);
    expect(FakeRemoteFs.instances).toHaveLength(2);
  });

  test('the idle window is measured from the last use, not the first connect', async () => {
    const option = connectOption();
    const policy = { idleTimeout: 5 * 60 * 1000 };

    const first: any = await createRemoteIfNoneExist(option, policy);

    // a steady trickle of work, each well inside the window
    for (let i = 0; i < 5; i += 1) {
      now += 4 * 60 * 1000;
      await createRemoteIfNoneExist(option, policy);
    }

    // 20 minutes have passed in total, but it was never idle for five
    expect(first.probeCount).toBe(0);
    expect(FakeRemoteFs.instances).toHaveLength(1);
  });
});
