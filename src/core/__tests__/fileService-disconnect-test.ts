jest.mock('fs');

// Same stand-in as the other pool tests: connecting always succeeds, and every
// instance records whether it was ended.
jest.mock('../fs', () => {
  class FakeRemoteFs {
    static instances: FakeRemoteFs[] = [];

    ended = false;

    constructor(public pathResolver: any, public option: any) {
      FakeRemoteFs.instances.push(this);
    }

    connect() {
      return Promise.resolve();
    }

    onDisconnected() {
      /* never fired here */
    }

    end() {
      this.ended = true;
    }

    probe() {
      return Promise.resolve();
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

import { vol } from 'memfs';
import app from '../../app';
import { SFTPFileSystem } from '../fs';
import FileService, { FileServiceConfig } from '../fileService';

const FakeRemoteFs = SFTPFileSystem as any;

// Every test needs its own entries in the module-level pool, so give each one a
// distinct host rather than reaching into the table.
let hostCounter = 0;

function createService(extra: Partial<FileServiceConfig> = {}) {
  hostCounter += 1;
  const host = `host-${hostCounter}.example.com`;

  return new FileService('/ws', '/ws', {
    name: 'test',
    context: '/ws',
    protocol: 'sftp',
    host,
    port: 22,
    username: 'bob',
    remotePath: '/var/www',
    connectTimeout: 10 * 1000,
    watcher: { files: false, autoUpload: false, autoDelete: false },
    ...extra,
  } as any as FileServiceConfig);
}

beforeEach(() => {
  vol.reset();
  app.fsCache.clear();
  app.state.profile = null;
  FakeRemoteFs.instances.length = 0;
});

describe('FileService.disconnect', () => {
  test('closes every profile, not just the active one', async () => {
    const service = createService({
      profiles: {
        dev: { remotePath: '/var/dev', username: 'dev-user' },
        prod: { remotePath: '/var/prod', username: 'prod-user' },
      },
    } as any);

    // use two of the three profiles, then switch to the third
    await service.getRemoteFileSystem(service.getConfig('dev'));
    await service.getRemoteFileSystem(service.getConfig('prod'));
    expect(FakeRemoteFs.instances).toHaveLength(2);

    app.state.profile = 'prod';
    const closed = service.disconnect();

    expect(closed).toBe(2);
    expect(FakeRemoteFs.instances.every(fs => fs.ended)).toBe(true);
  });

  test('a second disconnect finds nothing left to close', async () => {
    const service = createService({
      profiles: { dev: { username: 'dev-user' } },
    } as any);

    await service.getRemoteFileSystem(service.getConfig('dev'));

    expect(service.disconnect()).toBe(1);
    expect(service.disconnect()).toBe(0);
  });

  test('reports zero when nothing was ever connected', () => {
    const service = createService();

    expect(service.disconnect()).toBe(0);
    expect(FakeRemoteFs.instances).toHaveLength(0);
  });

  test('a profile that no longer validates does not block the others', async () => {
    const service = createService({
      profiles: {
        dev: { username: 'dev-user' },
        broken: { username: 'broken-user' },
      },
    } as any);

    await service.getRemoteFileSystem(service.getConfig('dev'));
    await service.getRemoteFileSystem(service.getConfig('broken'));

    service.setConfigValidator(config =>
      config.username === 'broken-user' ? { message: 'nope' } : undefined
    );
    service.invalidateConfigCache();

    // the broken one is unreachable, but dev must still be closed
    expect(service.disconnect()).toBe(1);
  });

  test('the profile-less config is closed too', async () => {
    const service = createService();

    await service.getRemoteFileSystem(service.getConfig());

    expect(service.disconnect()).toBe(1);
    expect(FakeRemoteFs.instances[0].ended).toBe(true);
  });
});
