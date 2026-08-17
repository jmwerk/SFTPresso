import { Uri, window } from 'vscode';
import { COMMAND_RUN_REMOTE_COMMAND } from '../constants';
import { showConfirmMessage, showErrorMessage, showInformationMessage } from '../host';
import { RemoteFileSystem } from '../core/fs';
import { execCommand } from '../core/remote-client/exec';
import { SSHClient } from '../core/remote-client';
import logger from '../logger';
import { show as showOutput, print } from '../ui/output';
import { checkCommand } from './abstract/createCommand';
import { resolveTargetService } from './shared';

const DEFAULT_TIMEOUT = 60 * 1000;
const ENTER_COMMAND = '$(edit) Enter a command…';

interface CommandPick {
  label: string;
  description?: string;
  command?: string;
}

async function promptForCommand(remoteCommands?: Record<string, string>): Promise<string | undefined> {
  const saved = remoteCommands ? Object.entries(remoteCommands) : [];
  if (saved.length <= 0) {
    return window.showInputBox({
      prompt: 'Command to run on the remote server',
      placeHolder: 'e.g. php artisan cache:clear',
      ignoreFocusOut: true,
    });
  }

  const items: CommandPick[] = [
    ...saved.map(([label, command]) => ({ label, description: command, command })),
    { label: ENTER_COMMAND },
  ];
  const picked = await window.showQuickPick(items, { placeHolder: 'Select a remote command to run' });
  if (!picked) {
    return undefined;
  }

  if (picked.command !== undefined) {
    return picked.command;
  }

  return window.showInputBox({
    prompt: 'Command to run on the remote server',
    placeHolder: 'e.g. php artisan cache:clear',
    ignoreFocusOut: true,
  });
}

export default checkCommand({
  id: COMMAND_RUN_REMOTE_COMMAND,

  async handleCommand(uri?: Uri) {
    const service = await resolveTargetService(uri, 'Select a config to run a command on');
    if (!service) {
      showErrorMessage('No SFTP config found.');
      return;
    }

    let config;
    try {
      config = service.getConfig();
    } catch (error) {
      showErrorMessage(`Invalid config: ${error.message}`);
      return;
    }

    if (config.protocol !== 'sftp') {
      showErrorMessage('SFTP: Run Remote Command is not supported over FTP.');
      return;
    }

    const command = await promptForCommand(config.remoteCommands);
    if (!command) {
      return;
    }

    const confirmed = await showConfirmMessage(
      `Run on ${config.host}: ${command}`,
      'Run',
      'Cancel'
    );
    if (!confirmed) {
      return;
    }

    const timeout =
      typeof config.remoteCommandTimeout === 'number' ? config.remoteCommandTimeout : DEFAULT_TIMEOUT;

    let fs: RemoteFileSystem;
    try {
      fs = (await service.getRemoteFileSystem(config)) as RemoteFileSystem;
    } catch (error) {
      showErrorMessage(`Failed to connect to ${config.host}: ${error.message}`);
      return;
    }

    const client = fs.getClient();
    if (!(client instanceof SSHClient)) {
      // Unreachable given the protocol check above -- getRemoteFileSystem()
      // for an 'sftp' config always constructs an SSHClient-backed
      // filesystem, so this can't be the "you tried this over FTP" case
      // (that's the check above). Kept only because RemoteClient itself
      // carries no protocol discriminant, so getRawClient() below still
      // needs an instanceof to narrow the type.
      showErrorMessage(`Internal error: expected an SSH client for ${config.host}.`);
      return;
    }

    showOutput();
    print(`$ ${command}  (${config.host})`);
    logger.info(`running remote command on ${config.host}: ${command}`);

    let result;
    try {
      result = await execCommand(client.getRawClient(), command, {
        timeout,
        onStdout: chunk => print(chunk.toString().replace(/\r?\n$/, '')),
        onStderr: chunk => print(chunk.toString().replace(/\r?\n$/, '')),
      });
    } catch (error) {
      logger.error(error, 'runRemoteCommand');
      showErrorMessage(`Failed to run command on ${config.host}: ${error.message}`);
      return;
    }

    if (result.timedOut) {
      print(`[timed out after ${timeout}ms; the command may still be running on the remote]`);
      logger.warn(`remote command on ${config.host} timed out after ${timeout}ms: ${command}`);
      showErrorMessage(`Command timed out after ${timeout}ms.`);
      return;
    }

    print(`[exit ${result.code}]`);
    logger.info(`remote command on ${config.host} exited ${result.code}: ${command}`);

    if (result.code === 0) {
      showInformationMessage(`Command finished on ${config.host} (exit 0).`);
    } else {
      showErrorMessage(`Command on ${config.host} exited with code ${result.code}.`);
    }
  },
});
