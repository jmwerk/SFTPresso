import { l10n } from 'vscode';
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
        ? l10n.t("Delete '{0}' from the server?", upath.basename(list[0].fsPath))
        : l10n.t('Delete {0} items from the server?', list.length);
    const names =
      list.length > 1 ? list.map(t => upath.basename(t.fsPath)).join(', ') + '\n\n' : '';
    const detail = names + l10n.t("This can't be undone.");
    const result = await showDestructiveConfirm(message, detail, l10n.t('Delete'));

    return result ? targets : undefined;
  },

  handleFile: removeRemote,
});
