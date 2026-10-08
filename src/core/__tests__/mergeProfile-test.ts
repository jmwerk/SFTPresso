import mergeProfile, { omitInherited } from '../mergeProfile';

describe('mergeProfile', () => {
  test('deep-merges syncOption without changing unrelated base options', () => {
    expect(
      mergeProfile(
        { syncOption: { delete: false, skipCreate: false, ignoreExisting: false, update: true } },
        { syncOption: { delete: true } }
      )
    ).toEqual({ syncOption: { delete: true, skipCreate: false, ignoreExisting: false, update: true } });
  });

  test('deep-merges remoteExplorer and watcher settings', () => {
    expect(
      mergeProfile(
        {
          remoteExplorer: { filesExclude: ['.git'], order: 3 },
          watcher: { files: '**/*', autoUpload: true, autoDelete: false, autoRename: false },
        },
        {
          remoteExplorer: { filesExclude: ['node_modules'] },
          watcher: { autoRename: true },
        }
      )
    ).toEqual({
      remoteExplorer: { filesExclude: ['node_modules'], order: 3 },
      watcher: { files: '**/*', autoUpload: true, autoDelete: false, autoRename: true },
    });
  });

  test('concatenates ignore even when the base config omits it', () => {
    expect(mergeProfile({}, { ignore: ['*.tmp'] })).toEqual({ ignore: ['*.tmp'] });
  });

  test('does not recursively merge unrelated nested settings', () => {
    expect(
      mergeProfile({ algorithms: { kex: ['curve25519'], cipher: ['aes256-ctr'] } }, { algorithms: { kex: ['ecdh'] } })
    ).toEqual({ algorithms: { kex: ['ecdh'] } });
  });
});

describe('omitInherited', () => {
  const base = {
    name: 'example-site',
    protocol: 'sftp',
    host: '203.0.113.10',
    port: 2222,
    username: 'example-site',
    agent: '/tmp/agent.sock',
    remotePath: '/www/site/public',
    uploadOnSave: false,
    strictHostKeyChecking: 'ask',
    ignore: ['.git', 'node_modules'],
    syncOption: { delete: false, skipCreate: false, ignoreExisting: false, update: true },
    profiles: { other: { port: 1 } },
  };

  test('keeps only what differs from the base config', () => {
    const profile = { ...base, port: 2223 };
    delete (profile as any).profiles;

    expect(omitInherited(profile, base)).toEqual({ port: 2223 });
  });

  test('keeps keys the base config does not set', () => {
    expect(omitInherited({ host: base.host, concurrency: 8 }, base)).toEqual({ concurrency: 8 });
  });

  test('keeps only ignore patterns the base config lacks', () => {
    expect(omitInherited({ ignore: ['.git', 'dist'] }, base)).toEqual({ ignore: ['dist'] });
    expect(omitInherited({ ignore: ['node_modules', '.git'] }, base)).toEqual({});
  });

  test('keeps only the changed keys of a deep-merged option', () => {
    expect(
      omitInherited(
        { syncOption: { delete: true, skipCreate: false, ignoreExisting: false, update: true } },
        base
      )
    ).toEqual({ syncOption: { delete: true } });
  });

  test('compares nested values by content', () => {
    const withHop = { ...base, hop: { host: 'bastion', port: 22 } };

    expect(omitInherited({ hop: { host: 'bastion', port: 22 } }, withHop)).toEqual({});
    expect(omitInherited({ hop: { host: 'bastion', port: 2222 } }, withHop)).toEqual({
      hop: { host: 'bastion', port: 2222 },
    });
  });

  test('merging the trimmed profile gives the same config as the full one', () => {
    const profile = {
      ...base,
      port: 2223,
      ignore: ['.git', 'dist'],
      syncOption: { ...base.syncOption, delete: true },
    };
    delete (profile as any).profiles;
    const dedupe = (config: any) => ({ ...config, ignore: Array.from(new Set(config.ignore)) });

    expect(dedupe(mergeProfile(base, omitInherited(profile, base)))).toEqual(
      dedupe(mergeProfile(base, profile))
    );
  });
});
