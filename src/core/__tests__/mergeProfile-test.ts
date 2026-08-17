import mergeProfile from '../mergeProfile';

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
