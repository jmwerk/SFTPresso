import { l10n, window } from 'vscode';
import { COMMAND_SAVE_PASSWORD } from '../constants';
import { showInformationMessage } from '../host';
import { connectionToken, storePassword } from '../credentialStore';
import { checkCommand } from './abstract/createCommand';
import { selectRemoteConnection } from './shared';

export default checkCommand({
  id: COMMAND_SAVE_PASSWORD,

  async handleCommand() {
    const identity = await selectRemoteConnection();
    if (!identity) {
      return;
    }

    const password = await window.showInputBox({
      ignoreFocusOut: true,
      password: true,
      prompt: l10n.t('Enter the password for {0}', connectionToken(identity)),
    });

    // cancelled or empty
    if (!password) {
      return;
    }

    await storePassword(identity, password);
    showInformationMessage(
      l10n.t('Password for {0} saved to secret storage.', connectionToken(identity))
    );
  },
});
