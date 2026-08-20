import * as vscode from 'vscode';
import logger from '../logger';
import { realpathSync } from 'fs';
import app from '../app';
import StatusBarItem from '../ui/statusBarItem';
import {
  onDidOpenTextDocument,
  onDidSaveTextDocument,
  showConfirmMessage,
  showInformationMessage,
} from '../host';
import { readConfigsFromFile } from './config';
import {
  createFileService,
  getFileService,
  findAllFileService,
  disposeFileService,
  reconcileActiveProfile,
  refreshUploadOnSaveState,
} from './serviceManager';
import { reportError, isValidFile, isConfigFile, isInWorkspace } from '../helper';
import { downloadFile, uploadFile } from '../fileHandlers';
import { CONGIF_FILENAME } from '../constants';

let workspaceWatcher: vscode.Disposable;
let configDeleteWatcher: vscode.FileSystemWatcher;

async function handleConfigSave(uri: vscode.Uri) {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return;
  }

  const workspacePath = workspaceFolder.uri.fsPath;

  // dispose old service
  findAllFileService(service => service.workspace === workspacePath).forEach(service => {
    disposeFileService(service);
    // disposing resolves the config one last time, so clear afterwards: the
    // services created below get a fresh read of the config and of any ignore
    // file it points at
    service.invalidateConfigCache();
  });

  // create new service
  try {
    const configs = await readConfigsFromFile(uri.fsPath);
    configs.forEach(config => createFileService(config, workspacePath));
  } catch (error) {
    reportError(error);
  } finally {
    reconcileActiveProfile();
    refreshUploadOnSaveState();
    app.remoteExplorer.refresh();
  }
}

// Nothing else observes sftp.json disappearing -- onDidSaveTextDocument only
// fires on save, so without this the trie keeps handing out a FileService
// built from a config that's no longer on disk until the window reloads.
function handleConfigDelete(uri: vscode.Uri) {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  const workspacePath = workspaceFolder && workspaceFolder.uri.fsPath;

  const affectedServices = findAllFileService(service => service.workspace === workspacePath);
  affectedServices.forEach(service => {
    logger.info(`[config] ${uri.fsPath} removed, disabling SFTP for ${service.baseDir}`);
    disposeFileService(service);
  });

  reconcileActiveProfile();
  refreshUploadOnSaveState();
  if (app.remoteExplorer) {
    app.remoteExplorer.refresh();
  }

  // Only worth surfacing when it actually turned SFTP off for something --
  // an sftp.json deleted before any config ever loaded from it (e.g. it was
  // invalid) leaves nothing disposed above and would make this a false alarm.
  if (affectedServices.length > 0) {
    const label = workspaceFolder ? workspaceFolder.name : uri.fsPath;
    showInformationMessage(`SFTP config removed. SFTP disabled for "${label}".`);
    app.sftpBarItem.showMsg('SFTP config removed', uri.fsPath, 2000 * 2);
  }
}

async function handleFileSave(uri: vscode.Uri) {
  const fileService = getFileService(uri);
  if (!fileService) {
    return;
  }

  const config = fileService.getConfig();
  if (config.uploadOnSave) {
    const fspath = await realpathSync.native(uri.fsPath);
    uri = vscode.Uri.file(fspath);
    logger.info(`[file-save] ${fspath}`);
    try {
      await uploadFile(uri);
    } catch (error) {
      logger.error(error, `download ${fspath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  }
}

async function downloadOnOpen(uri: vscode.Uri) {
  const fileService = getFileService(uri);
  if (!fileService) {
    return;
  }

  const config = fileService.getConfig();
  if (config.downloadOnOpen) {
    if (config.downloadOnOpen === 'confirm') {
      const isConfirm = await showConfirmMessage('Do you want SFTP to download this file?');
      if (!isConfirm) return;
    }

    const fspath = uri.fsPath;
    logger.info(`[file-open] ${fspath}`);
    try {
      await downloadFile(uri);
    } catch (error) {
      logger.error(error, `download ${fspath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  }
}

function watchWorkspace({
  onDidSaveFile,
  onDidSaveSftpConfig,
}: {
  onDidSaveFile: (uri: vscode.Uri) => void;
  onDidSaveSftpConfig: (uri: vscode.Uri) => void;
}) {
  if (workspaceWatcher) {
    workspaceWatcher.dispose();
  }

  workspaceWatcher = onDidSaveTextDocument((doc: vscode.TextDocument) => {
    const uri = doc.uri;
    if (!isValidFile(uri) || !isInWorkspace(uri.fsPath)) {
      return;
    }

    // remove staled cache
    if (app.fsCache.has(uri.fsPath)) {
      app.fsCache.delete(uri.fsPath);
    }

    if (isConfigFile(uri)) {
      onDidSaveSftpConfig(uri);
      return;
    }

    onDidSaveFile(uri);
  });
}

let activeEditorWatcher: vscode.Disposable;

function init() {
  onDidOpenTextDocument((doc: vscode.TextDocument) => {
    if (!isValidFile(doc.uri) || !isInWorkspace(doc.uri.fsPath)) {
      return;
    }

    downloadOnOpen(doc.uri);
  });

  // keep the status-bar "upload on save" indicator in sync with the focused
  // file, since it can differ between workspaces/configs
  activeEditorWatcher = vscode.window.onDidChangeActiveTextEditor(() => {
    refreshUploadOnSaveState();
  });

  watchWorkspace({
    onDidSaveFile: handleFileSave,
    onDidSaveSftpConfig: handleConfigSave,
  });

  if (configDeleteWatcher) {
    configDeleteWatcher.dispose();
  }
  // ignoreCreate/ignoreChange: creation and edits are already handled via
  // onDidSaveTextDocument above; this watcher exists solely for delete, which
  // saves never fire for.
  configDeleteWatcher = vscode.workspace.createFileSystemWatcher(
    `**/.vscode/${CONGIF_FILENAME}`,
    true,
    true,
    false
  );
  configDeleteWatcher.onDidDelete(handleConfigDelete);
}

function destory() {
  if (workspaceWatcher) {
    workspaceWatcher.dispose();
  }
  if (activeEditorWatcher) {
    activeEditorWatcher.dispose();
  }
  if (configDeleteWatcher) {
    configDeleteWatcher.dispose();
  }
}

export default {
  init,
  destory,
};
