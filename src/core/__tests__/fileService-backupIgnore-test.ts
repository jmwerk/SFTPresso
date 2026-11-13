jest.mock('fs');

import * as path from 'path';
import { vol } from 'memfs';
import app from '../../app';
import FileService, { FileServiceConfig } from '../fileService';

const BASE = path.resolve('/ws');
const local = (...parts: string[]) => path.join(BASE, ...parts);

function ignoreFor(extra: Partial<FileServiceConfig>) {
  const service = new FileService(BASE, BASE, {
    name: 'test',
    context: BASE,
    protocol: 'sftp',
    host: 'example.com',
    port: 22,
    username: 'bob',
    remotePath: '/var/www',
    ...extra,
  } as any as FileServiceConfig);
  return service.getConfig().ignore;
}

beforeEach(() => {
  vol.reset();
  app.fsCache.clear();
  app.state.profile = null;
});

describe('backup folder is never transferred', () => {
  test('the default folder is ignored, the rest is not', () => {
    const ignore = ignoreFor({ backup: true } as any)!;
    expect(ignore(local('.sftpresso-backup', 'example.com', 'a.20261112-153000-000.php'))).toBe(true);
    expect(ignore(local('a.php'))).toBe(false);
  });

  test('a custom folder is ignored alongside the configured patterns, without changing them', () => {
    const patterns = ['node_modules'];
    const ignore = ignoreFor({ ignore: patterns, backup: { dir: 'tmp/bak' } } as any)!;
    expect(ignore(local('tmp', 'bak', 'x.php'))).toBe(true);
    expect(ignore(local('tmp', 'other.php'))).toBe(false);
    expect(ignore(local('node_modules', 'x.js'))).toBe(true);
    expect(patterns).toEqual(['node_modules']);
  });

  test('a folder outside the context adds nothing', () => {
    expect(ignoreFor({ backup: { dir: '../bak' } } as any)).toBeNull();
  });
});
