import * as vscode from 'vscode';
import { COMMAND_OPEN_CONNECTION_IN_TERMINAL } from '../constants';
import { FileService } from '../core';
import { RemoteFileSystem } from '../core/fs';
import { SSHClient } from '../core/remote-client';
import { openShell } from '../core/remote-client/shell';
import upath from '../core/upath';
import { getAllFileService, getFileService } from '../modules/serviceManager';
import { ExplorerItem, ExplorerRoot } from '../modules/remoteExplorer';
import { isWorkspaceTrusted, showConfirmMessage, showErrorMessage } from '../host';
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

// Above this many terminals at once, ask first: each is a session on one connection, and
// OpenSSH's default MaxSessions is 10.
const CONFIRM_TERMINAL_COUNT = 5;

// The folders to open a terminal in: the whole selection when the clicked item is part of
// it, else just the clicked item. Files are skipped, since a shell can't start in one.
export function terminalTargets(clicked?: ExplorerItem, selection?: ExplorerItem[]): ExplorerItem[] {
  if (!clicked) {
    return [];
  }
  const items = Array.isArray(selection) && selection.includes(clicked) ? selection : [clicked];
  return items.filter(item => item.isDirectory);
}

async function pickService(): Promise<FileService | undefined> {
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

interface TerminalTarget {
  fileService: FileService;
  // undefined for a root or the Command Palette, which start in remotePath
  folder?: string;
}

function toTarget(item: ExplorerItem): TerminalTarget | undefined {
  if ((item as ExplorerRoot).explorerContext) {
    return { fileService: (item as ExplorerRoot).explorerContext.fileService };
  }
  const fileService = getFileService(item.resource.uri);
  return fileService && { fileService, folder: item.resource.fsPath };
}

function openTerminal({ fileService, folder }: TerminalTarget, preserveFocus: boolean) {
  // re-read so the active profile is used, not the one the item was built with
  const config = fileService.getConfig();
  const cwd = folder === undefined ? config.remotePath : folder;
  const baseName = config.name || config.host;

  const pty = new RemoteTerminal({
    host: config.host,
    connect: dimensions =>
      connectShell(fileService, config, cwd, dimensions).catch(error => {
        logger.error(error, 'openConnectInTerminal');
        throw error;
      }),
  });
  const terminal = vscode.window.createTerminal({
    name: folder === undefined ? baseName : `${baseName}: ${upath.basename(cwd)}`,
    pty,
    iconPath: new vscode.ThemeIcon('remote'),
  });
  terminal.show(preserveFocus);
}

export default checkCommand({
  id: COMMAND_OPEN_CONNECTION_IN_TERMINAL,

  // From the Remote Explorer (the clicked item plus the selection) or the Command Palette.
  async handleCommand(clicked?: ExplorerItem, selection?: ExplorerItem[]) {
    let targets: TerminalTarget[];
    if (clicked) {
      targets = terminalTargets(clicked, selection)
        .map(toTarget)
        .filter((target): target is TerminalTarget => !!target);
    } else {
      const fileService = await pickService();
      targets = fileService ? [{ fileService }] : [];
    }
    if (targets.length <= 0) {
      showErrorMessage('No SFTP config found.');
      return;
    }

    // FTP has no shell; a mixed selection opens the SFTP ones
    targets = targets.filter(target => target.fileService.getConfig().protocol === 'sftp');
    if (targets.length <= 0) {
      showErrorMessage('SFTP: Open SSH in Terminal is not supported over FTP.');
      return;
    }

    // the system-ssh fallback can't start in a folder, so it opens once per config
    const legacy = new Set<FileService>();
    targets = targets.filter(target => {
      if (!target.fileService.getConfig().sshCustomParams) {
        return true;
      }
      if (!legacy.has(target.fileService)) {
        legacy.add(target.fileService);
        openSystemSshTerminal(target.fileService.getConfig());
      }
      return false;
    });

    if (
      targets.length > CONFIRM_TERMINAL_COUNT &&
      !(await showConfirmMessage(`Open ${targets.length} terminals?`, 'Open', 'Cancel'))
    ) {
      return;
    }

    // focus only the last one, so the user ends up in a terminal and not mid-list
    targets.forEach((target, index) => openTerminal(target, index < targets.length - 1));
  },
});
