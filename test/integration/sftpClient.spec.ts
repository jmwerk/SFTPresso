import { Readable } from 'stream';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import upath from '../../src/core/upath';
import { FileType } from '../../src/core/fs/fileSystem';
import SFTPFileSystem from '../../src/core/fs/sftpFileSystem';
import localFs from '../../src/core/localFs';
import TransferTask, { TransferDirection } from '../../src/core/transferTask';
import { transferSymlink } from '../../src/core/fileBaseOperations';
import { transfer } from '../../src/fileHandlers/transfer/transfer';
import {
  PRIVATE_KEY_PATH,
  SSH_HOST,
  connectSftp,
  connectSftpOnce,
  uniqueDir,
} from './sshHelpers';

const upload = (sftp: SFTPFileSystem, buf: Buffer, path: string): Promise<void> =>
  sftp.put(Readable.from(buf), path);

const download = (sftp: SFTPFileSystem, path: string): Promise<Buffer> =>
  sftp.readFile(path) as Promise<Buffer>;

// local scratch space, one directory per run
let localRoot: string;

beforeAll(() => {
  localRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'sftpresso-it-'));
});

afterAll(() => {
  if (localRoot) {
    fs.rmSync(localRoot, { recursive: true, force: true });
  }
});

function localFile(name: string, content: Buffer | string, mode = 0o644): string {
  const fsPath = nodePath.join(localRoot, name);
  fs.mkdirSync(nodePath.dirname(fsPath), { recursive: true });
  fs.writeFileSync(fsPath, content);
  fs.chmodSync(fsPath, mode);
  return fsPath;
}

async function runUpload(
  sftp: SFTPFileSystem,
  localPath: string,
  remotePath: string,
  option: any = {}
): Promise<void> {
  const stat = await localFs.lstat(localPath);
  const task = new TransferTask(
    { fsPath: localPath, fileSystem: localFs },
    { fsPath: remotePath, fileSystem: sftp },
    {
      fileType: FileType.File,
      transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      transferOption: {
        atime: stat.atime,
        mtime: stat.mtime,
        perserveTargetMode: false,
        size: stat.size,
        ...option,
      },
    }
  );
  await task.run();
}

// ---------------------------------------------------------------------------
// Connect / authenticate. SFTP is the default protocol, so these are the paths
// most users hit first.
// ---------------------------------------------------------------------------
describe('connect / authenticate', () => {
  test('password authentication', async () => {
    const sftp = await connectSftp();
    try {
      const dir = uniqueDir();
      await sftp.ensureDir(dir);
      expect((await sftp.lstat(dir)).type).toBe(FileType.Directory);
      await sftp.rmdir(dir, true);
    } finally {
      sftp.end();
    }
  });

  test('private key authentication', async () => {
    expect(fs.existsSync(PRIVATE_KEY_PATH)).toBe(true);
    const sftp = await connectSftp({
      password: undefined,
      privateKeyPath: PRIVATE_KEY_PATH,
    });
    try {
      const dir = uniqueDir();
      await sftp.ensureDir(dir);
      await sftp.rmdir(dir, true);
    } finally {
      sftp.end();
    }
  });

  test('a wrong password reports the friendly auth error, not raw ssh2 text', async () => {
    // describeConnectError maps ssh2's client-authentication level
    await expect(connectSftpOnce({ password: 'definitely-wrong' })).rejects.toThrow(
      `Authentication to ${SSH_HOST} failed. Check your username, password, or private key.`
    );
  });

  test('a refused port reports the friendly connection error', async () => {
    await expect(
      connectSftpOnce({ port: 2223, connectTimeout: 5000 })
    ).rejects.toThrow(/Connection refused by|is unreachable|timed out/);
  });

  test('end() notifies onDisconnected listeners', async () => {
    const sftp = await connectSftp();
    const disconnected = new Promise<string>(resolve =>
      sftp.onDisconnected(reason => resolve(reason))
    );
    sftp.end();
    expect(await disconnected).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The SFTPFileSystem operation set.
// ---------------------------------------------------------------------------
describe('filesystem operations', () => {
  let sftp: SFTPFileSystem;

  beforeAll(async () => {
    sftp = await connectSftp();
  });

  afterAll(() => {
    if (sftp) sftp.end();
  });

  test('ensureDir (nested) + list + lstat', async () => {
    const dir = uniqueDir();
    const nested = upath.join(dir, 'a', 'b');
    await sftp.ensureDir(nested);

    expect((await sftp.lstat(nested)).type).toBe(FileType.Directory);
    expect((await sftp.list(upath.join(dir, 'a'))).map(e => e.name)).toContain('b');

    await sftp.rmdir(dir, true);
  });

  test('put / get text roundtrip', async () => {
    const dir = uniqueDir();
    await sftp.ensureDir(dir);
    const path = upath.join(dir, 'hello.txt');
    const text = 'héllo\nworld — sftp roundtrip\n'.repeat(20);

    await upload(sftp, Buffer.from(text, 'utf8'), path);
    // decode here rather than via readFile's `encoding` option: the product
    // only ever reads remote files as buffers, and an encoded ssh2 read stream
    // yields strings that RemoteFileSystem.readFile can't Buffer.concat
    expect((await download(sftp, path)).toString('utf8')).toBe(text);

    await sftp.rmdir(dir, true);
  });

  test('put / get binary roundtrip (a few MB, byte-for-byte)', async () => {
    const dir = uniqueDir();
    await sftp.ensureDir(dir);
    const path = upath.join(dir, 'blob.bin');
    const blob = randomBytes(3 * 1024 * 1024 + 7);

    await upload(sftp, blob, path);
    const got = await download(sftp, path);
    expect(got.length).toBe(blob.length);
    expect(Buffer.compare(got, blob)).toBe(0);
    expect((await sftp.lstat(path)).size).toBe(blob.length);

    await sftp.rmdir(dir, true);
  });

  test('rename', async () => {
    const dir = uniqueDir();
    await sftp.ensureDir(dir);
    const src = upath.join(dir, 'src.txt');
    const dest = upath.join(dir, 'dest.txt');
    await upload(sftp, Buffer.from('rename me'), src);

    await sftp.rename(src, dest);

    const names = (await sftp.list(dir)).map(e => e.name);
    expect(names).toContain('dest.txt');
    expect(names).not.toContain('src.txt');

    await sftp.rmdir(dir, true);
  });

  test('renameAtomic (OpenSSH posix-rename extension) overwrites the target', async () => {
    const dir = uniqueDir();
    await sftp.ensureDir(dir);
    const src = upath.join(dir, 'new.txt');
    const dest = upath.join(dir, 'live.txt');
    await upload(sftp, Buffer.from('old'), dest);
    await upload(sftp, Buffer.from('new'), src);

    // plain rename() would fail here: the destination already exists
    await sftp.renameAtomic(src, dest);

    expect((await download(sftp, dest)).toString()).toBe('new');
    expect((await sftp.list(dir)).map(e => e.name)).not.toContain('new.txt');

    await sftp.rmdir(dir, true);
  });

  test('unlink + recursive rmdir', async () => {
    const dir = uniqueDir();
    const sub = upath.join(dir, 'sub');
    await sftp.ensureDir(sub);
    await upload(sftp, Buffer.from('1'), upath.join(dir, 'top.txt'));
    await upload(sftp, Buffer.from('2'), upath.join(sub, 'nested.txt'));

    await sftp.unlink(upath.join(dir, 'top.txt'));
    expect((await sftp.list(dir)).map(e => e.name)).not.toContain('top.txt');

    await sftp.rmdir(dir, true);
    await expect(sftp.lstat(dir)).rejects.toBeDefined();
  });

  test('symlink + readlink + lstat reports SymbolicLink', async () => {
    const dir = uniqueDir();
    await sftp.ensureDir(dir);
    const target = upath.join(dir, 'target.txt');
    const link = upath.join(dir, 'link.txt');
    await upload(sftp, Buffer.from('linked'), target);

    await sftp.symlink(target, link);

    expect(await sftp.readlink(link)).toBe(target);
    expect((await sftp.lstat(link)).type).toBe(FileType.SymbolicLink);

    await sftp.rmdir(dir, true);
  });

  test('chmod changes the reported mode', async () => {
    const dir = uniqueDir();
    await sftp.ensureDir(dir);
    const path = upath.join(dir, 'perm.txt');
    await upload(sftp, Buffer.from('perm'), path);

    await sftp.chmod(path, 0o604);
    expect((await sftp.lstat(path)).mode).toBe(0o604);

    await sftp.rmdir(dir, true);
  });

  test('futimes writes second-precision timestamps', async () => {
    const dir = uniqueDir();
    await sftp.ensureDir(dir);
    const path = upath.join(dir, 'stamp.txt');
    await upload(sftp, Buffer.from('stamp'), path);

    // an hour ago, truncated to whole seconds like the transfer path does
    const when = Math.floor((Date.now() - 3600 * 1000) / 1000);
    const fd = await sftp.open(path, 'r+');
    try {
      await sftp.futimes(fd, when, when);
    } finally {
      await sftp.close(fd);
    }

    expect((await sftp.lstat(path)).mtime).toBe(when * 1000);

    await sftp.rmdir(dir, true);
  });

  test('get() rejects for a missing file', async () => {
    const dir = uniqueDir();
    await sftp.ensureDir(dir);
    await expect(download(sftp, upath.join(dir, 'nope.txt'))).rejects.toBeDefined();
    await sftp.rmdir(dir, true);
  });
});

// ---------------------------------------------------------------------------
// TransferTask: the mode cascade, mtime preservation, and the temp-file paths.
// This is the logic sync and conflictCheck depend on and where a refactor is
// most likely to regress silently.
// ---------------------------------------------------------------------------
describe('TransferTask uploads', () => {
  let sftp: SFTPFileSystem;

  beforeAll(async () => {
    sftp = await connectSftp();
  });

  afterAll(() => {
    if (sftp) sftp.end();
  });

  test('content and size land intact', async () => {
    const dir = uniqueDir();
    await sftp.ensureDir(dir);
    const blob = randomBytes(512 * 1024);
    const local = localFile('content/blob.bin', blob);
    const remote = upath.join(dir, 'blob.bin');

    await runUpload(sftp, local, remote);

    expect(Buffer.compare(await download(sftp, remote), blob)).toBe(0);
    await sftp.rmdir(dir, true);
  });

  test('mtime is preserved to the second', async () => {
    const dir = uniqueDir();
    await sftp.ensureDir(dir);
    const local = localFile('mtime/file.txt', 'mtime');
    // a fixed past time so a server-side "now" can't accidentally match
    const when = new Date(Date.now() - 2 * 3600 * 1000);
    fs.utimesSync(local, when, when);
    const remote = upath.join(dir, 'file.txt');

    await runUpload(sftp, local, remote);

    const localStat = await localFs.lstat(local);
    const remoteStat = await sftp.lstat(remote);
    expect(Math.floor(remoteStat.mtime / 1000)).toBe(Math.floor(localStat.mtime / 1000));

    await sftp.rmdir(dir, true);
  });

  test('filePerm sets the remote mode explicitly', async () => {
    const dir = uniqueDir();
    await sftp.ensureDir(dir);
    const local = localFile('perm/explicit.txt', 'perm', 0o644);
    const remote = upath.join(dir, 'explicit.txt');

    // filePerm is written in config as octal digits, e.g. 640
    await runUpload(sftp, local, remote, { filePerm: 640 });

    expect((await sftp.lstat(remote)).mode).toBe(0o640);
    await sftp.rmdir(dir, true);
  });

  test('perserveTargetMode keeps the mode an existing remote file already had', async () => {
    const dir = uniqueDir();
    await sftp.ensureDir(dir);
    const remote = upath.join(dir, 'existing.txt');
    await upload(sftp, Buffer.from('old'), remote);
    await sftp.chmod(remote, 0o600);

    const local = localFile('perm/existing.txt', 'new content', 0o644);
    await runUpload(sftp, local, remote, {
      perserveTargetMode: true,
      fallbackMode: 0o644,
      useTempFile: true,
    });

    expect((await download(sftp, remote)).toString()).toBe('new content');
    expect((await sftp.lstat(remote)).mode).toBe(0o600);

    await sftp.rmdir(dir, true);
  });

  test('fallbackMode is used when there is no remote file to inherit from', async () => {
    const dir = uniqueDir();
    await sftp.ensureDir(dir);
    const local = localFile('perm/fresh.txt', 'fresh', 0o640);
    const remote = upath.join(dir, 'fresh.txt');

    await runUpload(sftp, local, remote, {
      perserveTargetMode: true,
      fallbackMode: 0o640,
      useTempFile: true,
    });

    expect((await sftp.lstat(remote)).mode).toBe(0o640);
    await sftp.rmdir(dir, true);
  });

  describe.each([
    ['unlink + rename', false],
    ['posix-rename (openSsh)', true],
  ])('useTempFile — %s', (_label, openSsh) => {
    test('uploads via <target>.new and leaves no temp file behind', async () => {
      const dir = uniqueDir();
      await sftp.ensureDir(dir);
      const remote = upath.join(dir, 'served.txt');
      await upload(sftp, Buffer.from('previous'), remote);

      const local = localFile(`temp/${openSsh ? 'ssh' : 'plain'}.txt`, 'replacement');
      await runUpload(sftp, local, remote, { useTempFile: true, openSsh });

      expect((await download(sftp, remote)).toString()).toBe('replacement');
      expect((await sftp.list(dir)).map(e => e.name)).toEqual(['served.txt']);

      await sftp.rmdir(dir, true);
    });
  });

  test('symlinks transfer as symlinks', async () => {
    const dir = uniqueDir();
    await sftp.ensureDir(dir);
    const linkPath = nodePath.join(localRoot, 'link', 'pointer');
    fs.mkdirSync(nodePath.dirname(linkPath), { recursive: true });
    if (fs.existsSync(linkPath)) {
      fs.unlinkSync(linkPath);
    }
    fs.symlinkSync('./real-target.txt', linkPath);
    const remote = upath.join(dir, 'pointer');

    await transferSymlink(linkPath, remote, localFs, sftp, {});

    expect(await sftp.readlink(remote)).toBe('./real-target.txt');
    expect((await sftp.lstat(remote)).type).toBe(FileType.SymbolicLink);

    await sftp.rmdir(dir, true);
  });
});

// ---------------------------------------------------------------------------
// The directory walk over a real connection: dirPerm, the bounded fan-out, and
// cancellation during collection.
// ---------------------------------------------------------------------------
describe('folder transfer', () => {
  let sftp: SFTPFileSystem;

  beforeAll(async () => {
    sftp = await connectSftp();
  });

  afterAll(() => {
    if (sftp) sftp.end();
  });

  function localTree(name: string, dirs: number, filesPerDir: number): string {
    const root = nodePath.join(localRoot, name);
    for (let d = 0; d < dirs; d += 1) {
      for (let f = 0; f < filesPerDir; f += 1) {
        localFile(nodePath.join(name, `d${d}`, `f${f}.txt`), `d${d}/f${f}`);
      }
    }
    return root;
  }

  test('walks a tree with bounded concurrency and transfers every file', async () => {
    const dir = uniqueDir();
    const root = localTree('walk', 6, 3);

    const tasks: TransferTask[] = [];
    await transfer(
      {
        srcFsPath: root,
        srcFs: localFs,
        targetFsPath: dir,
        targetFs: sftp,
        transferDirection: TransferDirection.LOCAL_TO_REMOTE,
        transferOption: { perserveTargetMode: false },
        walkConcurrency: 2,
      },
      task => tasks.push(task)
    );
    await Promise.all(tasks.map(task => task.run()));

    expect(tasks).toHaveLength(18);
    const entries = await sftp.list(upath.join(dir, 'd0'));
    expect(entries.map(e => e.name).sort()).toEqual(['f0.txt', 'f1.txt', 'f2.txt']);
    expect((await download(sftp, upath.join(dir, 'd5', 'f2.txt'))).toString()).toBe('d5/f2');

    await sftp.rmdir(dir, true);
  });

  test('dirPerm is applied to the directories the walk creates', async () => {
    const dir = uniqueDir();
    const root = localTree('perms', 2, 1);

    const tasks: TransferTask[] = [];
    await transfer(
      {
        srcFsPath: root,
        srcFs: localFs,
        targetFsPath: dir,
        targetFs: sftp,
        transferDirection: TransferDirection.LOCAL_TO_REMOTE,
        transferOption: { perserveTargetMode: false },
        dirPerm: 750,
      },
      task => tasks.push(task)
    );
    await Promise.all(tasks.map(task => task.run()));

    expect((await sftp.lstat(dir)).mode).toBe(0o750);
    expect((await sftp.lstat(upath.join(dir, 'd0'))).mode).toBe(0o750);

    await sftp.chmod(dir, 0o755);
    await sftp.rmdir(dir, true);
  });

  test('cancelling during the walk stops collecting tasks', async () => {
    const dir = uniqueDir();
    const root = localTree('cancel', 6, 3);

    let cancelled = false;
    const tasks: TransferTask[] = [];
    await transfer(
      {
        srcFsPath: root,
        srcFs: localFs,
        targetFsPath: dir,
        targetFs: sftp,
        transferDirection: TransferDirection.LOCAL_TO_REMOTE,
        transferOption: { perserveTargetMode: false },
        walkConcurrency: 1,
        token: { isCancelled: () => cancelled },
      },
      task => {
        tasks.push(task);
        cancelled = true;
      }
    );

    // the walk stops as soon as the first task is collected
    expect(tasks.length).toBeLessThan(18);

    await sftp.rmdir(dir, true);
  });
});

// ---------------------------------------------------------------------------
// limitOpenFilesOnRemote hooks ssh2's internal open/opendir/close to cap
// concurrent file descriptors; normal operation must be unaffected.
// ---------------------------------------------------------------------------
describe('limitOpenFilesOnRemote', () => {
  test('connects and completes a folder transfer with the fd throttle installed', async () => {
    const sftp = await connectSftp({ limitOpenFilesOnRemote: 127 });
    try {
      const dir = uniqueDir();
      const name = 'fdlimit';
      for (let f = 0; f < 12; f += 1) {
        localFile(nodePath.join(name, `f${f}.txt`), `file ${f}`);
      }

      const tasks: TransferTask[] = [];
      await transfer(
        {
          srcFsPath: nodePath.join(localRoot, name),
          srcFs: localFs,
          targetFsPath: dir,
          targetFs: sftp,
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: { perserveTargetMode: false },
        },
        task => tasks.push(task)
      );
      await Promise.all(tasks.map(task => task.run()));

      expect((await sftp.list(dir)).map(e => e.name)).toHaveLength(12);
      await sftp.rmdir(dir, true);
    } finally {
      sftp.end();
    }
  });
});
