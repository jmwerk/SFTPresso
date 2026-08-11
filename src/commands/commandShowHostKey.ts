import { env, window } from 'vscode';
import { COMMAND_SHOW_HOST_KEY } from '../constants';
import { showInformationMessage } from '../host';
import { findHostKeys, hostToken } from '../core/remote-client/hostKeyStore';
import { checkCommand } from './abstract/createCommand';
import { selectRemoteConnection } from './shared';

const COPY = 'Copy Fingerprint';

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
      showInformationMessage('FTP connections do not use SSH host keys.');
      return;
    }

    const token = hostToken(identity.host, identity.port);
    const stored = await findHostKeys(identity.host, identity.port);
    if (stored.length === 0) {
      showInformationMessage(
        `No stored SSH host key for ${token}. It will be treated as a new host on the next connection.`
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

    const choice = await window.showInformationMessage(
      `Stored host key${stored.length === 1 ? '' : 's'} for ${token}`,
      { modal: true, detail },
      COPY
    );

    if (choice === COPY) {
      await env.clipboard.writeText(stored.map(entry => entry.fingerprint).join('\n'));
    }
  },
});
