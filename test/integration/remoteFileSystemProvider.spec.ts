import { Readable } from 'stream';

/**
 * Editing a remote file in place, against real servers. The unit tests cover the
 * create/overwrite rules against a fake; only a real server shows that a save truncates,
 * keeps the file's mode, survives the temp-file rename, and that a missing file reads as
 * missing on each protocol.
 */
jest.mock('vscode', () => {
  const base = jest.requireActual('../../__mocks__/vscode.js');

  class FileSystemError extends Error {
    constructor(message: string, public code: string) {
      super(message);
    }
    static FileNotFound = (m?: any) => new FileSystemError(String(m), 'FileNotFound');
    static FileExists = (m?: any) => new FileSystemError(String(m), 'FileExists');
    static FileIsADirectory = (m?: any) => new FileSystemError(String(m), 'FileIsADirectory');
    static NoPermissions = (m?: any) => new FileSystemError(String(m), 'NoPermissions');
    static Unavailable = (m?: any) => new FileSystemError(String(m), 'Unavailable');
  }

  const overrides = {
    Uri: jest.requireActual('vscode-uri').URI,
    FileSystemError,
    EventEmitter: class EventEmitter {
      event = () => ({ dispose() {} });
      fire() {}
    },
    Disposable: class Disposable {
      constructor(public dispose: () => void) {}
    },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    FilePermission: { Readonly: 1 },
  };
  return new Proxy(base, { get: (target, key) => (key in overrides ? overrides[key] : target[key]) });
});

jest.mock('../../src/modules/ext', () => ({ getExtensionSetting: () => ({}) }));

import upath from '../../src/core/upath';
import UResource from '../../src/core/uResource';
import FileSystem from '../../src/core/fs/fileSystem';
import RemoteFileSystemProvider from '../../src/modules/remoteExplorer/remoteFileSystemProvider';
import { connectSftp, uniqueDir as uniqueSshDir, SSH_HOST, SSH_PORT } from './sshHelpers';
import { connectFs, uniqueDir as uniqueFtpDir, VSFTPD } from './helpers';

const CREATE = { create: true, overwrite: true };

interface Server {
  name: string;
  host: string;
  port: number;
  connect: () => Promise<FileSystem & { end(): void }>;
  dir: () => string;
  modes: boolean;
}

const SERVERS: Server[] = [
  { name: 'OpenSSH (SFTP)', host: SSH_HOST, port: SSH_PORT, connect: () => connectSftp(), dir: uniqueSshDir, modes: true },
  { name: VSFTPD.name, host: VSFTPD.host, port: VSFTPD.port, connect: () => connectFs(VSFTPD), dir: () => uniqueFtpDir(VSFTPD), modes: false },
];

describe.each(SERVERS)('RemoteFileSystemProvider — $name', server => {
  let remoteFs: FileSystem & { end(): void };
  let dir: string;
  let config: any;

  const providerFor = (overrides: any = {}) => {
    config = { host: server.host, port: server.port, remotePath: dir, ...overrides };
    const root: any = {
      resource: UResource.makeResource({ remote: server, fsPath: dir, remoteId: 1 }),
      explorerContext: { config, fileService: { name: 'it', getRemoteFileSystem: async () => remoteFs } },
    };
    return new RemoteFileSystemProvider(() => root);
  };
  const uriOf = (name: string) =>
    UResource.makeResource({ remote: server, fsPath: upath.join(dir, name), remoteId: 1 }).uri;
  const read = async (name: string) => (await remoteFs.readFile(upath.join(dir, name))).toString();

  beforeAll(async () => {
    remoteFs = await server.connect();
    dir = server.dir();
    await remoteFs.ensureDir(dir);
  });

  afterAll(async () => {
    if (remoteFs) {
      await remoteFs.rmdir(dir, true).catch(() => undefined);
      remoteFs.end();
    }
  });

  test('a missing file reads as FileNotFound, then a save creates it', async () => {
    const provider = providerFor();

    await expect(provider.stat(uriOf('new.txt'))).rejects.toMatchObject({ code: 'FileNotFound' });
    await provider.writeFile(uriOf('new.txt'), Buffer.from('created'), CREATE);

    expect(await read('new.txt')).toBe('created');
  });

  test('a shorter save truncates instead of leaving the old tail', async () => {
    const provider = providerFor();
    await remoteFs.put(Readable.from([Buffer.from('a much longer original')]), upath.join(dir, 'short.txt'));

    await provider.writeFile(uriOf('short.txt'), Buffer.from('short'), CREATE);
    expect(await read('short.txt')).toBe('short');

    await provider.writeFile(uriOf('short.txt'), new Uint8Array(0), CREATE);
    expect(await read('short.txt')).toBe('');
  });

  test('useTempFile replaces the file and leaves no .new behind', async () => {
    const provider = providerFor({ useTempFile: true, openSsh: server.modes });
    await remoteFs.put(Readable.from([Buffer.from('old')]), upath.join(dir, 'temp.txt'));

    await provider.writeFile(uriOf('temp.txt'), Buffer.from('new'), CREATE);

    expect(await read('temp.txt')).toBe('new');
    await expect(remoteFs.lstat(upath.join(dir, 'temp.txt.new'))).rejects.toBeDefined();
  });

  if (server.modes) {
    test('a save keeps the file mode, with or without a temp file', async () => {
      const path = upath.join(dir, 'mode.sh');
      await remoteFs.put(Readable.from([Buffer.from('#!/bin/sh')]), path);
      await remoteFs.chmod(path, 0o750);

      await providerFor().writeFile(uriOf('mode.sh'), Buffer.from('#!/bin/sh\necho 1'), CREATE);
      expect((await remoteFs.lstat(path)).mode & 0o777).toBe(0o750);

      await providerFor({ useTempFile: true, openSsh: true }).writeFile(
        uriOf('mode.sh'),
        Buffer.from('#!/bin/sh\necho 2'),
        CREATE
      );
      expect((await remoteFs.lstat(path)).mode & 0o777).toBe(0o750);
    });
  }
});
