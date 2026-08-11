import logger from '../../logger';
import {
  HostKeyInfo,
  KnownHostEntry,
  StrictHostKeyChecking,
  describeHostKey,
  fingerprintOfEntry,
  hostToken,
  isCertificateKeyType,
  lookupHostKey,
  readAllKnownHosts,
  rememberHostKey,
} from './hostKeyStore';

/**
 * Turns "what does the store say about this key" into "do we connect".
 *
 * Kept apart from the store itself so the policy is testable without touching
 * the file system, and so the store stays a description of what is trusted
 * rather than a decision about it.
 */

export interface UnknownHostPromptContext {
  host: string;
  port: number;
  key: HostKeyInfo;
}

export interface ChangedHostKeyContext {
  host: string;
  port: number;
  key: HostKeyInfo;
  // what the store expected, one line per conflicting entry
  known: Array<{ fingerprint: string; keyType: string; source: string; lineNumber: number }>;
}

export type UnknownHostAnswer = 'connect' | 'connect-and-remember' | 'cancel';

export interface HostKeyPrompt {
  // Shown the first time a host is seen under `strictHostKeyChecking: "ask"`.
  confirmUnknownHost(ctx: UnknownHostPromptContext): Promise<UnknownHostAnswer>;
  // Shown when a known host presents a different key. Purely informational —
  // the connection is refused either way.
  reportChangedHostKey(ctx: ChangedHostKeyContext): void;
}

/** A refusal that came from host key verification rather than from ssh2. */
export class HostKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostKeyError';
  }
}

export interface VerifyHostKeyOption {
  host: string;
  port?: number;
  // the raw host key blob ssh2 hands the verifier
  key: Buffer;
  policy: StrictHostKeyChecking;
  prompt?: HostKeyPrompt;
  // injectable for tests; defaults to the on-disk known_hosts files
  loadKnownHosts?: () => Promise<KnownHostEntry[]>;
  // injectable for tests; defaults to appending to the managed store
  remember?: (host: string, port: number | undefined, key: HostKeyInfo) => Promise<void>;
}

function describeConflicts(conflicting: KnownHostEntry[]) {
  return conflicting.map(entry => ({
    fingerprint: fingerprintOfEntry(entry),
    keyType: entry.keyType,
    source: entry.source,
    lineNumber: entry.lineNumber,
  }));
}

function changedKeyMessage(
  token: string,
  key: HostKeyInfo,
  known: ChangedHostKeyContext['known']
): string {
  const expected = known
    .map(entry => `${entry.fingerprint} (${entry.keyType}, ${entry.source}:${entry.lineNumber})`)
    .join('; ');

  return (
    `REMOTE HOST IDENTIFICATION HAS CHANGED for ${token}.` +
    ` The server offered ${key.type} ${key.fingerprint},` +
    ` but the stored key is ${expected}.` +
    ' Someone could be eavesdropping on you right now (man-in-the-middle attack),' +
    ' or the server was rebuilt and its host key was regenerated.' +
    ' If — and only if — you know the key legitimately changed, run the' +
    ' "SFTP: Forget Host Key" command and connect again.'
  );
}

/**
 * Resolves when the key is acceptable, rejects with a HostKeyError when it is
 * not. Never resolves "maybe" — the caller turns this straight into ssh2's
 * accept/refuse.
 */
export async function verifyHostKey(option: VerifyHostKeyOption): Promise<void> {
  const { host, port, policy, prompt } = option;
  const token = hostToken(host, port);
  const key = describeHostKey(option.key);

  // A certificate cannot be validated without the CA key and the certificate's
  // own constraints, neither of which we implement. Accepting one because it
  // "looks known" would be worse than not supporting it at all.
  if (isCertificateKeyType(key.type)) {
    throw new HostKeyError(
      `${token} offered a certificate host key (${key.type}), which SFTPresso cannot verify.` +
        ' Configure the server to offer a plain host key, or connect through OpenSSH instead.'
    );
  }

  const loadKnownHosts = option.loadKnownHosts || readAllKnownHosts;
  const remember = option.remember || rememberHostKey;
  const entries = await loadKnownHosts();
  const lookup = lookupHostKey(entries, token, key);

  if (lookup.verdict === 'revoked') {
    throw new HostKeyError(
      `The host key ${key.fingerprint} for ${token} is marked @revoked in` +
        ` ${lookup.matched!.source}:${lookup.matched!.lineNumber}. Refusing to connect.`
    );
  }

  if (lookup.verdict === 'match') {
    logger.debug(
      `host key for ${token} verified against ${lookup.matched!.source}` +
        `:${lookup.matched!.lineNumber} (${key.type} ${key.fingerprint})`
    );
    return;
  }

  if (lookup.verdict === 'changed') {
    const known = describeConflicts(lookup.conflicting);
    const message = changedKeyMessage(token, key, known);

    // 'no' is the documented "I know what I am doing" escape hatch and matches
    // OpenSSH's StrictHostKeyChecking=no, which also lets a changed key
    // through. It stays loud in the log either way.
    if (policy === 'no') {
      logger.warn(`${message} Connecting anyway because strictHostKeyChecking is "no".`);
      return;
    }

    logger.error(message);
    if (prompt) {
      prompt.reportChangedHostKey({ host, port: port === undefined ? 22 : port, key, known });
    }
    throw new HostKeyError(message);
  }

  // unknown
  if (policy === 'yes') {
    throw new HostKeyError(
      `The authenticity of host ${token} cannot be established:` +
        ` it offered ${key.type} ${key.fingerprint}, which is in no known_hosts file.` +
        ' strictHostKeyChecking is "true", so the connection was refused.' +
        ' Add the key to ~/.ssh/known_hosts, or set strictHostKeyChecking to "ask".'
    );
  }

  if (policy === 'ask') {
    if (!prompt) {
      throw new HostKeyError(
        `The authenticity of host ${token} cannot be established and there is no way to ask.` +
          ' Refusing to connect.'
      );
    }

    const answer = await prompt.confirmUnknownHost({
      host,
      port: port === undefined ? 22 : port,
      key,
    });
    if (answer === 'cancel') {
      throw new HostKeyError(`Host key for ${token} was not accepted; connection cancelled.`);
    }
    if (answer === 'connect-and-remember') {
      await remember(host, port, key);
    } else {
      logger.info(
        `accepted ${key.type} ${key.fingerprint} for ${token} for this connection only`
      );
    }
    return;
  }

  // 'accept-new' and 'no': learn the key and carry on
  logger.info(
    `${token} is not in any known_hosts file; accepting and remembering` +
      ` ${key.type} ${key.fingerprint} (strictHostKeyChecking: "${policy}")`
  );
  await remember(host, port, key);
}
