// Drives RemoteFileSystemProvider against an in-memory stand-in for a remote FileSystem.
// UResource is real so URIs round-trip exactly as the Remote Explorer builds them.
jest.mock('vscode', () => {
  const { URI } = jest.requireActual('vscode-uri');

  class EventEmitter {
    private listeners: Array<(e: any) => void> = [];
    event = (listener: (e: any) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(e?: any) {
      this.listeners.forEach(listener => listener(e));
    }
  }

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

  return {
    Uri: URI,
    EventEmitter,
    FileSystemError,
    Disposable: class Disposable {
      constructor(public dispose: () => void) {}
    },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    FilePermission: { Readonly: 1 },
  };
});

jest.mock('../../../helper', () => ({ toLocalPath: jest.fn(), toRemotePath: jest.fn() }));

jest.mock('../../../core', () => ({
  FileType: jest.requireActual('../../../core/fs/fileSystem').FileType,
}));

jest.mock('../../../logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn() } }));

const extSetting: { openRemoteFilesReadOnly?: boolean } = {};
jest.mock('../../ext', () => ({ getExtensionSetting: () => extSetting }));

import * as vscode from 'vscode';
import { Readable } from 'stream';
import { FileType } from '../../../core';
import UResource from '../../../core/uResource';
import RemoteFileSystemProvider, { remotePathOf } from '../remoteFileSystemProvider';

type Entry = { type: FileType; data?: Buffer; mode: number; mtime: number; target?: string };

function notFound() {
  return Object.assign(new Error('No such file'), { code: 2 });
}

function fakeRemoteFs(files: Record<string, Entry>) {
  const resolve = (path: string): Entry => {
    const entry = files[path];
    if (!entry) throw notFound();
    return entry.type === FileType.SymbolicLink ? resolve(entry.target!) : entry;
  };
  const fs = {
    puts: [] as Array<{ path: string; mode?: number }>,
    lstat: async (path: string) => {
      const entry = files[path];
      if (!entry) throw notFound();
      return { type: entry.type, mode: entry.mode, size: entry.data ? entry.data.length : 0, mtime: entry.mtime, atime: 0 };
    },
    open: async (path: string) => {
      const entry = resolve(path);
      if (entry.type === FileType.Directory) throw new Error('is a directory');
      return path;
    },
    fstat: async (path: string) => {
      const entry = resolve(path);
      return { type: entry.type, mode: entry.mode, size: entry.data!.length, mtime: entry.mtime, atime: 0 };
    },
    close: async () => {},
    list: async (dir: string) =>
      Object.keys(files)
        .filter(path => path.startsWith(dir + '/') && !path.slice(dir.length + 1).includes('/'))
        .map(path => ({ fspath: path, name: path.slice(dir.length + 1), type: files[path].type })),
    readFile: async (path: string) => resolve(path).data!,
    put: async (input: Readable, path: string, option?: { mode?: number }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input) chunks.push(chunk);
      fs.puts.push({ path, mode: option && option.mode });
      const link = files[path] && files[path].type === FileType.SymbolicLink ? files[path].target! : path;
      const previous = files[link];
      files[link] = { type: FileType.File, data: Buffer.concat(chunks), mode: previous ? previous.mode : 0o644, mtime: 2000 };
    },
    unlink: async (path: string) => {
      if (!files[path]) throw notFound();
      delete files[path];
    },
    rename: jest.fn(async (from: string, to: string) => {
      files[to] = files[from];
      delete files[from];
    }),
    renameAtomic: jest.fn(async (from: string, to: string) => {
      files[to] = files[from];
      delete files[from];
    }),
    mkdir: async (path: string) => {
      files[path] = { type: FileType.Directory, mode: 0o755, mtime: 0 };
    },
    rmdir: jest.fn(async (path: string) => {
      delete files[path];
    }),
  };
  return fs;
}

const HOST = { host: 'example.com', port: 2222 };

function setup(files: Record<string, Entry>, configOverrides: any = {}) {
  const remoteFs = fakeRemoteFs(files);
  const config = { ...HOST, remotePath: '/srv', ...configOverrides };
  const root: any = {
    resource: UResource.makeResource({ remote: HOST, fsPath: '/srv', remoteId: 1 }),
    isDirectory: true,
    explorerContext: {
      config,
      fileService: { name: 'Live', getRemoteFileSystem: async () => remoteFs },
    },
  };
  const provider = new RemoteFileSystemProvider(() => root);
  const events: vscode.FileChangeEvent[] = [];
  provider.onDidChangeFile(batch => events.push(...batch));
  return { provider, remoteFs, files, root, events };
}

const uriOf = (fsPath: string, remote = HOST) =>
  UResource.makeResource({ remote, fsPath, remoteId: 1 }).uri;

const file = (text: string, mode = 0o640): Entry => ({
  type: FileType.File,
  data: Buffer.from(text),
  mode,
  mtime: 1000,
});

const CREATE = { create: true, overwrite: true };

beforeEach(() => {
  delete extSetting.openRemoteFilesReadOnly;
});

describe('RemoteFileSystemProvider', () => {
  test('reads a remote file and reports its mtime and size for conflict detection', async () => {
    const { provider } = setup({ '/srv/index.php': file('<?php') });

    await expect(provider.readFile(uriOf('/srv/index.php'))).resolves.toEqual(Buffer.from('<?php'));
    await expect(provider.stat(uriOf('/srv/index.php'))).resolves.toMatchObject({
      type: vscode.FileType.File,
      mtime: 1000,
      size: 5,
    });
  });

  test('a missing file is FileNotFound, so VS Code can offer to create it', async () => {
    const { provider } = setup({});

    await expect(provider.stat(uriOf('/srv/nope.txt'))).rejects.toMatchObject({ code: 'FileNotFound' });
  });

  test('saving writes the file in place and keeps its permissions', async () => {
    const { provider, remoteFs, files, events } = setup({ '/srv/a.txt': file('old', 0o100640) });
    const uri = uriOf('/srv/a.txt');

    await provider.writeFile(uri, Buffer.from('new'), CREATE);

    expect(files['/srv/a.txt'].data!.toString()).toBe('new');
    expect(remoteFs.puts).toEqual([{ path: '/srv/a.txt', mode: 0o640 }]);
    expect(events).toEqual([{ type: vscode.FileChangeType.Changed, uri }]);
  });

  test('filePerm from the config wins over the existing mode', async () => {
    const { provider, remoteFs } = setup({ '/srv/a.txt': file('old') }, { filePerm: '664' });

    await provider.writeFile(uriOf('/srv/a.txt'), Buffer.from('new'), CREATE);

    expect(remoteFs.puts[0].mode).toBe(0o664);
  });

  test('an empty save truncates the file', async () => {
    const { provider, files } = setup({ '/srv/a.txt': file('old') });

    await provider.writeFile(uriOf('/srv/a.txt'), new Uint8Array(0), CREATE);

    expect(files['/srv/a.txt'].data!.length).toBe(0);
  });

  test('useTempFile uploads beside the file and renames it over', async () => {
    const { provider, remoteFs, files } = setup({ '/srv/a.txt': file('old') }, { useTempFile: true });

    await provider.writeFile(uriOf('/srv/a.txt'), Buffer.from('new'), CREATE);

    expect(remoteFs.puts[0].path).toBe('/srv/a.txt.new');
    expect(remoteFs.rename).toHaveBeenCalledWith('/srv/a.txt.new', '/srv/a.txt');
    expect(files['/srv/a.txt'].data!.toString()).toBe('new');
    expect(files['/srv/a.txt.new']).toBeUndefined();
  });

  test('useTempFile with openSsh uses the atomic rename', async () => {
    const { provider, remoteFs } = setup(
      { '/srv/a.txt': file('old') },
      { useTempFile: true, openSsh: true }
    );

    await provider.writeFile(uriOf('/srv/a.txt'), Buffer.from('new'), CREATE);

    expect(remoteFs.renameAtomic).toHaveBeenCalledWith('/srv/a.txt.new', '/srv/a.txt');
  });

  test('a symlinked file is written through the link, never replaced by a temp file', async () => {
    const { provider, files } = setup(
      {
        '/srv/real.php': file('old'),
        '/srv/link.php': { type: FileType.SymbolicLink, mode: 0o777, mtime: 0, target: '/srv/real.php' },
      },
      { useTempFile: true }
    );

    await expect(provider.stat(uriOf('/srv/link.php'))).resolves.toMatchObject({
      type: vscode.FileType.SymbolicLink | vscode.FileType.File,
      size: 3,
    });
    await provider.writeFile(uriOf('/srv/link.php'), Buffer.from('new'), CREATE);

    expect(files['/srv/link.php'].type).toBe(FileType.SymbolicLink);
    expect(files['/srv/real.php'].data!.toString()).toBe('new');
  });

  test('a new file is reported as created', async () => {
    const { provider, files, events } = setup({});
    const uri = uriOf('/srv/new.txt');

    await provider.writeFile(uri, Buffer.from('x'), CREATE);

    expect(files['/srv/new.txt']).toBeDefined();
    expect(events).toEqual([{ type: vscode.FileChangeType.Created, uri }]);
  });

  test('honors create/overwrite and refuses to write over a directory', async () => {
    const { provider } = setup({
      '/srv/a.txt': file('old'),
      '/srv/dir': { type: FileType.Directory, mode: 0o755, mtime: 0 },
    });

    await expect(
      provider.writeFile(uriOf('/srv/missing.txt'), Buffer.from('x'), { create: false, overwrite: true })
    ).rejects.toMatchObject({ code: 'FileNotFound' });
    await expect(
      provider.writeFile(uriOf('/srv/a.txt'), Buffer.from('x'), { create: true, overwrite: false })
    ).rejects.toMatchObject({ code: 'FileExists' });
    await expect(provider.writeFile(uriOf('/srv/dir'), Buffer.from('x'), CREATE)).rejects.toMatchObject({
      code: 'FileIsADirectory',
    });
  });

  test('refuses a file opened from a server the config no longer points at', async () => {
    const { provider, files } = setup({ '/srv/a.txt': file('live') });
    // opened while the "Staging" profile pointed the same config at another port
    const stagingUri = uriOf('/srv/a.txt', { host: 'example.com', port: 15526 });

    await expect(provider.readFile(stagingUri)).rejects.toMatchObject({ code: 'Unavailable' });
    await expect(provider.writeFile(stagingUri, Buffer.from('x'), CREATE)).rejects.toMatchObject({
      code: 'Unavailable',
    });
    expect(files['/srv/a.txt'].data!.toString()).toBe('live');
  });

  test('openRemoteFilesReadOnly marks files read-only and blocks every write', async () => {
    extSetting.openRemoteFilesReadOnly = true;
    const { provider, files } = setup({ '/srv/a.txt': file('old') });
    const uri = uriOf('/srv/a.txt');

    await expect(provider.stat(uri)).resolves.toMatchObject({ permissions: vscode.FilePermission.Readonly });
    await expect(provider.writeFile(uri, Buffer.from('x'), CREATE)).rejects.toMatchObject({
      code: 'NoPermissions',
    });
    await expect(provider.delete(uri, { recursive: false })).rejects.toMatchObject({ code: 'NoPermissions' });
    expect(files['/srv/a.txt'].data!.toString()).toBe('old');
  });

  test('rename never removes a directory in the way', async () => {
    const { provider, files } = setup({
      '/srv/a.txt': file('a'),
      '/srv/b.txt': file('b'),
      '/srv/dir': { type: FileType.Directory, mode: 0o755, mtime: 0 },
    });

    await provider.rename(uriOf('/srv/a.txt'), uriOf('/srv/b.txt'), { overwrite: true });
    expect(files['/srv/b.txt'].data!.toString()).toBe('a');

    await expect(
      provider.rename(uriOf('/srv/b.txt'), uriOf('/srv/dir'), { overwrite: true })
    ).rejects.toMatchObject({ code: 'FileExists' });
    expect(files['/srv/dir']).toBeDefined();
  });

  test('delete removes files and directories', async () => {
    const { provider, remoteFs, files } = setup({
      '/srv/a.txt': file('a'),
      '/srv/dir': { type: FileType.Directory, mode: 0o755, mtime: 0 },
    });

    await provider.delete(uriOf('/srv/a.txt'), { recursive: false });
    await provider.delete(uriOf('/srv/dir'), { recursive: true });

    expect(files).toEqual({});
    expect(remoteFs.rmdir).toHaveBeenCalledWith('/srv/dir', true);
  });

  test('lists a directory', async () => {
    const { provider } = setup({
      '/srv/a.txt': file('a'),
      '/srv/dir': { type: FileType.Directory, mode: 0o755, mtime: 0 },
    });

    await expect(provider.readDirectory(uriOf('/srv'))).resolves.toEqual([
      ['a.txt', vscode.FileType.File],
      ['dir', vscode.FileType.Directory],
    ]);
  });
});

describe('remotePathOf', () => {
  test('uses the query fsPath, which keeps relative remote paths intact', () => {
    expect(remotePathOf(uriOf('public_html/index.php'))).toBe('public_html/index.php');
  });

  test('falls back to the uri path when VS Code derived a child uri with a stale query', () => {
    // what Uri.joinPath does: a new path, the parent's query
    const parent = uriOf('/srv');
    const child = parent.with({ path: parent.path + '/a.txt' });
    expect(remotePathOf(child)).toBe('/srv/a.txt');
  });
});
