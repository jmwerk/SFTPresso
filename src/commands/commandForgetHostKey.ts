import { l10n, window } from 'vscode';
import { COMMAND_FORGET_HOST_KEY } from '../constants';
import { showInformationMessage, showErrorMessage } from '../host';
import {
  findHostKeys,
  forgetHostKey,
  getManagedStorePath,
  hostToken,
} from '../core/remote-client/hostKeyStore';
import { checkCommand } from './abstract/createCommand';
import { selectRemoteConnection } from './shared';

/**
 * The only way past a refused connection after a host key changed.
 *
 * Deliberately a separate, explicit step rather than a button on the warning:
 * a changed key is either a server rebuild or an attack, and those two must not
 * be one click apart. Entries in the user's own ~/.ssh/known_hosts are only
 * touched after a modal that names the file and line, since that file belongs
 * to their ssh client, not to us.
 */
export default checkCommand({
  id: COMMAND_FORGET_HOST_KEY,

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
      showInformationMessage(l10n.t('No stored SSH host key for {0}.', token));
      return;
    }

    const managed = getManagedStorePath();
    const sources = Array.from(new Set(stored.map(entry => entry.source)));
    const foreign = sources.filter(source => source !== managed);

    if (foreign.length > 0) {
      const detail =
        stored
          .map(
            entry =>
              `${entry.fingerprint}  (${entry.keyType})\n    ${entry.source}:${entry.lineNumber}`
          )
          .join('\n') +
        '\n\n' +
        l10n.t(
          'The entries below are in files maintained by your ssh client. Removing them here affects ssh, scp, and everything else that reads them:'
        ) +
        '\n' +
        foreign.map(source => `    ${source}`).join('\n');

      const remove = l10n.t('Remove');
      const confirmed = await window.showWarningMessage(
        stored.length === 1
          ? l10n.t('Remove 1 stored host key entry for {0}?', token)
          : l10n.t('Remove {0} stored host key entries for {1}?', stored.length, token),
        { modal: true, detail },
        remove
      );
      if (confirmed !== remove) {
        return;
      }
    }

    const result = await forgetHostKey(identity.host, identity.port, sources);
    const removed = result.removed.reduce((total, entry) => total + entry.count, 0);

    if (result.failed.length > 0) {
      showErrorMessage(
        l10n.t(
          'Could not update {0}. Remove the entries for {1} by hand, or with "ssh-keygen -R".',
          result.failed.map(failure => `${failure.source} (${failure.message})`).join(', '),
          token
        )
      );
      return;
    }

    showInformationMessage(
      removed === 1
        ? l10n.t(
            'Removed 1 host key entry for {0}. The next connection will treat it as a new host.',
            token
          )
        : l10n.t(
            'Removed {0} host key entries for {1}. The next connection will treat it as a new host.',
            removed,
            token
          )
    );
  },
});
