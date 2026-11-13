import { l10n, window } from 'vscode';
import { COMMAND_RENAME_REMOTE } from '../constants';
import { upath } from '../core';
import { handleCtxFromUri, renameRemote } from '../fileHandlers';
import { isRemotePathAtOrUnder } from '../helper';
import { checkCommand } from './abstract/createCommand';
import { uriFromExplorerContextOrEditorContext } from './shared';

export default checkCommand({
  id: COMMAND_RENAME_REMOTE,
  async handleCommand(item, items) {
    const target = await uriFromExplorerContextOrEditorContext(item, items);
    const uri = Array.isArray(target) ? target[0] : target;
    if (!uri) {
      return;
    }

    const ctx = handleCtxFromUri(uri);
    const { remoteFsPath } = ctx.target;
    const parentPath = upath.dirname(remoteFsPath);
    const currentName = upath.basename(remoteFsPath);
    const remotePath = ctx.config.remotePath;

    const input = await window.showInputBox({
      value: currentName,
      prompt: l10n.t("New name for '{0}'", currentName),
      validateInput(value) {
        const trimmed = value.trim();
        if (!trimmed) {
          return l10n.t('Name cannot be empty.');
        }

        const candidate = upath.join(parentPath, trimmed);
        if (!isRemotePathAtOrUnder(remotePath, candidate)) {
          return l10n.t("Can't move outside of '{0}'.", remotePath);
        }
        if (isRemotePathAtOrUnder(remoteFsPath, candidate)) {
          return l10n.t("Can't move '{0}' into itself.", currentName);
        }

        return undefined;
      },
    });

    if (!input || input.trim() === currentName) {
      return;
    }

    await renameRemote(ctx, { newRemotePath: upath.join(parentPath, input.trim()) });
  },
});
