import { env, l10n, Uri, window } from 'vscode';
import {
  HostKeyPrompt,
  UnknownHostAnswer,
  UnknownHostPromptContext,
  ChangedHostKeyContext,
} from './core/remote-client/hostKeyVerifier';
import { hostToken } from './core/remote-client/hostKeyStore';
import * as output from './ui/output';

// OpenSSH's own explanation of a changed host key. Linked rather than
// paraphrased so the user can check it against a source that is not us.
const LEARN_MORE_URL = 'https://man.openbsd.org/ssh#STRICT_HOST_KEY_CHECKING';

const CONNECT = l10n.t('Connect Once');
const CONNECT_AND_REMEMBER = l10n.t('Connect and Remember');
const LEARN_MORE = l10n.t('Learn More');
const SHOW_LOG = l10n.t('Show Log');

/**
 * The `/etc/ssh/ssh_host_<name>_key` a key type is stored under, so the prompt
 * can print the exact command to run on the server. Several algorithm names map
 * onto one file (the rsa-sha2-* names are signature algorithms over the same
 * RSA key), and an unrecognized one gets no command rather than a wrong one.
 */
function hostKeyFileName(keyType: string): string | undefined {
  if (keyType === 'ssh-ed25519') return 'ed25519';
  if (keyType === 'ssh-rsa' || keyType.startsWith('rsa-sha2-')) return 'rsa';
  if (keyType.startsWith('ecdsa-sha2-')) return 'ecdsa';
  if (keyType === 'ssh-dss') return 'dsa';
  return undefined;
}

/**
 * The first-sight prompt.
 *
 * Modal on purpose: this is the one moment where the user is being asked to
 * establish trust, and a toast that disappears while they are reading a
 * fingerprint is not a decision. The fingerprint is shown in the same form
 * `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` prints, so it can be
 * compared character for character without converting anything.
 */
async function confirmUnknownHost(ctx: UnknownHostPromptContext): Promise<UnknownHostAnswer> {
  const token = hostToken(ctx.host, ctx.port);
  const keyFile = hostKeyFileName(ctx.key.type);
  const howToCheck = keyFile
    ? l10n.t('Verify this fingerprint against the server before continuing. On the server, run:') +
      `\n    ssh-keygen -lf /etc/ssh/ssh_host_${keyFile}_key.pub`
    : l10n.t(
        'Verify this fingerprint against the server before continuing, using ssh-keygen -lf on its host key.'
      );

  const choice = await window.showWarningMessage(
    l10n.t("The authenticity of host {0} can't be established.", token),
    {
      modal: true,
      detail: [
        l10n.t('Host: {0}', ctx.host),
        l10n.t('Port: {0}', ctx.port),
        l10n.t('Key type: {0}', ctx.key.type),
        l10n.t('Fingerprint: {0}', ctx.key.fingerprint),
        '',
        howToCheck,
      ].join('\n'),
    },
    CONNECT_AND_REMEMBER,
    CONNECT
  );

  if (choice === CONNECT_AND_REMEMBER) {
    return 'connect-and-remember';
  }
  if (choice === CONNECT) {
    return 'connect';
  }
  return 'cancel';
}

/**
 * The changed-key alarm.
 *
 * Deliberately offers no way to proceed. A key change is either a server
 * rebuild or an attack, and those two must not be one click apart — getting
 * past this takes the explicit "SFTP: Forget Host Key" command.
 */
function reportChangedHostKey(ctx: ChangedHostKeyContext): void {
  const token = hostToken(ctx.host, ctx.port);
  const expected = ctx.known
    .map(entry => `  ${entry.fingerprint}  (${entry.keyType}, ${entry.source}:${entry.lineNumber})`)
    .join('\n');

  window
    .showErrorMessage(
      l10n.t('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED for {0}!', token),
      {
        modal: true,
        detail: [
          l10n.t(
            'Someone could be eavesdropping on you right now (man-in-the-middle attack), or the server was rebuilt and its host key regenerated.'
          ),
          '',
          l10n.t('Offered now:'),
          `  ${ctx.key.fingerprint}  (${ctx.key.type})`,
          '',
          l10n.t('Stored:'),
          expected,
          '',
          l10n.t(
            'The connection was refused. If you know the key legitimately changed, run "SFTP: Forget Host Key" and connect again.'
          ),
        ].join('\n'),
      },
      LEARN_MORE,
      SHOW_LOG
    )
    .then(choice => {
      if (choice === LEARN_MORE) {
        env.openExternal(Uri.parse(LEARN_MORE_URL));
      } else if (choice === SHOW_LOG) {
        output.show();
      }
    });
}

const hostKeyPrompt: HostKeyPrompt = {
  confirmUnknownHost,
  reportChangedHostKey,
};

export default hostKeyPrompt;
