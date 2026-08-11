import { createHmac, randomBytes } from 'crypto';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  describeHostKey,
  entryMatchesHost,
  fingerprintOfEntry,
  forgetHostKey,
  hostToken,
  isCertificateKeyType,
  lookupHostKey,
  normalizeStrictHostKeyChecking,
  parseKnownHosts,
  rememberHostKey,
  setManagedStorePath,
} from '../remote-client/hostKeyStore';

/**
 * Builds a syntactically real SSH public key blob: a length-prefixed algorithm
 * name followed by opaque bytes. The bytes do not have to be a valid key for
 * any of this — fingerprinting and known_hosts matching treat the blob as
 * opaque — but the length prefix does have to be right, because that is what
 * the key type is read out of.
 */
function keyBlob(type: string, body: Buffer = randomBytes(32)): Buffer {
  const name = Buffer.from(type, 'ascii');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(name.length, 0);
  return Buffer.concat([header, name, body]);
}

function hashedPattern(token: string): string {
  const salt = randomBytes(20);
  const hash = createHmac('sha1', salt)
    .update(token)
    .digest();
  return `|1|${salt.toString('base64')}|${hash.toString('base64')}`;
}

describe('describeHostKey', () => {
  test('reads the key type out of the blob', () => {
    expect(describeHostKey(keyBlob('ssh-ed25519')).type).toBe('ssh-ed25519');
    expect(describeHostKey(keyBlob('ecdsa-sha2-nistp256')).type).toBe('ecdsa-sha2-nistp256');
  });

  test('fingerprints in the OpenSSH SHA256 form, base64 and unpadded', () => {
    // ssh-keygen -lf prints "256 SHA256:<43 chars of unpadded base64> comment",
    // so anything hex, or padded with '=', cannot be compared by eye against it
    const { fingerprint } = describeHostKey(keyBlob('ssh-ed25519'));
    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(fingerprint).not.toContain('=');
  });

  test('the same key always fingerprints the same, a different one does not', () => {
    const blob = keyBlob('ssh-ed25519');
    expect(describeHostKey(blob).fingerprint).toBe(describeHostKey(blob).fingerprint);
    expect(describeHostKey(blob).fingerprint).not.toBe(
      describeHostKey(keyBlob('ssh-ed25519')).fingerprint
    );
  });

  test('a malformed blob degrades instead of throwing', () => {
    expect(describeHostKey(Buffer.alloc(0)).type).toBe('unknown');
    expect(describeHostKey(Buffer.from([0xff, 0xff, 0xff, 0xff])).type).toBe('unknown');
  });

  test('certificate key types are recognised', () => {
    expect(isCertificateKeyType('ssh-ed25519-cert-v01@openssh.com')).toBe(true);
    expect(isCertificateKeyType('ssh-ed25519')).toBe(false);
  });
});

describe('hostToken', () => {
  test('is the bare host on the default port and bracketed otherwise', () => {
    expect(hostToken('example.com', 22)).toBe('example.com');
    expect(hostToken('example.com')).toBe('example.com');
    expect(hostToken('example.com', 2222)).toBe('[example.com]:2222');
  });

  test('a port that arrived as a string is still a number', () => {
    // ssh config resolution and hand-written hop entries can leave it as one;
    // "[example.com]:22" would match no known_hosts file anywhere
    expect(hostToken('example.com', '22' as any)).toBe('example.com');
    expect(hostToken('example.com', '2222' as any)).toBe('[example.com]:2222');
  });
});

describe('parseKnownHosts', () => {
  test('parses a plain entry, keeping the source and line number', () => {
    const entries = parseKnownHosts(
      '# a comment\n\nexample.com ssh-ed25519 AAAAB3 a comment at the end\n',
      '/known_hosts'
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      patterns: ['example.com'],
      keyType: 'ssh-ed25519',
      keyBase64: 'AAAAB3',
      source: '/known_hosts',
      lineNumber: 3,
      marker: undefined,
    });
  });

  test('splits comma-separated host lists', () => {
    const [entry] = parseKnownHosts('a.example,b.example,1.2.3.4 ssh-rsa AAAA', '/kh');
    expect(entry.patterns).toEqual(['a.example', 'b.example', '1.2.3.4']);
  });

  test('keeps @revoked and @cert-authority markers', () => {
    const entries = parseKnownHosts(
      '@revoked bad.example ssh-rsa AAAA\n@cert-authority *.example ssh-rsa BBBB\n',
      '/kh'
    );
    expect(entries.map(entry => entry.marker)).toEqual(['revoked', 'cert-authority']);
  });

  test('drops a line with a marker it does not understand rather than trusting it', () => {
    expect(parseKnownHosts('@something-new host ssh-rsa AAAA', '/kh')).toHaveLength(0);
  });

  test('ignores truncated lines', () => {
    expect(parseKnownHosts('example.com ssh-rsa', '/kh')).toHaveLength(0);
  });
});

describe('entryMatchesHost', () => {
  const entryFor = (patterns: string) =>
    parseKnownHosts(`${patterns} ssh-ed25519 AAAA`, '/kh')[0];

  test('matches a plain hostname exactly', () => {
    expect(entryMatchesHost(entryFor('example.com'), 'example.com')).toBe(true);
    expect(entryMatchesHost(entryFor('example.com'), 'other.com')).toBe(false);
    // a bare hostname must not match the bracketed non-default-port form
    expect(entryMatchesHost(entryFor('example.com'), '[example.com]:2222')).toBe(false);
  });

  test('matches a bracketed host:port entry', () => {
    expect(entryMatchesHost(entryFor('[example.com]:2222'), '[example.com]:2222')).toBe(true);
    expect(entryMatchesHost(entryFor('[example.com]:2222'), '[example.com]:2022')).toBe(false);
  });

  test('honors * and ? wildcards', () => {
    expect(entryMatchesHost(entryFor('*.example.com'), 'host.example.com')).toBe(true);
    expect(entryMatchesHost(entryFor('*.example.com'), 'example.com')).toBe(false);
    expect(entryMatchesHost(entryFor('host?.example.com'), 'host1.example.com')).toBe(true);
    expect(entryMatchesHost(entryFor('host?.example.com'), 'host12.example.com')).toBe(false);
  });

  test('a dot is literal, not a wildcard', () => {
    expect(entryMatchesHost(entryFor('a.example.com'), 'aXexample.com')).toBe(false);
  });

  test('a negated pattern vetoes the whole entry', () => {
    const entry = entryFor('*.example.com,!secret.example.com');
    expect(entryMatchesHost(entry, 'ok.example.com')).toBe(true);
    expect(entryMatchesHost(entry, 'secret.example.com')).toBe(false);
  });

  test('matches hashed entries, which is what HashKnownHosts writes', () => {
    const entry = parseKnownHosts(
      `${hashedPattern('example.com')} ssh-ed25519 AAAA`,
      '/kh'
    )[0];

    expect(entryMatchesHost(entry, 'example.com')).toBe(true);
    expect(entryMatchesHost(entry, 'evil.com')).toBe(false);
  });

  test('a hashed entry for a non-default port hashes the bracketed form', () => {
    const entry = parseKnownHosts(
      `${hashedPattern('[example.com]:2222')} ssh-ed25519 AAAA`,
      '/kh'
    )[0];

    expect(entryMatchesHost(entry, hostToken('example.com', 2222))).toBe(true);
    expect(entryMatchesHost(entry, hostToken('example.com', 22))).toBe(false);
  });

  test('a malformed hashed entry matches nothing rather than everything', () => {
    const entry = parseKnownHosts('|9|zzz|zzz ssh-ed25519 AAAA', '/kh')[0];
    expect(entryMatchesHost(entry, 'example.com')).toBe(false);
  });
});

describe('lookupHostKey', () => {
  const key = describeHostKey(keyBlob('ssh-ed25519'));
  const otherKey = describeHostKey(keyBlob('ssh-ed25519'));
  const rsaKey = describeHostKey(keyBlob('ssh-rsa'));

  const store = (lines: string[]) => parseKnownHosts(lines.join('\n'), '/kh');

  test('accepts a key already recorded for the host', () => {
    const result = lookupHostKey(
      store([`example.com ${key.type} ${key.base64}`]),
      'example.com',
      key
    );
    expect(result.verdict).toBe('match');
  });

  test('an unrecorded host is unknown', () => {
    expect(lookupHostKey(store([]), 'example.com', key).verdict).toBe('unknown');
  });

  test('a different key of the same type for a known host is a change', () => {
    const result = lookupHostKey(
      store([`example.com ${otherKey.type} ${otherKey.base64}`]),
      'example.com',
      key
    );

    expect(result.verdict).toBe('changed');
    expect(result.conflicting).toHaveLength(1);
    expect(fingerprintOfEntry(result.conflicting[0])).toBe(otherKey.fingerprint);
  });

  test('a key for a *different* host is not a change', () => {
    const result = lookupHostKey(
      store([`other.example ${otherKey.type} ${otherKey.base64}`]),
      'example.com',
      key
    );
    expect(result.verdict).toBe('unknown');
  });

  test('a new key type for a known host is unknown, not changed', () => {
    // a server that grew an ed25519 key next to its RSA one is an ordinary
    // upgrade; alarming there would train users to click through the alarm
    const result = lookupHostKey(
      store([`example.com ${rsaKey.type} ${rsaKey.base64}`]),
      'example.com',
      key
    );
    expect(result.verdict).toBe('unknown');
  });

  test('a revoked key is refused even though it is recorded', () => {
    const result = lookupHostKey(
      store([`@revoked example.com ${key.type} ${key.base64}`]),
      'example.com',
      key
    );
    expect(result.verdict).toBe('revoked');
  });

  test('a revoked entry is not treated as a conflicting key either', () => {
    const result = lookupHostKey(
      store([`@revoked example.com ${otherKey.type} ${otherKey.base64}`]),
      'example.com',
      key
    );
    expect(result.verdict).toBe('unknown');
  });

  test('a wildcard @cert-authority line neither accepts nor blocks a plain key', () => {
    // `@cert-authority * ...` is a common org-wide line; treating it as a
    // conflict would refuse every host the user has
    const result = lookupHostKey(
      store([`@cert-authority * ${otherKey.type} ${otherKey.base64}`]),
      'example.com',
      key
    );
    expect(result.verdict).toBe('unknown');
  });

  test('a matching entry wins over a stale conflicting one on a later line', () => {
    const result = lookupHostKey(
      store([
        `example.com ${otherKey.type} ${otherKey.base64}`,
        `example.com ${key.type} ${key.base64}`,
      ]),
      'example.com',
      key
    );
    expect(result.verdict).toBe('match');
  });
});

describe('normalizeStrictHostKeyChecking', () => {
  test('maps the config spellings onto OpenSSH ones', () => {
    expect(normalizeStrictHostKeyChecking(true)).toBe('yes');
    expect(normalizeStrictHostKeyChecking('yes')).toBe('yes');
    expect(normalizeStrictHostKeyChecking(false)).toBe('no');
    expect(normalizeStrictHostKeyChecking('no')).toBe('no');
    expect(normalizeStrictHostKeyChecking('ask')).toBe('ask');
    expect(normalizeStrictHostKeyChecking('accept-new')).toBe('accept-new');
  });

  test('anything unrecognised falls back to the default, never to off', () => {
    expect(normalizeStrictHostKeyChecking(undefined)).toBe('accept-new');
    expect(normalizeStrictHostKeyChecking('nonsense')).toBe('accept-new');
    expect(normalizeStrictHostKeyChecking(null)).toBe('accept-new');
  });
});

describe('the managed store on disk', () => {
  let dir: string;
  let storePath: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sftpresso-hostkeys-'));
    storePath = path.join(dir, 'known_hosts');
    setManagedStorePath(storePath);
  });

  afterEach(async () => {
    setManagedStorePath(undefined);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('a remembered key is written in known_hosts format and read back as a match', async () => {
    const key = describeHostKey(keyBlob('ssh-ed25519'));
    await rememberHostKey('example.com', 2222, key);

    const content = await fsp.readFile(storePath, 'utf8');
    expect(content).toContain(`[example.com]:2222 ${key.type} ${key.base64}`);

    const entries = parseKnownHosts(content, storePath);
    expect(lookupHostKey(entries, hostToken('example.com', 2222), key).verdict).toBe('match');
  });

  test('remembering creates the directory when it does not exist yet', async () => {
    const nested = path.join(dir, 'deep', 'er', 'known_hosts');
    setManagedStorePath(nested);

    await rememberHostKey('example.com', 22, describeHostKey(keyBlob('ssh-ed25519')));

    await expect(fsp.readFile(nested, 'utf8')).resolves.toContain('example.com');
  });

  test('forgetting removes only the matching host, leaving the file otherwise intact', async () => {
    const mine = describeHostKey(keyBlob('ssh-ed25519'));
    const theirs = describeHostKey(keyBlob('ssh-ed25519'));
    await fsp.writeFile(
      storePath,
      [
        '# a comment worth keeping',
        `keep.example ${theirs.type} ${theirs.base64}`,
        `example.com ${mine.type} ${mine.base64}`,
        '',
      ].join('\n')
    );

    const result = await forgetHostKey('example.com', 22, [storePath]);

    expect(result.removed).toEqual([{ source: storePath, count: 1 }]);
    expect(result.failed).toEqual([]);
    const content = await fsp.readFile(storePath, 'utf8');
    expect(content).toBe(
      `# a comment worth keeping\nkeep.example ${theirs.type} ${theirs.base64}\n`
    );
  });

  test('forgetting a host with no entries changes nothing', async () => {
    await fsp.writeFile(storePath, 'keep.example ssh-rsa AAAA\n');

    const result = await forgetHostKey('absent.example', 22, [storePath]);

    expect(result.removed).toEqual([]);
    await expect(fsp.readFile(storePath, 'utf8')).resolves.toBe('keep.example ssh-rsa AAAA\n');
  });

  test('forgetting tolerates a store that was never written', async () => {
    const result = await forgetHostKey('example.com', 22, [path.join(dir, 'missing')]);
    expect(result).toEqual({ removed: [], failed: [] });
  });

  test('a remembered key stops being trusted once forgotten', async () => {
    const key = describeHostKey(keyBlob('ssh-ed25519'));
    await rememberHostKey('example.com', 22, key);
    await forgetHostKey('example.com', 22, [storePath]);

    const entries = parseKnownHosts(await fsp.readFile(storePath, 'utf8'), storePath);
    expect(lookupHostKey(entries, 'example.com', key).verdict).toBe('unknown');
  });
});
