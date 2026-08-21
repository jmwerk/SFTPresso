import app from '../app';
import {
  getStoredPassword,
  getStoredPassphrase,
  storePassword,
  storePassphrase,
  clearStoredPassword,
  clearStoredPassphrase,
} from '../credentialStore';

function fakeSecretStorage() {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key),
    store: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };
}

describe('credentialStore', () => {
  const identity = { protocol: 'sftp', host: 'example.com', port: 22, username: 'deploy' };

  beforeEach(() => {
    (app as any).vscodeContext = { secrets: fakeSecretStorage() };
  });

  it('stores password and passphrase for the same identity under different keys', async () => {
    await storePassword(identity, 'my-password');
    await storePassphrase(identity, 'my-passphrase');

    expect(await getStoredPassword(identity)).toBe('my-password');
    expect(await getStoredPassphrase(identity)).toBe('my-passphrase');
  });

  it('clearing the password does not remove the passphrase, and vice versa', async () => {
    await storePassword(identity, 'my-password');
    await storePassphrase(identity, 'my-passphrase');

    await clearStoredPassword(identity);
    expect(await getStoredPassword(identity)).toBeUndefined();
    expect(await getStoredPassphrase(identity)).toBe('my-passphrase');

    await clearStoredPassphrase(identity);
    expect(await getStoredPassphrase(identity)).toBeUndefined();
  });

  it('returns undefined when nothing is stored', async () => {
    expect(await getStoredPassword(identity)).toBeUndefined();
    expect(await getStoredPassphrase(identity)).toBeUndefined();
  });
});
