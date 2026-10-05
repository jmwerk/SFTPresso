import { COMMAND_DELETE_REMOTE } from '../constants';
import { upath } from '../core';
import { removeRemote } from '../fileHandlers';
import { showDestructiveConfirm } from '../host';
import { checkFileCommand } from './abstract/createCommand';
import { uriFromExplorerContextOrEditorContext } from './shared';

export default checkFileCommand({
  id: COMMAND_DELETE_REMOTE,
  async getFileTarget(item, items) {
    const targets = await uriFromExplorerContextOrEditorContext(item, items);

    if (!targets) {
      return;
    }

    const list = Array.isArray(targets) ? targets : [targets];
    const message =
      list.length === 1
        ? `Delete '${upath.basename(list[0].fsPath)}' from the server?`
        : `Delete ${list.length} items from the server?`;
    const names = list.length > 1 ? list.map(t => upath.basename(t.fsPath)).join(', ') + '\n\n' : '';
    const detail = `${names}This can't be undone.`;
    const result = await showDestructiveConfirm(message, detail, 'Delete');

    return result ? targets : undefined;
  },

  handleFile: removeRemote,
});
