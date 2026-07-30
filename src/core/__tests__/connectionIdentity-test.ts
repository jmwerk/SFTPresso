import { connectionIdentity } from '../connectionIdentity';

const base = {
  protocol: 'sftp',
  host: 'example.com',
  port: 22,
  username: 'user1',
  password: 'secret',
  connectTimeout: 10000,
};

describe('connectionIdentity', () => {
  test('is stable for the same options', () => {
    expect(connectionIdentity({ ...base })).toBe(connectionIdentity({ ...base }));
  });

  test('ignores key insertion order', () => {
    const a = { host: 'example.com', port: 22, username: 'user1' };
    const b = { username: 'user1', host: 'example.com', port: 22 };
    expect(connectionIdentity(a)).toBe(connectionIdentity(b));
  });

  test('an absent option matches one explicitly undefined', () => {
    expect(connectionIdentity({ ...base, agent: undefined })).toBe(
      connectionIdentity({ ...base })
    );
  });

  test('function values (the injected debug callback) do not affect identity', () => {
    expect(connectionIdentity({ ...base, debug: () => undefined })).toBe(
      connectionIdentity({ ...base })
    );
  });

  describe('collisions the previous value-concatenation hash allowed', () => {
    test('unseparated values: {host:foo,username:bar} vs {host:foob,username:ar}', () => {
      expect(connectionIdentity({ host: 'foo', username: 'bar' })).not.toBe(
        connectionIdentity({ host: 'foob', username: 'ar' })
      );
    });

    test('different hop chains to the same host', () => {
      const viaA = {
        ...base,
        hop: { host: 'bastion-a.example.com', port: 22, username: 'jump' },
      };
      const viaB = {
        ...base,
        hop: { host: 'bastion-b.example.com', port: 22, username: 'jump' },
      };
      expect(connectionIdentity(viaA)).not.toBe(connectionIdentity(viaB));
      expect(connectionIdentity(viaA)).not.toBe(connectionIdentity({ ...base }));
    });

    test('hop order is significant', () => {
      const a = { ...base, hop: [{ host: 'a' }, { host: 'b' }] };
      const b = { ...base, hop: [{ host: 'b' }, { host: 'a' }] };
      expect(connectionIdentity(a)).not.toBe(connectionIdentity(b));
    });

    test('a single hop object is not the same as a one-element hop array', () => {
      expect(connectionIdentity({ ...base, hop: { host: 'a' } })).not.toBe(
        connectionIdentity({ ...base, hop: [{ host: 'a' }] })
      );
    });

    test('different algorithms', () => {
      const a = { ...base, algorithms: { cipher: ['aes128-ctr'] } };
      const b = { ...base, algorithms: { cipher: ['aes256-ctr'] } };
      expect(connectionIdentity(a)).not.toBe(connectionIdentity(b));
    });

    test('different secureOptions', () => {
      const a = { ...base, protocol: 'ftp', port: 21, secureOptions: { maxVersion: 'TLSv1.2' } };
      const b = { ...base, protocol: 'ftp', port: 21, secureOptions: { maxVersion: 'TLSv1.3' } };
      expect(connectionIdentity(a)).not.toBe(connectionIdentity(b));
    });

    test('nested values keep their type', () => {
      expect(connectionIdentity({ ...base, port: 22 })).not.toBe(
        connectionIdentity({ ...base, port: '22' as any })
      );
      expect(connectionIdentity({ ...base, secure: true })).not.toBe(
        connectionIdentity({ ...base, secure: 'true' as any })
      );
    });
  });

  test('a changed password invalidates the identity', () => {
    expect(connectionIdentity({ ...base, password: 'other' })).not.toBe(
      connectionIdentity({ ...base })
    );
  });

  test('never exposes secret material', () => {
    const identity = connectionIdentity({
      ...base,
      password: 'sup3r-s3cret',
      passphrase: 'key-passphrase',
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
    });
    expect(identity).not.toContain('sup3r-s3cret');
    expect(identity).not.toContain('key-passphrase');
    expect(identity).not.toContain('BEGIN OPENSSH PRIVATE KEY');
  });

  test('carries a readable protocol://username@host:port prefix', () => {
    expect(connectionIdentity({ ...base })).toMatch(
      /^sftp:\/\/user1@example\.com:22#[0-9a-f]{64}$/
    );
    expect(connectionIdentity({ protocol: 'ftp', host: 'example.com', username: 'u' })).toMatch(
      /^ftp:\/\/u@example\.com:21#/
    );
  });

  test('survives a cyclic option object', () => {
    const cyclic: any = { ...base };
    cyclic.self = cyclic;
    expect(() => connectionIdentity(cyclic)).not.toThrow();
  });

  test('round-trips for create/remove of the same config', () => {
    // createRemoteIfNoneExist and removeRemoteFs must derive the same key or
    // disposing a FileService leaks its pooled connection
    const config = { ...base, hop: [{ host: 'a', port: 22 }], algorithms: { cipher: ['x'] } };
    expect(connectionIdentity(config)).toBe(connectionIdentity({ ...config }));
  });
});
