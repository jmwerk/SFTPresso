import * as vscode from 'vscode';
import * as fse from 'fs-extra';
import { COMMAND_CONFIG } from '../constants';
import { newConfig, getConfigPath } from '../modules/config';
import { addProfileConfig, quickSetupConfig } from '../modules/configWizard';
import {
  getWorkspaceFolders,
  showConfirmMessage,
  showOpenDialog,
  openFolder,
  addWorkspaceFolder,
} from '../host';
import { checkCommand } from './abstract/createCommand';

async function configureWorkspace(basePath: string) {
  const exist = await fse.pathExists(getConfigPath(basePath));
  if (exist) {
    const picked = await vscode.window.showQuickPick(
      [
        {
          id: 'edit',
          label: vscode.l10n.t('Edit JSON'),
          description: vscode.l10n.t('Open the existing config file'),
        },
        {
          id: 'profile',
          label: vscode.l10n.t('Add Profile'),
          description: vscode.l10n.t(
            'Answer a few questions to add a profile to the existing config'
          ),
        },
      ],
      { placeHolder: vscode.l10n.t('A config already exists. What do you want to do?') }
    );

    if (picked === undefined) {
      return;
    }

    if (picked.id === 'profile') {
      return addProfileConfig(basePath);
    }

    return newConfig(basePath);
  }

  const picked = await vscode.window.showQuickPick(
    [
      {
        id: 'quick',
        label: vscode.l10n.t('Quick setup'),
        description: vscode.l10n.t('Answer a few questions to generate the config'),
      },
      {
        id: 'edit',
        label: vscode.l10n.t('Edit JSON'),
        description: vscode.l10n.t('Create a config file from a template and edit it'),
      },
    ],
    { placeHolder: vscode.l10n.t('How do you want to set up the connection?') }
  );

  if (picked === undefined) {
    return;
  }

  if (picked.id === 'quick') {
    return quickSetupConfig(basePath);
  }

  return newConfig(basePath);
}

export default checkCommand({
  id: COMMAND_CONFIG,

  async handleCommand() {
    const workspaceFolders = getWorkspaceFolders();
    if (!workspaceFolders) {
      const result = await showConfirmMessage(
        vscode.l10n.t('SFTP expects to work at a folder.'),
        vscode.l10n.t('Open Folder'),
        vscode.l10n.t('Ok')
      );

      if (!result) {
        return;
      }

      return openFolder();
    }

    if (workspaceFolders.length <= 0) {
      const result = await showConfirmMessage(
        vscode.l10n.t('There are no available folders in current workspace.'),
        vscode.l10n.t('Add Folder to Workspace'),
        vscode.l10n.t('Ok')
      );

      if (!result) {
        return;
      }

      const resources = await showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: true,
      });

      if (!resources) {
        return;
      }

      addWorkspaceFolder(...resources.map(uri => ({ uri })));
      return;
    }

    if (workspaceFolders.length === 1) {
      return configureWorkspace(workspaceFolders[0].uri.fsPath);
    }

    const initDirs = workspaceFolders.map(folder => ({
      value: folder.uri.fsPath,
      label: folder.name,
      description: folder.uri.fsPath,
    }));

    const item = await vscode.window.showQuickPick(initDirs, {
      placeHolder: vscode.l10n.t('Select a folder…'),
    });

    if (item === undefined) {
      return;
    }

    return configureWorkspace(item.value);
  },
});
