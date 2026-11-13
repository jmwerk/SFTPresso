import { l10n } from 'vscode';
import { COMMAND_CLEAR_PASSWORD } from '../constants';
import { showInformationMessage } from '../host';
import { connectionToken, clearStoredPassword } from '../credentialStore';
import { checkCommand } from './abstract/createCommand';
import { selectRemoteConnection } from './shared';

export default checkCommand({
  id: COMMAND_CLEAR_PASSWORD,

  async handleCommand() {
    const identity = await selectRemoteConnection();
    if (!identity) {
      return;
    }

    const removed = await clearStoredPassword(identity);
    showInformationMessage(
      removed
        ? l10n.t('Password for {0} removed from secret storage.', connectionToken(identity))
        : l10n.t('No saved password for {0}.', connectionToken(identity))
    );
  },
});
