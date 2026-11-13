jest.mock('fs');

import * as path from 'path';
import { Readable } from 'stream';
import { vol } from 'memfs';
import {
  backupName,
  backupRemoteFile,
  backupStamp,
  createBackupHook,
  resolveBackup,
} from '../backup';
import { FileType } from '../fs/fileSystem';
import TransferTask, { TransferDirection } from '../transferTask';

const BASE = path.resolve('/ws');
const ROOT = path.join(BASE, '.sftpresso-backup', 'example.com');

function fakeRemote(files: Record<string, string>, dirs: string[] = []) {
  return {
    gets: 0,
    async lstat(fsPath: string) {
      if (dirs.includes(fsPath)) {
        return { type: FileType.Directory, mode: 0o755, size: 0, mtime: 0, atime: 0 };
      }
      if (!(fsPath in files)) {
        throw Object.assign(new Error('No such file'), { code: 2 });
      }
      return { type: FileType.File, mode: 0o644, size: files[fsPath].length, mtime: 0, atime: 0 };
    },
    async get(fsPath: string) {
      this.gets += 1;
      return Readable.from([Buffer.from(files[fsPath])]);
    },
  } as any;
}

const at = (ms: number) => new Date(2026, 10, 12, 15, 30, 0, ms);

beforeEach(() => {
  vol.reset();
  vol.mkdirSync(BASE, { recursive: true });
});

describe('resolveBackup', () => {
  test('off unless set', () => {
    expect(resolveBackup({ host: 'h' } as any, BASE)).toBeUndefined();
    expect(resolveBackup({ host: 'h', backup: false } as any, BASE)).toBeUndefined();
    expect(resolveBackup({ host: 'h', backup: null } as any, BASE)).toBeUndefined();
  });

  test('true uses the defaults, per server', () => {
    expect(resolveBackup({ host: 'example.com', backup: true } as any, BASE)).toEqual({
      root: ROOT,
      keep: 5,
    });
  });

  test('dir is relative to the context; keep 0 is allowed', () => {
    expect(resolveBackup({ host: 'h:x', backup: { dir: '../bak', keep: 0 } } as any, BASE)).toEqual(
      { root: path.resolve(BASE, '../bak', 'h_x'), keep: 0 }
    );
  });
});

describe('backupName', () => {
  test('puts the stamp before the extension', () => {
    const stamp = backupStamp(at(7));
    expect(stamp).toBe('20261112-153000-007');
    expect(backupName('functions.php', stamp)).toBe('functions.20261112-153000-007.php');
    expect(backupName('.htaccess', stamp)).toBe('.htaccess.20261112-153000-007');
    expect(backupName('a.tar.gz', stamp)).toBe('a.tar.20261112-153000-007.gz');
  });
});

describe('backupRemoteFile', () => {
  const option = { root: ROOT, keep: 2 };

  test('downloads the remote copy under its path relative to remotePath', async () => {
    const remote = fakeRemote({ '/www/wp/functions.php': 'old' });
    const dest = await backupRemoteFile(option, remote, '/www', '/www/wp/functions.php', at(1));

    expect(dest).toBe(path.join(ROOT, 'wp', 'functions.20261112-153000-001.php'));
    expect(vol.readFileSync(dest!, 'utf8')).toBe('old');
  });

  test('nothing to back up for a new file or a directory', async () => {
    const remote = fakeRemote({}, ['/www/dir']);
    expect(await backupRemoteFile(option, remote, '/www', '/www/new.php')).toBeUndefined();
    expect(await backupRemoteFile(option, remote, '/www', '/www/dir')).toBeUndefined();
    expect(remote.gets).toBe(0);
  });

  test('keeps only the newest `keep` backups of that file', async () => {
    const remote = fakeRemote({ '/www/a.php': 'x', '/www/b.php': 'y' });
    await backupRemoteFile(option, remote, '/www', '/www/b.php', at(0));
    for (let ms = 1; ms <= 4; ms++) {
      await backupRemoteFile(option, remote, '/www', '/www/a.php', at(ms));
    }

    expect(vol.readdirSync(ROOT).sort()).toEqual([
      'a.20261112-153000-003.php',
      'a.20261112-153000-004.php',
      'b.20261112-153000-000.php',
    ]);
  });

  test('keep 0 never prunes', async () => {
    const remote = fakeRemote({ '/www/a.php': 'x' });
    for (let ms = 1; ms <= 4; ms++) {
      await backupRemoteFile({ root: ROOT, keep: 0 }, remote, '/www', '/www/a.php', at(ms));
    }
    expect(vol.readdirSync(ROOT)).toHaveLength(4);
  });

  test('a failed download leaves no partial file', async () => {
    const remote = fakeRemote({ '/www/a.php': 'x' });
    remote.get = async () =>
      new Readable({
        read() {
          this.destroy(new Error('connection lost'));
        },
      });

    await expect(backupRemoteFile(option, remote, '/www', '/www/a.php', at(1))).rejects.toThrow(
      'connection lost'
    );
    expect(vol.readdirSync(ROOT)).toEqual([]);
  });
});

describe('TransferTask beforeOverwrite', () => {
  function makeTask(beforeOverwrite: any, direction = TransferDirection.LOCAL_TO_REMOTE) {
    const puts: string[] = [];
    const fs: any = {
      supportsParallelTransfer: () => false,
      get: async () => Readable.from([Buffer.from('new')]),
      open: async () => 1,
      close: async () => undefined,
      futimes: async () => undefined,
      put: async (_s: any, p: string) => {
        puts.push(p);
      },
    };
    const task = new TransferTask(
      { fsPath: '/local/a.php', fileSystem: fs },
      { fsPath: '/www/a.php', fileSystem: fs },
      {
        fileType: FileType.File,
        transferDirection: direction,
        transferOption: { perserveTargetMode: false, beforeOverwrite } as any,
      }
    );
    return { task, puts };
  }

  test('runs before the upload, and only once across retries', async () => {
    const hook = jest.fn(async () => undefined);
    const { task, puts } = makeTask(hook);
    await task.run();
    await task.run();

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith('/www/a.php', expect.anything());
    expect(puts).toEqual(['/www/a.php', '/www/a.php']);
  });

  test('a failed backup blocks the upload and keeps the error code for retry', async () => {
    const hook = jest.fn(async () => {
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    });
    const { task, puts } = makeTask(hook);

    await expect(task.run()).rejects.toMatchObject({
      message: expect.stringContaining('backup of /www/a.php failed, not uploading'),
      code: 'ECONNRESET',
    });
    expect(puts).toEqual([]);
  });

  test('never runs for downloads', async () => {
    const hook = jest.fn(async () => undefined);
    const { task } = makeTask(hook, TransferDirection.REMOTE_TO_LOCAL);
    await task.run();
    expect(hook).not.toHaveBeenCalled();
  });

  test('createBackupHook is undefined when backups are off', () => {
    expect(createBackupHook({ host: 'h', remotePath: '/www' } as any, BASE)).toBeUndefined();
  });
});
