jest.mock('fs');

import * as path from 'path';
import { vol } from 'memfs';
import app from '../../app';
import FileService, {
  FileServiceConfig,
  WatcherConfig,
  WatcherService,
} from '../fileService';

interface CreateCall {
  base: string;
  watcher: WatcherConfig;
  ignore?: ((fsPath: string) => boolean) | null;
}

function fakeWatcherService() {
  const created: CreateCall[] = [];
  const disposed: string[] = [];

  const service: WatcherService = {
    create(base, watcher, ignore) {
      created.push({ base, watcher, ignore });
    },
    dispose(base) {
      disposed.push(base);
    },
  };

  return { service, created, disposed };
}

const watching = { files: '**/*', autoUpload: true, autoDelete: true };
const notWatching = { files: '**/*', autoUpload: false, autoDelete: false };

// The ignore function keys off whether a path sits under baseDir, so the base
// has to look like a real local path on whichever platform the tests run on.
const BASE = path.resolve('/ws');
const local = (...parts: string[]) => path.join(BASE, ...parts);

function createService(extra: Partial<FileServiceConfig> = {}): FileService {
  return new FileService(BASE, BASE, {
    name: 'test',
    context: BASE,
    protocol: 'sftp',
    host: 'example.com',
    port: 22,
    username: 'bob',
    remotePath: '/var/www',
    watcher: watching,
    ...extra,
  } as any as FileServiceConfig);
}

beforeEach(() => {
  vol.reset();
  app.fsCache.clear();
  app.state.profile = null;
});

describe('watcher config resolution', () => {
  test('a profile that overrides watcher is honoured', () => {
    const service = createService({
      profiles: {
        dev: {},
        prod: { watcher: notWatching },
      },
    } as any);

    const { service: watcherService, created } = fakeWatcherService();
    service.setWatcherService(watcherService);

    expect(created).toHaveLength(1);
    expect(created[0].watcher).toEqual(watching);

    // switching profile is what invalidates the config; the watcher has to be
    // rebuilt from it, or "turn autoUpload off for production" does nothing
    app.state.profile = 'prod';
    service.invalidateConfigCache();
    service.reloadWatcher();

    expect(created).toHaveLength(2);
    expect(created[1].watcher).toEqual(notWatching);

    app.state.profile = 'dev';
    service.invalidateConfigCache();
    service.reloadWatcher();

    expect(created[2].watcher).toEqual(watching);
  });

  test('reloading disposes the old watcher first', () => {
    const service = createService();
    const { service: watcherService, disposed } = fakeWatcherService();
    service.setWatcherService(watcherService);

    service.reloadWatcher();

    expect(disposed).toEqual([BASE]);
  });

  test('the resolved ignore function is handed to the watcher', () => {
    const service = createService({ ignore: ['*.log'] } as any);
    const { service: watcherService, created } = fakeWatcherService();
    service.setWatcherService(watcherService);

    const ignore = created[0].ignore!;
    expect(typeof ignore).toBe('function');
    expect(ignore(local('debug.log'))).toBe(true);
    expect(ignore(local('a.ts'))).toBe(false);
  });

  test('a profile can add ignore rules the watcher then applies', () => {
    const service = createService({
      ignore: ['*.log'],
      profiles: { prod: { ignore: ['*.tmp'] } },
    } as any);

    const { service: watcherService, created } = fakeWatcherService();
    service.setWatcherService(watcherService);
    expect(created[0].ignore!(local('scratch.tmp'))).toBe(false);

    app.state.profile = 'prod';
    service.invalidateConfigCache();
    service.reloadWatcher();

    const ignore = created[1].ignore!;
    expect(ignore(local('scratch.tmp'))).toBe(true);
    expect(ignore(local('debug.log'))).toBe(true);
  });

  test('setConfigValue rebuilds the watcher so a new ignore rule takes hold', () => {
    const service = createService({ ignore: ['*.log'] } as any);
    const { service: watcherService, created } = fakeWatcherService();
    service.setWatcherService(watcherService);

    service.setConfigValue('ignore', ['*.log', 'secret/**']);

    expect(created).toHaveLength(2);
    expect(created[1].ignore!(local('secret', 'keys.txt'))).toBe(true);
  });

  test('an unresolvable config still yields a watcher, from the raw config', () => {
    const service = createService();
    service.setConfigValidator(() => ({ message: 'nope' }));

    const { service: watcherService, created } = fakeWatcherService();
    service.setWatcherService(watcherService);

    expect(created).toHaveLength(1);
    expect(created[0].watcher).toEqual(watching);
    expect(created[0].ignore).toBeNull();
  });
});
