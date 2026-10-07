import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import MemFs from './helpers/memFs';
import LocalFileSystem from '../fs/localFileSystem';
import {
  ContentHasher,
  HashCancelledError,
  HashSide,
  ServerHasher,
  clearLocalHashCache,
  parseDigests,
  shellQuote,
  sshServerHasher,
} from '../contentHash';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function side(memFs: MemFs, fspath: string, size: number, mtime = 1000): HashSide {
  return { fs: memFs, entry: { fspath, size, mtime } };
}

describe('parseDigests', () => {
  const a = sha('a');
  const b = sha('b');

  test('reads one digest per line, in order', () => {
    expect(parseDigests(`${a}  /x/a\n${b}  /x/b\n`, 2)).toEqual([a, b]);
  });

  test("ignores GNU sha256sum's escaped-name prefix and binary-mode marker", () => {
    expect(parseDigests(`\\${a}  /x/a\\\\b\n${b} */x/b\n`, 2)).toEqual([a, b]);
  });

  test('rejects output that does not account for every file', () => {
    expect(parseDigests(`${a}  /x/a\n`, 2)).toBeNull();
    expect(parseDigests(`sha256sum: /x/b: Permission denied\n${a}  /x/a\n`, 2)).toBeNull();
  });
});

test('shellQuote survives single quotes and shell metacharacters', () => {
  expect(shellQuote(`/srv/it's $(rm -rf ~)`)).toBe(`'/srv/it'\\''s $(rm -rf ~)'`);
});

describe('ContentHasher', () => {
  test('different sizes differ without reading either file', async () => {
    const local = new MemFs('/l').file('/l/a', 'short');
    const remote = new MemFs('/r').file('/r/a', 'longer');
    const [outcome] = await new ContentHasher().contentDiffers([
      [side(local, '/l/a', 5), side(remote, '/r/a', 6)],
    ]);
    expect(outcome).toBe(true);
    expect(local.reads).toEqual([]);
    expect(remote.reads).toEqual([]);
  });

  test('same-size files are compared by content, whatever their mtimes', async () => {
    const local = new MemFs('/l').file('/l/same', 'hello', 1000).file('/l/diff', 'hello', 1000);
    const remote = new MemFs('/r').file('/r/same', 'hello', 9000).file('/r/diff', 'jello', 1000);
    const outcomes = await new ContentHasher().contentDiffers([
      [side(local, '/l/same', 5, 1000), side(remote, '/r/same', 5, 9000)],
      [side(local, '/l/diff', 5), side(remote, '/r/diff', 5)],
    ]);
    expect(outcomes).toEqual([false, true]);
  });

  test('an unreadable file fails only its own pair', async () => {
    const local = new MemFs('/l').file('/l/ok', 'x').file('/l/bad', 'y');
    const remote = new MemFs('/r').file('/r/ok', 'x').file('/r/bad', 'y');
    remote.unreadable.add('/r/bad');
    const [ok, bad] = await new ContentHasher().contentDiffers([
      [side(local, '/l/ok', 1), side(remote, '/r/ok', 1)],
      [side(local, '/l/bad', 1), side(remote, '/r/bad', 1)],
    ]);
    expect(ok).toBe(false);
    expect(bad).toBeInstanceOf(Error);
    expect((bad as Error).message).toMatch(/permission denied/);
  });

  test('a hash is reused within one hasher, so a sync does not re-read its preview', async () => {
    const local = new MemFs('/l').file('/l/a', 'x');
    const remote = new MemFs('/r').file('/r/a', 'x');
    const hasher = new ContentHasher();
    const pair: [HashSide, HashSide] = [side(local, '/l/a', 1), side(remote, '/r/a', 1)];
    await hasher.contentDiffers([pair]);
    await hasher.contentDiffers([pair]);
    expect(remote.reads).toEqual(['/r/a']);
    expect(hasher.stats).toEqual({ files: 2, bytes: 2, serverSide: 0 });
  });

  test('a changed size or mtime is a cache miss', async () => {
    const remote = new MemFs('/r').file('/r/a', 'x');
    const local = new MemFs('/l').file('/l/a', 'x');
    const hasher = new ContentHasher();
    await hasher.contentDiffers([[side(local, '/l/a', 1), side(remote, '/r/a', 1, 1000)]]);
    await hasher.contentDiffers([[side(local, '/l/a', 1), side(remote, '/r/a', 1, 2000)]]);
    expect(remote.reads).toEqual(['/r/a', '/r/a']);
  });

  test('files are hashed by the server in batches when it can', async () => {
    const local = new MemFs('/l');
    const remote = new MemFs('/r');
    const pairs: Array<[HashSide, HashSide]> = [];
    for (let i = 0; i < 300; i += 1) {
      local.file(`/l/f${i}`, `content ${i}`);
      pairs.push([side(local, `/l/f${i}`, 9), side(remote, `/r/f${i}`, 9)]);
    }
    const batches: string[][] = [];
    const server: ServerHasher = async paths => {
      batches.push(paths);
      // f7 differs; everything else matches the local copy
      return paths.map(p => sha(p === '/r/f7' ? 'changed!!' : `content ${p.slice(4)}`));
    };
    const hasher = new ContentHasher({
      resolveServerHasher: fsys => (fsys === remote ? server : undefined),
    });

    const outcomes = await hasher.contentDiffers(pairs);

    expect(remote.reads).toEqual([]);
    expect(batches.map(b => b.length)).toEqual([128, 128, 44]);
    expect(outcomes.filter(o => o === true)).toHaveLength(1);
    expect(outcomes[7]).toBe(true);
    expect(hasher.stats.serverSide).toBe(300);
  });

  test('a batch the server cannot hash is streamed instead', async () => {
    const local = new MemFs('/l').file('/l/a', 'x');
    const remote = new MemFs('/r').file('/r/a', 'x');
    const hasher = new ContentHasher({ resolveServerHasher: () => async () => null });
    const [outcome] = await hasher.contentDiffers([[side(local, '/l/a', 1), side(remote, '/r/a', 1)]]);
    expect(outcome).toBe(false);
    expect(remote.reads).toEqual(['/r/a']);
  });

  test('a path containing a newline is never sent to the server', async () => {
    const name = '/r/two\nlines';
    const local = new MemFs('/l').file('/l/x', 'x');
    const remote = new MemFs('/r').file(name, 'x');
    const server = jest.fn<ReturnType<ServerHasher>, Parameters<ServerHasher>>(async () => null);
    await new ContentHasher({ resolveServerHasher: () => server }).contentDiffers([
      [side(local, '/l/x', 1), side(remote, name, 1)],
    ]);
    expect(server.mock.calls.flatMap(([paths]) => paths)).not.toContain(name);
    expect(remote.reads).toEqual([name]);
  });

  test('cancel() fails hashes that have not started', async () => {
    const local = new MemFs('/l').file('/l/a', 'x');
    const remote = new MemFs('/r').file('/r/a', 'x');
    const hasher = new ContentHasher();
    hasher.cancel();
    const [outcome] = await hasher.contentDiffers([[side(local, '/l/a', 1), side(remote, '/r/a', 1)]]);
    expect(outcome).toBeInstanceOf(HashCancelledError);
    expect(remote.reads).toEqual([]);
  });

  test('local hashes are cached across hashers, but not for a file modified moments ago', async () => {
    clearLocalHashCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sftpresso-hash-'));
    try {
      const old = path.join(dir, 'old.txt');
      const fresh = path.join(dir, 'fresh.txt');
      fs.writeFileSync(old, 'x');
      fs.writeFileSync(fresh, 'x');
      const localFs = new LocalFileSystem(path);
      const get = jest.spyOn(localFs, 'get');
      const remote = new MemFs('/r').file('/r/x', 'x');
      const now = Date.now();
      const pairs = (): Array<[HashSide, HashSide]> => [
        [{ fs: localFs, entry: { fspath: old, size: 1, mtime: now - 60000 } }, side(remote, '/r/x', 1)],
        [{ fs: localFs, entry: { fspath: fresh, size: 1, mtime: now } }, side(remote, '/r/x', 1)],
      ];

      expect(await new ContentHasher().contentDiffers(pairs())).toEqual([false, false]);
      expect(await new ContentHasher().contentDiffers(pairs())).toEqual([false, false]);

      const readsOf = (p: string) => get.mock.calls.filter(([fsPath]) => fsPath === p).length;
      expect(readsOf(old)).toBe(1);
      expect(readsOf(fresh)).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      clearLocalHashCache();
    }
  });
});

/**
 * Stands in for an ssh2 Client: `exec` answers each command from `respond`,
 * and every command and stdin EOF is recorded.
 */
function fakeSshClient(
  respond: (command: string) => { code: number; stdout?: string; stderr?: string } | Error
) {
  const commands: string[] = [];
  let stdinClosed = 0;
  const client: any = {
    exec(command: string, cb: (err: Error | undefined, stream?: any) => void) {
      commands.push(command);
      const reply = respond(command);
      if (reply instanceof Error) {
        cb(reply);
        return;
      }
      const stream: any = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.end = () => {
        stdinClosed += 1;
      };
      stream.close = () => undefined;
      stream.signal = () => undefined;
      cb(undefined, stream);
      setImmediate(() => {
        if (reply.stdout) stream.emit('data', Buffer.from(reply.stdout));
        if (reply.stderr) stream.stderr.emit('data', Buffer.from(reply.stderr));
        stream.emit('close', reply.code, null);
      });
    },
  };
  return { client, commands, stdinClosed: () => stdinClosed };
}

describe('sshServerHasher', () => {
  const digest = sha('x');

  test('falls back from sha256sum to shasum, then sticks with what worked', async () => {
    const ssh = fakeSshClient(command =>
      command.startsWith('sha256sum')
        ? { code: 127, stderr: 'sh: sha256sum: not found' }
        : { code: 0, stdout: `${digest}  /srv/a\n` }
    );
    const hash = sshServerHasher(ssh.client);

    expect(await hash(['/srv/a'], 1)).toEqual([digest]);
    expect(await hash(['/srv/a'], 1)).toEqual([digest]);
    expect(ssh.commands).toEqual([
      "sha256sum -- '/srv/a'",
      "shasum -a 256 -- '/srv/a'",
      "shasum -a 256 -- '/srv/a'",
    ]);
    // stdin is closed every time, so a ForceCommand internal-sftp account
    // exits instead of waiting for input
    expect(ssh.stdinClosed()).toBe(3);
  });

  test('a server that refuses exec is not asked again', async () => {
    const ssh = fakeSshClient(() => new Error('exec request failed on channel 1'));
    const hash = sshServerHasher(ssh.client);
    expect(await hash(['/srv/a'], 1)).toBeNull();
    expect(await hash(['/srv/a'], 1)).toBeNull();
    expect(ssh.commands).toHaveLength(1);
  });

  test('one unreadable file streams the batch but keeps the tool', async () => {
    let call = 0;
    const ssh = fakeSshClient(() => {
      call += 1;
      return call === 1
        ? { code: 1, stdout: `${digest}  /srv/a\n`, stderr: 'sha256sum: /srv/b: Permission denied' }
        : { code: 0, stdout: `${digest}  /srv/a\n` };
    });
    const hash = sshServerHasher(ssh.client);
    expect(await hash(['/srv/a', '/srv/b'], 2)).toBeNull();
    expect(await hash(['/srv/a'], 1)).toEqual([digest]);
    expect(ssh.commands.every(c => c.startsWith('sha256sum'))).toBe(true);
  });

  test('no hashing tool at all disables server hashing for the connection', async () => {
    const ssh = fakeSshClient(() => ({ code: 127, stderr: 'not found' }));
    const hash = sshServerHasher(ssh.client);
    expect(await hash(['/srv/a'], 1)).toBeNull();
    expect(await hash(['/srv/a'], 1)).toBeNull();
    expect(ssh.commands).toHaveLength(2);
  });
});
