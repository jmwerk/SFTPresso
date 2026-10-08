import { env } from 'vscode';
import { COMMAND_COPY_REMOTE_PATH } from '../constants';
import { checkFileCommand } from './abstract/createCommand';
import { uriFromExplorerContextOrEditorContext } from './shared';

export default checkFileCommand({
  id: COMMAND_COPY_REMOTE_PATH,
  getFileTarget: uriFromExplorerContextOrEditorContext,

  async handleFile({ target }) {
    await env.clipboard.writeText(target.remoteFsPath);
  },
});
