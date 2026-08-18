import * as path from 'path';
import { Uri } from 'vscode';
import { openFile } from '../host';
import { EXTENSION_NAME } from '../constants';
import { fileOperations } from '../core';
import { makeTmpFile } from '../helper';
import createFileHandler from './createFileHandler';

// Pulls the remote bytes into a throwaway tmp file rather than the workspace's
// local mirror path -- previewing an image shouldn't write into the project
// or be treated as a synced local copy, same as text "View Content" never did.
export const previewImage = createFileHandler({
  name: 'preview image',
  async handle() {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const localFs = this.fileService.getLocalFileSystem();
    const { localFsPath, remoteFsPath } = this.target;
    const tmpPath = await makeTmpFile({
      prefix: `${EXTENSION_NAME}-`,
      postfix: path.extname(localFsPath),
    });

    await fileOperations.transferFile(remoteFsPath, tmpPath, remoteFs, localFs);
    await openFile(Uri.file(tmpPath), { preview: true });
  },
});
