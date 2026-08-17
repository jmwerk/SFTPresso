import { window } from 'vscode';
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
      prompt: `New name for '${currentName}'`,
      validateInput(value) {
        const trimmed = value.trim();
        if (!trimmed) {
          return 'Name cannot be empty.';
        }

        const candidate = upath.join(parentPath, trimmed);
        if (!isRemotePathAtOrUnder(remotePath, candidate)) {
          return `Can't move outside of '${remotePath}'.`;
        }
        if (isRemotePathAtOrUnder(remoteFsPath, candidate)) {
          return `Can't move '${currentName}' into itself.`;
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
