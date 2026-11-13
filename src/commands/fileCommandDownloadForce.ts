import { l10n } from 'vscode';
import { COMMAND_FORCE_DOWNLOAD } from '../constants';
import { download } from '../fileHandlers';
import { showConfirmMessage } from '../host';
import { uriFromExplorerContextOrEditorContext } from './shared';
import { checkFileCommand } from './abstract/createCommand';

export default checkFileCommand({
  id: COMMAND_FORCE_DOWNLOAD,
  async getFileTarget(item, items) {
    const targets = await uriFromExplorerContextOrEditorContext(item, items);

    if (!targets) {
      return;
    }

    const result = await showConfirmMessage(
      l10n.t(
        'Force download will overwrite local files with the remote versions, ignoring any exclude rules. Continue?'
      ),
      l10n.t('Download'),
      l10n.t('Cancel')
    );

    return result ? targets : undefined;
  },

  async handleFile(ctx) {
    await download(ctx, { ignore: null });
  },
});
