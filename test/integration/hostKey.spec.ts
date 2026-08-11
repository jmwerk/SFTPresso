import { execFile } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as nodePath from 'path';
import { promisify } from 'util';
import upath from '../../src/core/upath';
import SFTPFileSystem from '../../src/core/fs/sftpFileSystem';
import { ConnectOption } from '../../src/core/remote-client';
import {
  findHostKeys,
  forgetHostKey,
  hostToken,
  parseKnownHosts,
  setManagedStorePath,
  setOpenSshStorePaths,
} from '../../src/core/remote-client/hostKeyStore';
import {
  ChangedHostKeyContext,
  HostKeyPrompt,
  UnknownHostAnswer,
  UnknownHostPromptContext,
} from '../../src/core/remote-client/hostKeyVerifier';
import { SSH_HOST, SSH_PORT, connectOption } from './sshHelpers';

/**
 * Host key verification against a real OpenSSH server.
 *
 * The unit tests cover the parsing and the policy matrix; what only a real
 * server can show is that the key ssh2 hands the verifier is the one the server
 * actually holds, that a key learned on one connection is recognised on the
 * next, and that a genuinely different server key is refused rather than
 * silently re-learned.
 */

const execFileAsync = promisify(execFile);
const COMPOSE_FILE = nodePath.join(__dirname, 'docker-compose.yml');
const TOKEN = hostToken(SSH_HOST, SSH_PORT);

let storeDir: string;
let storePath: string;

beforeEach(async () => {
  storeDir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'sftpresso-hostkey-it-'));
  storePath = nodePath.join(storeDir, 'known_hosts');
  setManagedStorePath(storePath);
  // The developer running this very likely has an entry for a test server on
  // 127.0.0.1:2222 already; every assertion here is about what *this* store
  // holds, so the real one is taken out of the picture.
  setOpenSshStorePaths([]);
});

afterEach(async () => {
  setManagedStorePath(undefined);
  setOpenSshStorePaths(undefined);
  await fsp.rm(storeDir, { recursive: true, force: true });
});

function recordingPrompt(answer: UnknownHostAnswer) {
  const asked: UnknownHostPromptContext[] = [];
  const alarms: ChangedHostKeyContext[] = [];
  const prompt: HostKeyPrompt = {
    async confirmUnknownHost(ctx) {
      asked.push(ctx);
      return answer;
    },
    reportChangedHostKey(ctx) {
      alarms.push(ctx);
    },
  };
  return { prompt, asked, alarms };
}

/**
 * One connection attempt with an explicit host key policy. Never retried —
 * every assertion here is about whether this exact attempt is allowed.
 */
async function connect(
  strictHostKeyChecking: ConnectOption['strictHostKeyChecking'],
  prompt?: HostKeyPrompt
): Promise<SFTPFileSystem> {
  const option = connectOption({ strictHostKeyChecking });
  const fs = new SFTPFileSystem(upath, { clientOption: option, operationTimeout: 30 * 1000 });
  try {
    await fs.connect(option, { askForPasswd: async () => undefined, hostKeyPrompt: prompt });
    return fs;
  } catch (error) {
    fs.end();
    throw error;
  }
}

/** Connect, prove the connection works, and close it. */
async function connectAndUse(
  strictHostKeyChecking: ConnectOption['strictHostKeyChecking'],
  prompt?: HostKeyPrompt
): Promise<void> {
  const fs = await connect(strictHostKeyChecking, prompt);
  try {
    // a real round trip, so "connected" means more than "the socket opened"
    await fs.list('/');
  } finally {
    fs.end();
  }
}

async function storedFingerprints(): Promise<string[]> {
  return (await findHostKeys(SSH_HOST, SSH_PORT)).map(entry => entry.fingerprint);
}

describe('host key verification against the OpenSSH container', () => {
  test('accept-new learns the server key and records it in known_hosts form', async () => {
    expect(await storedFingerprints()).toHaveLength(0);

    await connectAndUse('accept-new');

    const content = await fsp.readFile(storePath, 'utf8');
    const entries = parseKnownHosts(content, storePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].patterns).toEqual([TOKEN]);
    // whatever the container generated, it is a real ssh host key type
    expect(entries[0].keyType).toMatch(/^(ssh-ed25519|ssh-rsa|rsa-sha2-\d+|ecdsa-sha2-\S+)$/);
    expect((await storedFingerprints())[0]).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  test('a key learned on one connection satisfies strictHostKeyChecking: true on the next', async () => {
    await connectAndUse('accept-new');
    const learned = await storedFingerprints();

    // `true` never learns anything, so this only passes if the stored key
    // really is the one the server presents
    await connectAndUse(true);

    expect(await storedFingerprints()).toEqual(learned);
  });

  test('strictHostKeyChecking: true refuses a host it has never seen', async () => {
    await expect(connect(true)).rejects.toThrow(
      /authenticity of host .* cannot be established/
    );
    expect(await storedFingerprints()).toHaveLength(0);
  });

  test('ask prompts with the real fingerprint, and remembering it makes the next connect silent', async () => {
    const first = recordingPrompt('connect-and-remember');
    await connectAndUse('ask', first.prompt);

    expect(first.asked).toHaveLength(1);
    expect(first.asked[0]).toMatchObject({ host: SSH_HOST, port: SSH_PORT });
    expect(first.asked[0].key.fingerprint).toBe((await storedFingerprints())[0]);

    const second = recordingPrompt('cancel');
    await connectAndUse('ask', second.prompt);
    expect(second.asked).toHaveLength(0);
  });

  test('the handshake survives a slow answer to the first-sight prompt', async () => {
    // ssh2's readyTimeout runs from connect() to 'ready', and the verifier
    // holds the handshake open while the modal is up. With connectTimeout at
    // 10s, a user taking a normal amount of time to compare a fingerprint would
    // otherwise have the connection torn down underneath them.
    const slow: HostKeyPrompt = {
      async confirmUnknownHost() {
        await new Promise(resolve => setTimeout(resolve, 12 * 1000));
        return 'connect-and-remember';
      },
      reportChangedHostKey() {
        /* not reached */
      },
    };

    await expect(connectAndUse('ask', slow)).resolves.toBeUndefined();
    expect(await storedFingerprints()).toHaveLength(1);
  }, 60 * 1000);

  test('ask + cancel refuses the connection and remembers nothing', async () => {
    const { prompt } = recordingPrompt('cancel');

    await expect(connect('ask', prompt)).rejects.toThrow(/was not accepted/);
    expect(await storedFingerprints()).toHaveLength(0);
  });

  test('a stored key that no longer matches the server is refused, not re-learned', async () => {
    // Stand in for a server whose key changed: keep the entry for this host but
    // put a different key in it. From the client's side this is exactly what a
    // rebuilt server — or a man in the middle — looks like.
    await connectAndUse('accept-new');
    const real = (await storedFingerprints())[0];
    const content = await fsp.readFile(storePath, 'utf8');
    const entry = parseKnownHosts(content, storePath)[0];
    const impostor = Buffer.from(entry.keyBase64, 'base64');
    // flip a bit deep in the key body, past the algorithm name
    impostor[impostor.length - 1] ^= 0xff;
    await fsp.writeFile(
      storePath,
      `${TOKEN} ${entry.keyType} ${impostor.toString('base64')}\n`
    );

    const { prompt, alarms } = recordingPrompt('connect-and-remember');
    await expect(connect('accept-new', prompt)).rejects.toThrow(
      /REMOTE HOST IDENTIFICATION HAS CHANGED/
    );

    expect(alarms).toHaveLength(1);
    expect(alarms[0].key.fingerprint).toBe(real);
    // the store was not quietly updated to the key that was just presented
    expect(await storedFingerprints()).not.toContain(real);
  });

  test('"Forget Host Key" is what unblocks a changed key', async () => {
    await connectAndUse('accept-new');
    const content = await fsp.readFile(storePath, 'utf8');
    const entry = parseKnownHosts(content, storePath)[0];
    const impostor = Buffer.from(entry.keyBase64, 'base64');
    impostor[impostor.length - 1] ^= 0xff;
    await fsp.writeFile(
      storePath,
      `${TOKEN} ${entry.keyType} ${impostor.toString('base64')}\n`
    );

    await expect(connect('accept-new')).rejects.toThrow(/IDENTIFICATION HAS CHANGED/);

    await forgetHostKey(SSH_HOST, SSH_PORT, [storePath]);

    await connectAndUse('accept-new');
    expect(await storedFingerprints()).toHaveLength(1);
  });

  test('a @revoked entry refuses the connection outright', async () => {
    await connectAndUse('accept-new');
    const entry = parseKnownHosts(await fsp.readFile(storePath, 'utf8'), storePath)[0];
    await fsp.writeFile(
      storePath,
      `@revoked ${TOKEN} ${entry.keyType} ${entry.keyBase64}\n`
    );

    await expect(connect('no')).rejects.toThrow(/@revoked/);
  });

  test('strictHostKeyChecking: false connects even when the stored key differs', async () => {
    await connectAndUse('accept-new');
    const entry = parseKnownHosts(await fsp.readFile(storePath, 'utf8'), storePath)[0];
    const impostor = Buffer.from(entry.keyBase64, 'base64');
    impostor[impostor.length - 1] ^= 0xff;
    await fsp.writeFile(
      storePath,
      `${TOKEN} ${entry.keyType} ${impostor.toString('base64')}\n`
    );

    // the documented escape hatch, and the only value that allows this
    await expect(connectAndUse(false)).resolves.toBeUndefined();
  });
});

/**
 * The same assertion against a server key that really did change, rather than
 * one we edited in the store. Recreating the container is what regenerates the
 * host keys (the entrypoint runs `ssh-keygen -A` on a fresh filesystem).
 *
 * Skipped where the docker CLI is not on PATH, so the rest of the suite still
 * runs against an already-started stack.
 */
const hasDocker = (() => {
  try {
    require('child_process').execFileSync('docker', ['--version'], { stdio: 'ignore' });
    return fs.existsSync(COMPOSE_FILE);
  } catch {
    return false;
  }
})();

(hasDocker ? describe : describe.skip)('a regenerated server host key', () => {
  test(
    'is refused rather than silently re-established',
    async () => {
      await connectAndUse('accept-new');
      const before = await storedFingerprints();
      expect(before).toHaveLength(1);

      // fresh container => fresh /etc/ssh/ssh_host_* keys
      await execFileAsync(
        'docker',
        ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--force-recreate', '--wait', 'openssh'],
        { timeout: 180 * 1000 }
      );

      const { prompt, alarms } = recordingPrompt('connect-and-remember');
      await expect(connect('accept-new', prompt)).rejects.toThrow(
        /REMOTE HOST IDENTIFICATION HAS CHANGED/
      );

      expect(alarms).toHaveLength(1);
      expect(alarms[0].known.map(entry => entry.fingerprint)).toEqual(before);
      expect(alarms[0].key.fingerprint).not.toBe(before[0]);
      // and the store still holds the old key: nothing was learned behind the
      // user's back
      expect(await storedFingerprints()).toEqual(before);

      // only forgetting it lets the connection through
      await forgetHostKey(SSH_HOST, SSH_PORT, [storePath]);
      await connectAndUse('accept-new');
      expect(await storedFingerprints()).not.toEqual(before);
    },
    240 * 1000
  );
});
