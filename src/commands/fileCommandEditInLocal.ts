import { COMMAND_REMOTEEXPLORER_EDITINLOCAL } from '../constants';
import { downloadFile } from '../fileHandlers';
import { showTextDocument, openFile } from '../host';
import { isImageFile } from '../helper';
import { uriFromExplorerContextOrEditorContext } from './shared';
import { checkFileCommand } from './abstract/createCommand';

export default checkFileCommand({
  id: COMMAND_REMOTEEXPLORER_EDITINLOCAL,
  getFileTarget: uriFromExplorerContextOrEditorContext,

  async handleFile(ctx) {
    await downloadFile(ctx, { ignore: null });
    if (isImageFile(ctx.target.localFsPath)) {
      await openFile(ctx.target.localUri, { preview: true });
    } else {
      await showTextDocument(ctx.target.localUri, { preview: true });
    }
  },
});
