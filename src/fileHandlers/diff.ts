import { l10n } from 'vscode';
import * as path from 'path';
import { diffFiles } from '../host';
import { FileSystem, isNotFoundError } from '../core';
import createFileHandler from './createFileHandler';

export interface DiffOption {
  // false opens a pinned tab instead of replacing the preview tab, so opening
  // several diffs in a row keeps them all
  preview?: boolean;
  preserveFocus?: boolean;
}

async function exists(fs: FileSystem, fsPath: string): Promise<boolean> {
  try {
    await fs.lstat(fsPath);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

// The remote side is the live remote: uri (RemoteFileSystemProvider), not a downloaded copy,
// so an edit made on that side of the diff saves to the server instead of to a temp file.
export const diff = createFileHandler<DiffOption>({
  name: 'diff',
  async handle(option) {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const localFs = this.fileService.getLocalFileSystem();
    const { localFsPath, remoteFsPath, localUri, remoteUri } = this.target;
    const name = path.basename(localFsPath);

    const [hasLocal, hasRemote] = await Promise.all([
      exists(localFs, localFsPath),
      exists(remoteFs, remoteFsPath),
    ]);
    if (!hasRemote) {
      throw new Error(
        l10n.t(
          "{0} doesn't exist on the remote ({1}), so there is nothing to diff.",
          name,
          remoteFsPath
        )
      );
    }
    if (!hasLocal) {
      throw new Error(
        l10n.t('{0} has no local copy ({1}). Download it first to diff.', name, localFsPath)
      );
    }

    await diffFiles(
      remoteUri,
      localUri,
      l10n.t('{0} ({1} ↔ local)', name, this.fileService.name || l10n.t('remote')),
      option && (option.preview !== undefined || option.preserveFocus !== undefined)
        ? { preview: option.preview, preserveFocus: option.preserveFocus }
        : undefined
    );
  },
});
