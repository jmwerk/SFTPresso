import { Readable } from 'stream';
import upath from '../../src/core/upath';
import SFTPFileSystem from '../../src/core/fs/sftpFileSystem';
import { SSHClient } from '../../src/core/remote-client';
import { DEFAULT_EXCLUDE_DIRS, searchRemote, smartCase } from '../../src/modules/remoteSearch';
import { connectSftp, uniqueDir } from './sshHelpers';

/**
 * Remote content search against a real OpenSSH server. The container is
 * Alpine, so this runs BusyBox grep, which lacks --null and --exclude-dir: it
 * checks the find-based fallback kicks in, that quoting survives a real shell,
 * and that excluded folders stay out of the results. BusyBox also ignores -I,
 * so binaries are searched there (GNU/BSD grep skip them).
 */

let sftp: SFTPFileSystem;
let dir: string;

const put = (name: string, content: string | Buffer) =>
  sftp.put(Readable.from([Buffer.from(content)]), upath.join(dir, name));

beforeAll(async () => {
  sftp = await connectSftp();
  dir = upath.join(uniqueDir(), "it's here");
  await sftp.ensureDir(upath.join(dir, 'wp'));
  await sftp.ensureDir(upath.join(dir, 'node_modules'));
  await put('wp/config.php', "<?php\ndefine('DB_NAME', 'site');\n// db_name lowercase\n");
  await put('a $(echo pwned).txt', 'needle (literal) [x]*\n');
  await put('node_modules/dep.js', "define('DB_NAME')\n");
  await put('bin.dat', Buffer.from([0, 1, 2, 0x44, 0x42, 0x5f, 0x4e, 0x41, 0x4d, 0x45, 0]));
});

afterAll(async () => {
  if (sftp) {
    await sftp.rmdir(upath.dirname(dir), true).catch(() => undefined);
    sftp.end();
  }
});

function rawClient() {
  const client = sftp.getClient();
  expect(client).toBeInstanceOf(SSHClient);
  return (client as SSHClient).getRawClient();
}

describe('searchRemote against a real OpenSSH server', () => {
  const text = (matches: Array<{ fsPath: string }>) =>
    matches.filter(m => !m.fsPath.endsWith('bin.dat'));

  it('finds the text with its line, case-sensitively for an uppercase query, skipping excluded folders', async () => {
    const result = await searchRemote(
      rawClient(),
      dir,
      smartCase('DB_NAME'),
      DEFAULT_EXCLUDE_DIRS,
      30000
    );

    expect(text(result.matches)).toEqual([
      { fsPath: upath.join(dir, 'wp/config.php'), line: 2, preview: "define('DB_NAME', 'site');" },
    ]);
    // the binary's NULs never reach the preview
    expect(result.matches.every(m => !/[\x00-\x08]/.test((m as any).preview))).toBe(true);
  });

  it('a lowercase query matches any case', async () => {
    const result = await searchRemote(
      rawClient(),
      dir,
      smartCase('db_name'),
      DEFAULT_EXCLUDE_DIRS,
      30000
    );

    expect(text(result.matches).map(m => (m as any).line)).toEqual([2, 3]);
  });

  it('treats regex characters literally and survives shell metacharacters in names', async () => {
    const result = await searchRemote(rawClient(), dir, smartCase('(literal) [x]*'), [], 30000);

    expect(result.matches).toEqual([
      { fsPath: upath.join(dir, 'a $(echo pwned).txt'), line: 1, preview: 'needle (literal) [x]*' },
    ]);
  });

  it('reports a missing directory as an error', async () => {
    await expect(
      searchRemote(rawClient(), upath.join(dir, 'nope'), smartCase('x'), [], 30000)
    ).rejects.toThrow(/nope/);
  });
});
