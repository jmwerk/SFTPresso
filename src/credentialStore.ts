import app from './app';
import logger from './logger';
import { showInformationMessage } from './host';

export interface ConnectIdentity {
  protocol?: string;
  host: string;
  port?: number;
  username?: string;
}

const SECRET_KEY_PREFIX_PASSWORD = 'sftp.password.';
const SECRET_KEY_PREFIX_PASSPHRASE = 'sftp.passphrase.';

// "protocol://username@host:port" — identifies a remote both in secret
// storage keys and in messages shown to the user
export function connectionToken(identity: ConnectIdentity): string {
  const protocol = identity.protocol || 'sftp';
  const port = identity.port !== undefined ? identity.port : protocol === 'ftp' ? 21 : 22;
  return `${protocol}://${identity.username}@${identity.host}:${port}`;
}

function secretKey(prefix: string, identity: ConnectIdentity): string {
  return prefix + connectionToken(identity);
}

function getSecretStorage() {
  const context = app.vscodeContext;
  return context ? context.secrets : undefined;
}

async function getStoredSecret(
  prefix: string,
  identity: ConnectIdentity,
  kind: string
): Promise<string | undefined> {
  const secrets = getSecretStorage();
  if (!secrets) {
    return undefined;
  }

  try {
    return await secrets.get(secretKey(prefix, identity));
  } catch (error) {
    logger.warn(`read ${kind} for ${connectionToken(identity)} from secret storage failed: ${error.message}`);
    return undefined;
  }
}

async function storeSecret(prefix: string, identity: ConnectIdentity, value: string): Promise<void> {
  const secrets = getSecretStorage();
  if (!secrets) {
    throw new Error('Secret storage is unavailable.');
  }

  await secrets.store(secretKey(prefix, identity), value);
}

async function clearStoredSecret(prefix: string, identity: ConnectIdentity): Promise<boolean> {
  const secrets = getSecretStorage();
  if (!secrets) {
    return false;
  }

  const key = secretKey(prefix, identity);
  const existed = (await secrets.get(key)) !== undefined;
  await secrets.delete(key);
  return existed;
}

async function offerToRememberSecret(
  prefix: string,
  identity: ConnectIdentity,
  value: string,
  kind: string,
  offerLabel: string
) {
  try {
    const answer = await showInformationMessage(
      `Remember ${kind} for ${connectionToken(identity)}?`,
      offerLabel
    );
    if (answer === offerLabel) {
      await storeSecret(prefix, identity, value);
      logger.info(`${kind} for ${connectionToken(identity)} saved to secret storage`);
    }
  } catch (error) {
    logger.warn(`save ${kind} for ${connectionToken(identity)} failed: ${error.message}`);
  }
}

export function getStoredPassword(identity: ConnectIdentity): Promise<string | undefined> {
  return getStoredSecret(SECRET_KEY_PREFIX_PASSWORD, identity, 'password');
}

export function storePassword(identity: ConnectIdentity, password: string): Promise<void> {
  return storeSecret(SECRET_KEY_PREFIX_PASSWORD, identity, password);
}

export function clearStoredPassword(identity: ConnectIdentity): Promise<boolean> {
  return clearStoredSecret(SECRET_KEY_PREFIX_PASSWORD, identity);
}

export function offerToRememberPassword(identity: ConnectIdentity, password: string) {
  return offerToRememberSecret(SECRET_KEY_PREFIX_PASSWORD, identity, password, 'password', 'Remember password');
}

export function getStoredPassphrase(identity: ConnectIdentity): Promise<string | undefined> {
  return getStoredSecret(SECRET_KEY_PREFIX_PASSPHRASE, identity, 'passphrase');
}

export function storePassphrase(identity: ConnectIdentity, passphrase: string): Promise<void> {
  return storeSecret(SECRET_KEY_PREFIX_PASSPHRASE, identity, passphrase);
}

export function clearStoredPassphrase(identity: ConnectIdentity): Promise<boolean> {
  return clearStoredSecret(SECRET_KEY_PREFIX_PASSPHRASE, identity);
}

export function offerToRememberPassphrase(identity: ConnectIdentity, passphrase: string) {
  return offerToRememberSecret(
    SECRET_KEY_PREFIX_PASSPHRASE,
    identity,
    passphrase,
    'passphrase',
    'Remember passphrase'
  );
}
