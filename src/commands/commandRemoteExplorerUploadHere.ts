import { window } from 'vscode';
import app from '../app';
import { COMMAND_REMOTEEXPLORER_UPLOAD_HERE } from '../constants';
import { ExplorerItem } from '../modules/remoteExplorer';
import { uploadLocalPaths } from '../modules/remoteExplorer/dragAndDrop';
import { checkCommand } from './abstract/createCommand';

export default checkCommand({
  id: COMMAND_REMOTEEXPLORER_UPLOAD_HERE,

  async handleCommand(item: ExplorerItem) {
    if (!item || !item.isDirectory) {
      return;
    }

    const destRoot = app.remoteExplorer.findRoot(item.resource.uri);
    if (!destRoot) {
      return;
    }

    const picked = await window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: 'Upload',
      title: `Upload to '${item.resource.fsPath}'`,
    });
    if (!picked || !picked.length) {
      return;
    }

    await uploadLocalPaths(destRoot, item.resource.fsPath, picked.map(uri => uri.fsPath));
  },
});
