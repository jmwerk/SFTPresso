import { env } from 'vscode';
import app from '../app';
import { COMMAND_COPY_REMOTE_PATH } from '../constants';
import { handleCtxFromUri } from '../fileHandlers';
import { reportError } from '../helper';
import { checkCommand } from './abstract/createCommand';
import { uriFromExplorerContextOrEditorContext } from './shared';

// A plain command rather than a file command: those run once per selected item
// in parallel, and each run would overwrite the clipboard with its own path.
export default checkCommand({
  id: COMMAND_COPY_REMOTE_PATH,

  async handleCommand(item, items) {
    const target = uriFromExplorerContextOrEditorContext(item, items);
    if (!target) {
      return;
    }

    const uris = Array.isArray(target) ? target : [target];
    let paths: string[];
    try {
      paths = uris.map(uri => handleCtxFromUri(uri).target.remoteFsPath);
    } catch (error) {
      reportError(error);
      return;
    }

    await env.clipboard.writeText(paths.join('\n'));
    const copied = paths.length === 1 ? paths[0] : `${paths.length} remote paths`;
    app.sftpBarItem.showMsg(`$(copy) Copied ${copied}`, paths.join('\n'), 2000 * 2);
  },
});
