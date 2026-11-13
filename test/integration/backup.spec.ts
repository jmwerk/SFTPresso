import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import upath from '../../src/core/upath';
import SFTPFileSystem from '../../src/core/fs/sftpFileSystem';
import { backupRemoteFile } from '../../src/core/backup';
import { connectSftp, uniqueDir } from './sshHelpers';

/**
 * Backups against a real OpenSSH server: the unit tests cover naming and
 * pruning against an in-memory fs; only a real server shows the remote stream
 * lands byte-for-byte in the local file, and that a missing file is told apart
 * from a real error by the server's own status code.
 */

let sftp: SFTPFileSystem;
let dir: string;
let localRoot: string;

beforeAll(async () => {
  sftp = await connectSftp();
  dir = uniqueDir();
  await sftp.ensureDir(upath.join(dir, 'sub dir'));
  localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sftpresso-backup-'));
});

afterAll(async () => {
  fs.rmSync(localRoot, { recursive: true, force: true });
  if (sftp) {
    await sftp.rmdir(dir, true).catch(() => undefined);
    sftp.end();
  }
});

describe('backupRemoteFile on a real OpenSSH server', () => {
  it('copies the remote file byte-for-byte under its relative path', async () => {
    const content = Buffer.alloc(300 * 1024, 'ab');
    const remoteFile = upath.join(dir, 'sub dir', "it's.php");
    await sftp.put(Readable.from([content]), remoteFile);

    const dest = await backupRemoteFile({ root: localRoot, keep: 5 }, sftp, dir, remoteFile);

    expect(dest).toBeDefined();
    expect(path.dirname(dest!)).toBe(path.join(localRoot, 'sub dir'));
    expect(path.basename(dest!)).toMatch(/^it's\.\d{8}-\d{6}-\d{3}\.php$/);
    expect(fs.readFileSync(dest!).equals(content)).toBe(true);
  });

  it('resolves undefined for a file the server does not have', async () => {
    await expect(
      backupRemoteFile({ root: localRoot, keep: 5 }, sftp, dir, upath.join(dir, 'missing.php'))
    ).resolves.toBeUndefined();
  });
});
