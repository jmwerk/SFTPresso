import * as path from 'path';
import upath from '../../src/core/upath';
import SFTPFileSystem from '../../src/core/fs/sftpFileSystem';
import { ConnectOption } from '../../src/core/remote-client';

// Matches the `openssh` service in ./docker-compose.yml. Throwaway test-only
// credentials — never reuse them anywhere else.
export const SSH_HOST = '127.0.0.1';
export const SSH_PORT = 2222;
export const SSH_USER = 'testuser';
export const SSH_PASSWORD = 'testpass';
export const SSH_BASE_DIR = `/home/${SSH_USER}`;

// Generated on the host by ./openssh/prepare-keys.sh (gitignored); the public
// half is mounted into the container as authorized_keys.
export const PRIVATE_KEY_PATH = path.join(
  __dirname,
  'openssh',
  'keys',
  'id_ed25519'
);

export function connectOption(overrides: Partial<ConnectOption> = {}): ConnectOption {
  return {
    protocol: 'sftp',
    host: SSH_HOST,
    port: SSH_PORT,
    username: SSH_USER,
    password: SSH_PASSWORD,
    connectTimeout: 10 * 1000,
    debug: () => undefined,
    ...overrides,
  } as ConnectOption;
}

function newFs(option: ConnectOption): SFTPFileSystem {
  return new SFTPFileSystem(upath, { clientOption: option });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Connect with a few retries ONLY at setup (never wrap assertions in retries):
 * the compose stack may still be settling when the first spec runs.
 */
export async function connectSftp(
  overrides: Partial<ConnectOption> = {},
  attempts = 5
): Promise<SFTPFileSystem> {
  const option = connectOption(overrides);
  let lastError: unknown;

  for (let i = 0; i < attempts; i += 1) {
    const fs = newFs(option);
    try {
      await fs.connect(option, { askForPasswd: async () => undefined });
      return fs;
    } catch (error) {
      lastError = error;
      fs.end();
      await sleep(1000);
    }
  }

  throw lastError;
}

/** Single attempt, for specs that assert on a connection failure. */
export function connectSftpOnce(
  overrides: Partial<ConnectOption> = {}
): Promise<SFTPFileSystem> {
  const option = connectOption(overrides);
  const fs = newFs(option);
  return fs
    .connect(option, { askForPasswd: async () => undefined })
    .then(() => fs)
    .catch(error => {
      fs.end();
      throw error;
    });
}

let counter = 0;
/** Unique remote working directory per test so specs never collide. */
export function uniqueDir(): string {
  counter += 1;
  return upath.join(SSH_BASE_DIR, `it-${Date.now()}-${counter}`);
}
