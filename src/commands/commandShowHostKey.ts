import { env, l10n, window } from 'vscode';
import { COMMAND_SHOW_HOST_KEY } from '../constants';
import { showInformationMessage } from '../host';
import { findHostKeys, hostToken } from '../core/remote-client/hostKeyStore';
import { checkCommand } from './abstract/createCommand';
import { selectRemoteConnection } from './shared';

/**
 * Shows what SFTPresso will accept for a host, so a fingerprint can be checked
 * against the server without having to guess which file it came out of.
 */
export default checkCommand({
  id: COMMAND_SHOW_HOST_KEY,

  async handleCommand() {
    const identity = await selectRemoteConnection();
    if (!identity) {
      return;
    }

    if (identity.protocol === 'ftp') {
      showInformationMessage(l10n.t('FTP connections do not use SSH host keys.'));
      return;
    }

    const token = hostToken(identity.host, identity.port);
    const stored = await findHostKeys(identity.host, identity.port);
    if (stored.length === 0) {
      showInformationMessage(
        l10n.t(
          'No stored SSH host key for {0}. It will be treated as a new host on the next connection.',
          token
        )
      );
      return;
    }

    const detail = stored
      .map(entry => {
        const marker = entry.marker ? ` @${entry.marker}` : '';
        return (
          `${entry.fingerprint}${marker}\n` +
          `    ${entry.keyType}\n` +
          `    ${entry.source}:${entry.lineNumber}`
        );
      })
      .join('\n\n');

    const copy = l10n.t('Copy Fingerprint');
    const choice = await window.showInformationMessage(
      stored.length === 1
        ? l10n.t('Stored host key for {0}', token)
        : l10n.t('Stored host keys for {0}', token),
      { modal: true, detail },
      copy
    );

    if (choice === copy) {
      await env.clipboard.writeText(stored.map(entry => entry.fingerprint).join('\n'));
    }
  },
});
