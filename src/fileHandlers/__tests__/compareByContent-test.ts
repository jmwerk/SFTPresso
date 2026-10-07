import MemFs from '../../core/__tests__/helpers/memFs';
import { ContentHasher } from '../../core/contentHash';
import TransferTask from '../../core/transferTask';
import { compareFolders, countRecheckable, recheckByContent } from '../compareFolders';
import { computeSyncPlan } from '../syncPreview';
import { sync, TransferDirection } from '../transfer/transfer';

/**
 * compareMode: "content" end to end over in-memory trees: the compare walk,
 * the sync walk in every direction, and the preview plan built on top.
 *
 *   same.txt      identical bytes, different mtimes      → identical
 *   touched.txt   identical bytes, same mtime            → identical
 *   edited.txt    same size, different bytes, same mtime → modified (mtime would miss it)
 *   grown.txt     different size                         → modified, never read
 *   sub/deep.txt  same size, different bytes             → modified
 */
function trees() {
  const local = new MemFs('/local')
    .file('/local/same.txt', 'hello', 5000)
    .file('/local/touched.txt', 'abc', 1000)
    .file('/local/edited.txt', 'v1', 1000)
    .file('/local/grown.txt', 'longer', 1000)
    .dir('/local/sub')
    .file('/local/sub/deep.txt', 'aaaa', 1000);
  const remote = new MemFs('/remote')
    .file('/remote/same.txt', 'hello', 1000)
    .file('/remote/touched.txt', 'abc', 1000)
    .file('/remote/edited.txt', 'v2', 1000)
    .file('/remote/grown.txt', 'short', 1000)
    .dir('/remote/sub')
    .file('/remote/sub/deep.txt', 'bbbb', 1000);
  return { local, remote };
}

function contextFor(local: MemFs, remote: MemFs, compareMode?: 'mtime' | 'content'): any {
  return {
    config: { compareMode },
    target: { localFsPath: '/local', remoteFsPath: '/remote' },
    fileService: {
      getLocalFileSystem: () => local,
      getRemoteFileSystem: async () => remote,
    },
  };
}

const statuses = (results: Array<{ relativePath: string; status: string }>) =>
  Object.fromEntries(results.map(r => [r.relativePath, r.status]));

describe('compareFolders with compareMode "content"', () => {
  test('classifies files by their bytes, not their timestamps', async () => {
    const { local, remote } = trees();
    const results = await compareFolders(contextFor(local, remote, 'content'));

    expect(statuses(results)).toEqual({
      'edited.txt': 'modified',
      'grown.txt': 'modified',
      'same.txt': 'same',
      'sub/deep.txt': 'modified',
      'touched.txt': 'same',
    });
    // only same.txt was called modified by its timestamp alone
    expect(results.filter(r => r.timestampOnly).map(r => r.relativePath)).toEqual(['same.txt']);
    // a size difference settles it without a read
    expect(remote.reads).not.toContain('/remote/grown.txt');
  });

  test('mtime mode reads nothing and keeps the old classification', async () => {
    const { local, remote } = trees();
    const results = await compareFolders(contextFor(local, remote));

    expect(statuses(results)['same.txt']).toBe('modified');
    expect(statuses(results)['edited.txt']).toBe('same');
    expect(local.reads).toEqual([]);
    expect(remote.reads).toEqual([]);
  });

  test('an unreadable file is reported as an error, not a difference', async () => {
    const { local, remote } = trees();
    remote.unreadable.add('/remote/touched.txt');
    const results = await compareFolders(contextFor(local, remote, 'content'));
    const touched = results.find(r => r.relativePath === 'touched.txt')!;

    expect(touched.status).toBe('error');
    expect(touched.error).toMatch(/permission denied/);
    // and the preview refuses to call it anything else
    const plan = computeSyncPlan(results, TransferDirection.LOCAL_TO_REMOTE, {});
    expect(plan.unreadable).toEqual(['touched.txt']);
    expect(plan.overwrite).not.toContain('touched.txt');
  });

  test('the preview counts files skipped for differing only in timestamp', async () => {
    const { local, remote } = trees();
    const results = await compareFolders(contextFor(local, remote, 'content'));
    const plan = computeSyncPlan(results, TransferDirection.LOCAL_TO_REMOTE, {});

    expect(plan.identical).toBe(1);
    expect(plan.overwrite.sort()).toEqual(['edited.txt', 'grown.txt', 'sub/deep.txt']);
  });
});

describe('recheckByContent', () => {
  test('clears timestamp-only differences from an mtime compare in place', async () => {
    const { local, remote } = trees();
    const ctx = contextFor(local, remote);
    const results = await compareFolders(ctx);
    // same.txt (same size, new mtime) can be settled; grown.txt cannot need it
    expect(countRecheckable(results)).toBe(1);

    await recheckByContent(ctx, results, new ContentHasher());

    const same = results.find(r => r.relativePath === 'same.txt')!;
    expect(same.status).toBe('same');
    expect(same.timestampOnly).toBe(true);
    expect(statuses(results)['grown.txt']).toBe('modified');
    expect(remote.reads).toEqual(['/remote/same.txt']);
  });

  test('a cancelled recheck leaves the results as they were', async () => {
    const { local, remote } = trees();
    const ctx = contextFor(local, remote);
    const results = await compareFolders(ctx);
    const hasher = new ContentHasher();
    hasher.cancel();

    await recheckByContent(ctx, results, hasher);

    expect(statuses(results)['same.txt']).toBe('modified');
  });
});

describe('sync with a content hasher', () => {
  async function run(
    direction: TransferDirection,
    option: Record<string, unknown> = {},
    hasher: ContentHasher | null = new ContentHasher()
  ) {
    const { local, remote } = trees();
    const toRemote = direction === TransferDirection.LOCAL_TO_REMOTE;
    const tasks: TransferTask[] = [];
    await sync(
      {
        srcFsPath: toRemote ? '/local' : '/remote',
        srcFs: toRemote ? local : remote,
        targetFsPath: toRemote ? '/remote' : '/local',
        targetFs: toRemote ? remote : local,
        transferDirection: direction,
        transferOption: { perserveTargetMode: false, ...option },
        hasher: hasher || undefined,
      },
      t => tasks.push(t)
    );
    return { tasks, local, remote };
  }

  const targets = (tasks: TransferTask[]) => tasks.map(t => t.targetFsPath).sort();

  test('local → remote transfers only what really differs', async () => {
    const { tasks } = await run(TransferDirection.LOCAL_TO_REMOTE);
    expect(targets(tasks)).toEqual([
      '/remote/edited.txt',
      '/remote/grown.txt',
      '/remote/sub/deep.txt',
    ]);
  });

  test('remote → local is content-aware too', async () => {
    const { tasks } = await run(TransferDirection.REMOTE_TO_LOCAL);
    expect(targets(tasks)).toEqual(['/local/edited.txt', '/local/grown.txt', '/local/sub/deep.txt']);
  });

  test('both directions no longer copies identical files back and forth', async () => {
    const { tasks } = await run(TransferDirection.LOCAL_TO_REMOTE, { bothDiretions: true });
    expect(tasks.map(t => t.targetFsPath)).not.toContain('/remote/same.txt');
    expect(tasks.map(t => t.targetFsPath)).not.toContain('/local/same.txt');
  });

  test('without a hasher the sync is unchanged', async () => {
    const { tasks } = await run(TransferDirection.LOCAL_TO_REMOTE, {}, null);
    expect(targets(tasks)).toEqual(['/remote/grown.txt', '/remote/same.txt']);
  });

  test('ignored files are never read', async () => {
    const { local } = await run(TransferDirection.LOCAL_TO_REMOTE, {
      ignore: (fsPath: string) => fsPath.endsWith('same.txt'),
    });
    expect(local.reads).not.toContain('/local/same.txt');
  });

  test('a file that cannot be hashed fails the sync instead of guessing', async () => {
    const { local, remote } = trees();
    remote.unreadable.add('/remote/edited.txt');
    await expect(
      sync(
        {
          srcFsPath: '/local',
          srcFs: local,
          targetFsPath: '/remote',
          targetFs: remote,
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: { perserveTargetMode: false },
          hasher: new ContentHasher(),
        },
        () => undefined
      )
    ).rejects.toThrow(/hash \/local\/edited.txt failed: permission denied/);
  });

  test('a sync reuses the hashes its preview computed', async () => {
    const { local, remote } = trees();
    const hasher = new ContentHasher();
    await compareFolders(contextFor(local, remote, 'content'), undefined, { hasher });
    const readsAfterPreview = remote.reads.length;

    await sync(
      {
        srcFsPath: '/local',
        srcFs: local,
        targetFsPath: '/remote',
        targetFs: remote,
        transferDirection: TransferDirection.LOCAL_TO_REMOTE,
        transferOption: { perserveTargetMode: false },
        hasher,
      },
      () => undefined
    );

    expect(remote.reads.length).toBe(readsAfterPreview);
  });
});
