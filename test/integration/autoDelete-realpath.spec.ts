// Regression for #70: a delete-watcher event fires after the local file is
// already gone from disk, so realpath has nothing to resolve. Exercises the
// real (unmocked) toRemotePath/getFileSystemPath against a live SFTP server,
// reproducing exactly what the watcher's autoDelete path does: delete the
// local file, then resolve+delete the remote one, the same order
// createFileHandler/remove.ts uses.
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { toRemotePath } from '../../src/helper/paths';
import { fileOperations, FileType } from '../../src/core';
import { connectSftp, uniqueDir } from './sshHelpers';
import SFTPFileSystem from '../../src/core/fs/sftpFileSystem';

describe('autoDelete after local file removal', () => {
  test('deleting a watched local file removes the remote file without ENOENT from realpath', async () => {
    const localRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'sftpresso-it-'));
    const localPath = nodePath.join(localRoot, 'chk');
    fs.writeFileSync(localPath, 'sample');

    const remoteBase = uniqueDir();
    const sftp: SFTPFileSystem = await connectSftp();
    await fileOperations.createDir(remoteBase, sftp, {});
    const remotePath = `${remoteBase}/chk`;
    await sftp.put(fs.createReadStream(localPath), remotePath);

    const before = await sftp.lstat(remotePath);
    expect(before.type).toBe(FileType.File);

    // Mirror the real watcher/removeRemote sequence: delete the local file
    // FIRST, then resolve+delete the remote one -- this is exactly the point
    // at which the old code threw ENOENT out of fs.realpathSync.native.
    fs.unlinkSync(localPath);

    let resolvedRemotePath: string | undefined;
    expect(() => {
      resolvedRemotePath = toRemotePath(localPath, localRoot, remoteBase);
    }).not.toThrow();
    expect(resolvedRemotePath).toBe(remotePath);

    await fileOperations.removeFile(remotePath, sftp, {});

    await expect(sftp.lstat(remotePath)).rejects.toThrow();

    sftp.end();
    fs.rmSync(localRoot, { recursive: true, force: true });
  });
});
