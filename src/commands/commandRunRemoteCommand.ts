import { l10n, Uri, window } from 'vscode';
import { COMMAND_RUN_REMOTE_COMMAND } from '../constants';
import {
  showConfirmMessage,
  showErrorMessage,
  showInformationMessage,
  isWorkspaceTrusted,
} from '../host';
import { RemoteFileSystem } from '../core/fs';
import { execCommand } from '../core/remote-client/exec';
import { SSHClient } from '../core/remote-client';
import logger from '../logger';
import { show as showOutput, print } from '../ui/output';
import { checkCommand } from './abstract/createCommand';
import { resolveTargetService } from './shared';

const DEFAULT_TIMEOUT = 60 * 1000;

interface CommandPick {
  label: string;
  description?: string;
  command?: string;
}

async function promptForCommand(
  remoteCommands?: Record<string, string>
): Promise<string | undefined> {
  const saved = remoteCommands ? Object.entries(remoteCommands) : [];
  if (saved.length <= 0) {
    return promptForCommandText();
  }

  const items: CommandPick[] = [
    ...saved.map(([label, command]) => ({ label, description: command, command })),
    { label: l10n.t('$(edit) Enter a command…') },
  ];
  const picked = await window.showQuickPick(items, {
    placeHolder: l10n.t('Select a remote command to run'),
  });
  if (!picked) {
    return undefined;
  }

  if (picked.command !== undefined) {
    return picked.command;
  }

  return promptForCommandText();
}

function promptForCommandText(): Thenable<string | undefined> {
  return window.showInputBox({
    prompt: l10n.t('Command to run on the remote server'),
    placeHolder: l10n.t('e.g. php artisan cache:clear'),
    ignoreFocusOut: true,
  });
}

export default checkCommand({
  id: COMMAND_RUN_REMOTE_COMMAND,

  async handleCommand(uri?: Uri) {
    // The saved-command list this prompts from comes straight out of the
    // workspace's sftp.json -- an untrusted repo could label an arbitrary
    // shell command with an innocent-looking name and have the user run it.
    if (!isWorkspaceTrusted()) {
      showErrorMessage(
        l10n.t(
          'Running a remote command requires a trusted workspace. Use "Workspaces: Manage Workspace Trust" to enable it.'
        )
      );
      return;
    }

    const service = await resolveTargetService(uri, l10n.t('Select a config to run a command on'));
    if (!service) {
      showErrorMessage(l10n.t('No SFTP config found.'));
      return;
    }

    let config;
    try {
      config = service.getConfig();
    } catch (error) {
      showErrorMessage(l10n.t('Invalid config: {0}', error.message));
      return;
    }

    if (config.protocol !== 'sftp') {
      showErrorMessage(l10n.t('SFTP: Run Remote Command is not supported over FTP.'));
      return;
    }

    const command = await promptForCommand(config.remoteCommands);
    if (!command) {
      return;
    }

    const confirmed = await showConfirmMessage(
      l10n.t('Run on {0}: {1}', config.host, command),
      l10n.t('Run'),
      l10n.t('Cancel')
    );
    if (!confirmed) {
      return;
    }

    const timeout =
      typeof config.remoteCommandTimeout === 'number'
        ? config.remoteCommandTimeout
        : DEFAULT_TIMEOUT;

    let fs: RemoteFileSystem;
    try {
      fs = (await service.getRemoteFileSystem(config)) as RemoteFileSystem;
    } catch (error) {
      showErrorMessage(l10n.t('Failed to connect to {0}: {1}', config.host, error.message));
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
      showErrorMessage(l10n.t('Internal error: expected an SSH client for {0}.', config.host));
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
      showErrorMessage(l10n.t('Failed to run command on {0}: {1}', config.host, error.message));
      return;
    }

    if (result.timedOut) {
      print(`[timed out after ${timeout}ms; the command may still be running on the remote]`);
      logger.warn(`remote command on ${config.host} timed out after ${timeout}ms: ${command}`);
      showErrorMessage(l10n.t('Command timed out after {0}ms.', timeout));
      return;
    }

    print(`[exit ${result.code}]`);
    logger.info(`remote command on ${config.host} exited ${result.code}: ${command}`);

    if (result.code === 0) {
      showInformationMessage(l10n.t('Command finished on {0} (exit 0).', config.host));
    } else {
      showErrorMessage(l10n.t('Command on {0} exited with code {1}.', config.host, result.code));
    }
  },
});
