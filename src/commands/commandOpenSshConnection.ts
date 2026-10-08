import * as vscode from 'vscode';
import { COMMAND_OPEN_CONNECTION_IN_TERMINAL } from '../constants';
import { FileService } from '../core';
import { RemoteFileSystem } from '../core/fs';
import { SSHClient } from '../core/remote-client';
import { openShell } from '../core/remote-client/shell';
import { getAllFileService } from '../modules/serviceManager';
import { ExplorerRoot } from '../modules/remoteExplorer';
import { isWorkspaceTrusted, showErrorMessage } from '../host';
import logger from '../logger';
import RemoteTerminal from '../ui/remoteTerminal';
import { interpolate } from '../utils';
import { checkCommand } from './abstract/createCommand';

const isWindows = process.platform === 'win32';

function shouldUseAgent(config) {
  return typeof config.agent === 'string' && config.agent.length > 0;
}

function shouldUseKey(config) {
  return typeof config.privateKeyPath === 'string' && config.privateKeyPath.length > 0;
}

function adaptPath(filepath) {
  if (isWindows) {
    return filepath.replace(/\\\\/g, '\\');
  }

  // convert to unix style
  return filepath.replace(/\\\\/g, '/').replace(/\\/g, '/');
}

function getSshCommand(
  config: { host: string; port: number; username: string },
  extraOption?: string
) {
  let sshStr = `ssh -t ${config.username}@${config.host} -p ${config.port}`;
  if (extraOption) {
    sshStr += ` ${extraOption}`;
  }
  return sshStr;
}

// The original behavior, kept for configs that set sshCustomParams: those are
// flags for the system `ssh` binary, which the built-in terminal doesn't run.
function openSystemSshTerminal(remoteConfig) {
  // sshCustomParams is typed into a local shell, so a repo's sftp.json could
  // otherwise run anything on this machine
  if (!isWorkspaceTrusted()) {
    showErrorMessage(
      'sshCustomParams requires a trusted workspace. Use "Workspaces: Manage Workspace Trust" to enable it.'
    );
    return;
  }

  const sshConfig = {
    host: remoteConfig.host,
    port: remoteConfig.port,
    username: remoteConfig.username,
  };
  const terminal = vscode.window.createTerminal(remoteConfig.name);
  let sshCommand;
  if (shouldUseAgent(remoteConfig)) {
    sshCommand = getSshCommand(sshConfig);
  } else if (shouldUseKey(remoteConfig)) {
    sshCommand = getSshCommand(sshConfig, `-i "${adaptPath(remoteConfig.privateKeyPath)}"`);
  } else {
    sshCommand = getSshCommand(sshConfig);
  }

  sshCommand =
    sshCommand +
    ' ' +
    interpolate(remoteConfig.sshCustomParams, {
      remotePath: remoteConfig.remotePath,
    });

  terminal.sendText(sshCommand);
  terminal.show();
}

async function connectShell(
  fileService: FileService,
  config,
  cwd: string,
  dimensions: vscode.TerminalDimensions
) {
  const fs = (await fileService.getRemoteFileSystem(config)) as RemoteFileSystem;
  const client = fs.getClient();
  if (!(client instanceof SSHClient)) {
    throw new Error('expected an SSH connection');
  }
  return openShell(client.getRawClient(), {
    cols: dimensions.columns,
    rows: dimensions.rows,
    cwd,
  });
}

async function pickService(exploreItem?: ExplorerRoot): Promise<FileService | undefined> {
  if (exploreItem && exploreItem.explorerContext) {
    return exploreItem.explorerContext.fileService;
  }

  const items = getAllFileService().reduce<
    { label: string; description: string; fileService: FileService }[]
  >((result, fileService) => {
    const config = fileService.getConfig();
    if (config.protocol === 'sftp') {
      result.push({
        label: config.name || config.remotePath,
        description: config.host,
        fileService,
      });
    }
    return result;
  }, []);
  if (items.length <= 1) {
    return items.length ? items[0].fileService : undefined;
  }

  const item = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a folder…',
  });
  return item && item.fileService;
}

export default checkCommand({
  id: COMMAND_OPEN_CONNECTION_IN_TERMINAL,

  async handleCommand(exploreItem?: ExplorerRoot) {
    const fileService = await pickService(exploreItem);
    if (!fileService) {
      showErrorMessage('No SFTP config found.');
      return;
    }

    // re-read so the active profile is used, not the one the item was built with
    const config = fileService.getConfig();
    if (config.protocol !== 'sftp') {
      showErrorMessage('SFTP: Open SSH in Terminal is not supported over FTP.');
      return;
    }

    if (config.sshCustomParams) {
      openSystemSshTerminal(config);
      return;
    }

    const pty = new RemoteTerminal({
      host: config.host,
      connect: dimensions =>
        connectShell(fileService, config, config.remotePath, dimensions).catch(error => {
          logger.error(error, 'openConnectInTerminal');
          throw error;
        }),
    });
    const terminal = vscode.window.createTerminal({
      name: config.name || config.host,
      pty,
      iconPath: new vscode.ThemeIcon('remote'),
    });
    terminal.show();
  },
});
