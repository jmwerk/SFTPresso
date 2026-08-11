'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import app from './app';
import initCommands from './initCommands';
import { reportError } from './helper';
import fileActivityMonitor from './modules/fileActivityMonitor';
import { tryLoadConfigs } from './modules/config';
import {
  getAllFileService,
  createFileService,
  disposeFileService,
  refreshUploadOnSaveState,
} from './modules/serviceManager';
import { getWorkspaceFolders, setContextValue } from './host';
import RemoteExplorer from './modules/remoteExplorer';
import TransferView from './modules/transferView';
import TestConnectionCodeLensProvider from './modules/testConnectionCodeLensProvider';
import { CONGIF_FILENAME } from './constants';
import { setManagedStorePath } from './core/remote-client/hostKeyStore';

async function setupWorkspaceFolder(dir) {
  const configs = await tryLoadConfigs(dir);
  configs.forEach(config => {
    createFileService(config, dir);
  });
}

function setup(workspaceFolders: readonly vscode.WorkspaceFolder[]) {
  fileActivityMonitor.init();
  const pendingInits = workspaceFolders.map(folder => setupWorkspaceFolder(folder.uri.fsPath));

  return Promise.all(pendingInits);
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
  app.vscodeContext = context;

  // Host keys accepted here are written to a known_hosts file of our own rather
  // than to the user's ~/.ssh/known_hosts, which belongs to their ssh client.
  // Same format, so it stays readable with the usual tools.
  setManagedStorePath(vscode.Uri.joinPath(context.globalStorageUri, 'known_hosts').fsPath);

  try {
    initCommands(context);
  } catch (error) {
    reportError(error, 'initCommands');
  }

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { pattern: `**/.vscode/${CONGIF_FILENAME}` },
      new TestConnectionCodeLensProvider()
    )
  );

  const workspaceFolders = getWorkspaceFolders();
  if (!workspaceFolders) {
    return;
  }

  setContextValue('enabled', true);
  app.sftpBarItem.show();
  app.connectionBarItem.show();
  context.subscriptions.push(app.connectionBarItem);
  let lastProfile = app.state.profile;
  app.state.subscribe(state => {
    if (state.profile !== lastProfile) {
      lastProfile = state.profile;
      // the active profile decides which config a service resolves to
      getAllFileService().forEach(service => service.invalidateConfigCache());
    }

    const currentText = app.sftpBarItem.getText();
    // current is showing profile
    if (currentText.startsWith('SFTP')) {
      app.sftpBarItem.reset();
    }
    if (app.remoteExplorer) {
      app.remoteExplorer.refresh();
    }
  });
  try {
    await setup(workspaceFolders);
    refreshUploadOnSaveState();
    app.remoteExplorer = new RemoteExplorer(context);
    app.transferView = new TransferView(context);
  } catch (error) {
    reportError(error);
  }
}

export function deactivate() {
  fileActivityMonitor.destory();
  getAllFileService().forEach(disposeFileService);
}
