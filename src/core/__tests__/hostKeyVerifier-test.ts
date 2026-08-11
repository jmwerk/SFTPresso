import { randomBytes } from 'crypto';
import logger from '../../logger';
import {
  HostKeyInfo,
  KnownHostEntry,
  StrictHostKeyChecking,
  describeHostKey,
  parseKnownHosts,
} from '../remote-client/hostKeyStore';
import {
  ChangedHostKeyContext,
  HostKeyError,
  HostKeyPrompt,
  UnknownHostAnswer,
  UnknownHostPromptContext,
  verifyHostKey,
} from '../remote-client/hostKeyVerifier';

function keyBlob(type: string, body: Buffer = randomBytes(32)): Buffer {
  const name = Buffer.from(type, 'ascii');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(name.length, 0);
  return Buffer.concat([header, name, body]);
}

const SERVER_KEY = keyBlob('ssh-ed25519');
const OTHER_KEY = keyBlob('ssh-ed25519');

function storeWith(...lines: string[]): () => Promise<KnownHostEntry[]> {
  return async () => parseKnownHosts(lines.join('\n'), '/home/u/.ssh/known_hosts');
}

function entryFor(key: Buffer, host = 'example.com', marker = ''): string {
  const info = describeHostKey(key);
  return `${marker}${marker ? ' ' : ''}${host} ${info.type} ${info.base64}`;
}

function fakePrompt(answer: UnknownHostAnswer = 'cancel'): jest.Mocked<HostKeyPrompt> {
  return {
    confirmUnknownHost: jest.fn(async (_ctx: UnknownHostPromptContext) => answer),
    reportChangedHostKey: jest.fn((_ctx: ChangedHostKeyContext) => undefined),
  };
}

interface RunOption {
  policy: StrictHostKeyChecking;
  store?: () => Promise<KnownHostEntry[]>;
  prompt?: HostKeyPrompt;
  key?: Buffer;
  port?: number;
}

function run(option: RunOption) {
  const remembered: Array<{ host: string; port?: number; key: HostKeyInfo }> = [];
  const promise = verifyHostKey({
    host: 'example.com',
    port: option.port === undefined ? 22 : option.port,
    key: option.key || SERVER_KEY,
    policy: option.policy,
    prompt: option.prompt,
    loadKnownHosts: option.store || storeWith(),
    remember: async (host, port, key) => {
      remembered.push({ host, port, key });
    },
  });
  return { promise, remembered };
}

let warn: jest.SpyInstance;
let error: jest.SpyInstance;
let info: jest.SpyInstance;

beforeEach(() => {
  warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const POLICIES: StrictHostKeyChecking[] = ['yes', 'accept-new', 'ask', 'no'];

describe('verifyHostKey — a key already in the store', () => {
  test.each(POLICIES)('is accepted under %s, without prompting', async policy => {
    const prompt = fakePrompt();
    const { promise, remembered } = run({
      policy,
      store: storeWith(entryFor(SERVER_KEY)),
      prompt,
    });

    await expect(promise).resolves.toBeUndefined();
    expect(prompt.confirmUnknownHost).not.toHaveBeenCalled();
    // nothing to learn, so nothing is written
    expect(remembered).toHaveLength(0);
  });

  test('a host recorded under its bracketed non-default port is matched', async () => {
    const { promise } = run({
      policy: 'yes',
      port: 2222,
      store: storeWith(entryFor(SERVER_KEY, '[example.com]:2222')),
    });

    await expect(promise).resolves.toBeUndefined();
  });
});

describe('verifyHostKey — an unknown host', () => {
  test('accept-new accepts it and remembers the key', async () => {
    const { promise, remembered } = run({ policy: 'accept-new' });

    await expect(promise).resolves.toBeUndefined();
    expect(remembered).toHaveLength(1);
    expect(remembered[0].key.fingerprint).toBe(describeHostKey(SERVER_KEY).fingerprint);
  });

  test('yes refuses it and says how to get past it', async () => {
    const { promise, remembered } = run({ policy: 'yes' });

    await expect(promise).rejects.toBeInstanceOf(HostKeyError);
    await expect(promise).rejects.toThrow(/authenticity of host example\.com cannot be established/);
    expect(remembered).toHaveLength(0);
  });

  test('ask prompts with the host, port and fingerprint', async () => {
    const prompt = fakePrompt('connect-and-remember');
    const { promise, remembered } = run({ policy: 'ask', prompt, port: 2222 });

    await expect(promise).resolves.toBeUndefined();
    expect(prompt.confirmUnknownHost).toHaveBeenCalledWith({
      host: 'example.com',
      port: 2222,
      key: describeHostKey(SERVER_KEY),
    });
    expect(remembered).toHaveLength(1);
  });

  test('ask + "connect once" connects without writing anything down', async () => {
    const prompt = fakePrompt('connect');
    const { promise, remembered } = run({ policy: 'ask', prompt });

    await expect(promise).resolves.toBeUndefined();
    expect(remembered).toHaveLength(0);
  });

  test('ask + cancel refuses the connection', async () => {
    const prompt = fakePrompt('cancel');
    const { promise, remembered } = run({ policy: 'ask', prompt });

    await expect(promise).rejects.toThrow(/was not accepted/);
    expect(remembered).toHaveLength(0);
  });

  test('ask with no way to prompt refuses rather than connecting blind', async () => {
    const { promise } = run({ policy: 'ask' });
    await expect(promise).rejects.toThrow(/no way to ask/);
  });
});

describe('verifyHostKey — a changed key', () => {
  const changed = storeWith(entryFor(OTHER_KEY));

  test.each<StrictHostKeyChecking>(['yes', 'accept-new', 'ask'])(
    '%s refuses it, naming both fingerprints',
    async policy => {
      const prompt = fakePrompt('connect-and-remember');
      const { promise, remembered } = run({ policy, store: changed, prompt });

      await expect(promise).rejects.toBeInstanceOf(HostKeyError);
      const message = await promise.catch(err => err.message);
      expect(message).toContain('REMOTE HOST IDENTIFICATION HAS CHANGED');
      expect(message).toContain(describeHostKey(SERVER_KEY).fingerprint);
      expect(message).toContain(describeHostKey(OTHER_KEY).fingerprint);
      expect(message).toContain('SFTP: Forget Host Key');

      // even "connect and remember" must not become a one-click override
      expect(prompt.confirmUnknownHost).not.toHaveBeenCalled();
      expect(remembered).toHaveLength(0);
    }
  );

  test('accept-new accepts unknown hosts but still refuses changed ones', async () => {
    await expect(run({ policy: 'accept-new' }).promise).resolves.toBeUndefined();
    await expect(run({ policy: 'accept-new', store: changed }).promise).rejects.toThrow(
      /IDENTIFICATION HAS CHANGED/
    );
  });

  test('the alarm is shown to the user and logged at error level', async () => {
    const prompt = fakePrompt();
    await expect(run({ policy: 'accept-new', store: changed, prompt }).promise).rejects.toThrow();

    expect(prompt.reportChangedHostKey).toHaveBeenCalledTimes(1);
    const ctx = prompt.reportChangedHostKey.mock.calls[0][0];
    expect(ctx.known[0]).toMatchObject({
      fingerprint: describeHostKey(OTHER_KEY).fingerprint,
      source: '/home/u/.ssh/known_hosts',
      lineNumber: 1,
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('IDENTIFICATION HAS CHANGED'));
  });

  test('"no" is the documented escape hatch and lets it through, loudly', async () => {
    const { promise } = run({ policy: 'no', store: changed });

    await expect(promise).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('IDENTIFICATION HAS CHANGED'));
  });
});

describe('verifyHostKey — keys that are refused whatever the policy', () => {
  test.each(POLICIES)('a @revoked key is refused under %s', async policy => {
    const { promise } = run({
      policy,
      store: storeWith(entryFor(SERVER_KEY, 'example.com', '@revoked')),
    });

    await expect(promise).rejects.toThrow(/@revoked/);
  });

  test.each(POLICIES)('a certificate host key is refused under %s', async policy => {
    const { promise } = run({
      policy,
      key: keyBlob('ssh-ed25519-cert-v01@openssh.com'),
    });

    await expect(promise).rejects.toThrow(/certificate host key/);
  });

  test('a certificate is refused before the store is even consulted', async () => {
    const load = jest.fn(storeWith());
    await expect(
      verifyHostKey({
        host: 'example.com',
        port: 22,
        key: keyBlob('ssh-rsa-cert-v01@openssh.com'),
        policy: 'no',
        loadKnownHosts: load,
        remember: async () => undefined,
      })
    ).rejects.toThrow(/certificate host key/);
    expect(load).not.toHaveBeenCalled();
  });
});

describe('verifyHostKey — logging', () => {
  test('accepting a new host under accept-new is recorded', async () => {
    await run({ policy: 'accept-new' }).promise;
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(describeHostKey(SERVER_KEY).fingerprint)
    );
  });
});
