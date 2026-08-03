jest.mock('fs');

import { vol } from 'memfs';
import app from '../../app';
import FileService, { FileServiceConfig } from '../fileService';

const baseConfig = {
  name: 'test',
  context: '/ws',
  protocol: 'sftp',
  host: 'example.com',
  port: 22,
  username: 'bob',
  remotePath: '/var/www',
  watcher: { files: false, autoUpload: false, autoDelete: false },
} as any as FileServiceConfig;

function createService(config: Partial<FileServiceConfig> = {}): FileService {
  return new FileService('/ws', '/ws', { ...baseConfig, ...config } as FileServiceConfig);
}

beforeEach(() => {
  vol.reset();
  app.fsCache.clear();
  app.state.profile = null;
});

describe('FileService config cache', () => {
  test('getConfig returns the memoized config until it is invalidated', () => {
    const service = createService();

    const first = service.getConfig();
    expect(service.getConfig()).toBe(first);

    service.invalidateConfigCache();

    const afterInvalidate = service.getConfig();
    expect(afterInvalidate).not.toBe(first);
    expect(afterInvalidate.host).toBe(first.host);
    expect(afterInvalidate.remotePath).toBe(first.remotePath);
  });

  test('setConfigValue invalidates the cache so the new value is visible', () => {
    const service = createService({ uploadOnSave: false } as Partial<FileServiceConfig>);

    expect(service.getConfig().uploadOnSave).toBe(false);
    service.setConfigValue('uploadOnSave', true);
    expect(service.getConfig().uploadOnSave).toBe(true);
  });

  test('a failing validation throws on every call and is never cached', () => {
    const service = createService();
    const validator = jest.fn(() => ({ message: 'host is required' }));
    service.setConfigValidator(validator);

    expect(() => service.getConfig()).toThrow(/host is required/);
    expect(() => service.getConfig()).toThrow(/host is required/);
    expect(validator).toHaveBeenCalledTimes(2);
  });

  test('profiles are cached separately', () => {
    const service = createService({
      profiles: {
        dev: { remotePath: '/var/dev' },
        prod: { remotePath: '/var/prod' },
      },
    } as any);

    const dev = service.getConfig('dev');
    const prod = service.getConfig('prod');

    expect(dev.remotePath).toBe('/var/dev');
    expect(prod.remotePath).toBe('/var/prod');
    expect(service.getConfig('dev')).toBe(dev);
  });

  test('invalidating drops the cached ignore file so edits are picked up', () => {
    vol.fromJSON({ '/ws/.sftpignore': 'foo' });
    const service = createService({ ignoreFile: '.sftpignore' } as Partial<FileServiceConfig>);

    const ignore = service.getConfig().ignore!;
    expect(ignore('/ws/foo')).toBe(true);
    expect(ignore('/ws/bar')).toBe(false);

    expect(app.fsCache.has('/ws/.sftpignore')).toBe(true);

    vol.fromJSON({ '/ws/.sftpignore': 'bar' });
    service.invalidateConfigCache();
    expect(app.fsCache.has('/ws/.sftpignore')).toBe(false);

    const reloaded = service.getConfig().ignore!;
    expect(reloaded('/ws/foo')).toBe(false);
    expect(reloaded('/ws/bar')).toBe(true);
  });
});
