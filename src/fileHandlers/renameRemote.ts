import { fileOperations, upath } from '../core';
import { isRemotePathAtOrUnder } from '../helper';
import { refreshRemoteExplorer } from './shared';
import createFileHandler from './createFileHandler';

export const renameRemote = createFileHandler<{ newRemotePath: string }>({
  name: 'renameRemote',
  async handle({ newRemotePath }) {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const { remoteFsPath } = this.target;

    if (!isRemotePathAtOrUnder(this.config.remotePath, newRemotePath)) {
      throw new Error(`Can't rename outside of '${this.config.remotePath}'.`);
    }

    let destExists = true;
    try {
      await remoteFs.lstat(newRemotePath);
    } catch {
      destExists = false;
    }
    // SFTP's RENAME fails when the destination exists, with an opaque error.
    // Check first so we can say what actually went wrong.
    if (destExists) {
      throw new Error(`Can't rename to '${newRemotePath}' because it already exists.`);
    }

    const srcParent = upath.dirname(remoteFsPath);
    const destParent = upath.dirname(newRemotePath);
    if (destParent !== srcParent) {
      await remoteFs.ensureDir(destParent);
    }

    await fileOperations.rename(remoteFsPath, newRemotePath, remoteFs);
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, false);
  },
});
