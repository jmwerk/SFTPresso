import { createHash } from 'crypto';
import { Readable } from 'stream';
import upath from '../../src/core/upath';
import SFTPFileSystem from '../../src/core/fs/sftpFileSystem';
import { ContentHasher, HashSide } from '../../src/core/contentHash';
import { connectSftp, uniqueDir } from './sshHelpers';

/**
 * Content comparison against a real OpenSSH server. The unit tests cover the
 * batching and fallbacks against fakes; only a real server shows that the
 * quoting survives a real shell, that busybox/GNU sha256sum output parses, and
 * that an unreadable file still falls back to a per-file answer.
 */

let sftp: SFTPFileSystem;
let dir: string;

const sha = (data: string) => createHash('sha256').update(data).digest('hex');

// Names a careless `sh -c` would mangle: spaces, quotes, globs, expansions,
// a leading dash (read as an option without `--`), and non-ASCII.
const NAMES = [
  'plain.txt',
  'with space.txt',
  "it's.txt",
  'dollar $(echo pwned).txt',
  'star*.txt',
  '-n',
  'ünïcødé.txt',
];

beforeAll(async () => {
  sftp = await connectSftp();
  dir = uniqueDir();
  await sftp.ensureDir(dir);
  for (const name of NAMES) {
    await sftp.put(Readable.from(Buffer.from(`content of ${name}`)), upath.join(dir, name));
  }
});

afterAll(async () => {
  if (sftp) {
    await sftp.rmdir(dir, true).catch(() => undefined);
    sftp.end();
  }
});

// The remote side is compared against itself through an in-memory "local"
// copy, so the expected answer is known exactly.
function localSide(content: string, fspath: string): HashSide {
  const fs: any = {
    get: async () => Readable.from([Buffer.from(content)]),
  };
  return { fs, entry: { fspath, size: Buffer.byteLength(content), mtime: 0 } };
}

describe('server-side hashing on a real OpenSSH server', () => {
  it('hashes awkward filenames on the server and agrees with a local hash', async () => {
    const hasher = new ContentHasher();
    const pairs: Array<[HashSide, HashSide]> = await Promise.all(
      NAMES.map(async name => {
        const remotePath = upath.join(dir, name);
        const stat = await sftp.lstat(remotePath);
        const content = `content of ${name}`;
        return [
          localSide(content, `/local/${name}`),
          { fs: sftp, entry: { fspath: remotePath, size: stat.size, mtime: stat.mtime } },
        ] as [HashSide, HashSide];
      })
    );

    const outcomes = await hasher.contentDiffers(pairs);

    expect(outcomes).toEqual(NAMES.map(() => false));
    expect(hasher.stats.serverSide).toBe(NAMES.length);
    // nothing was executed by the names themselves
    expect((await sftp.list(dir)).map(e => e.name)).not.toContain('pwned');
  });

  it('finds a real difference', async () => {
    const remotePath = upath.join(dir, 'plain.txt');
    const stat = await sftp.lstat(remotePath);
    const altered = 'content of plain.txX';
    expect(Buffer.byteLength(altered)).toBe(stat.size);

    const [outcome] = await new ContentHasher().contentDiffers([
      [
        localSide(altered, '/local/plain.txt'),
        { fs: sftp, entry: { fspath: remotePath, size: stat.size, mtime: stat.mtime } },
      ],
    ]);

    expect(outcome).toBe(true);
    expect(sha(altered)).not.toBe(sha('content of plain.txt'));
  });

  it('reports a file the user cannot read as an error for that file only', async () => {
    const locked = upath.join(dir, 'locked.txt');
    await sftp.put(Readable.from(Buffer.from('secret')), locked);
    await sftp.chmod(locked, 0o000);
    try {
      const plain = upath.join(dir, 'plain.txt');
      const plainStat = await sftp.lstat(plain);
      const [lockedOutcome, plainOutcome] = await new ContentHasher().contentDiffers([
        [localSide('secret', '/local/locked.txt'), { fs: sftp, entry: { fspath: locked, size: 6, mtime: 0 } }],
        [
          localSide('content of plain.txt', '/local/plain.txt'),
          { fs: sftp, entry: { fspath: plain, size: plainStat.size, mtime: plainStat.mtime } },
        ],
      ]);

      expect(lockedOutcome).toBeInstanceOf(Error);
      expect(plainOutcome).toBe(false);
    } finally {
      await sftp.chmod(locked, 0o644);
    }
  });
});
