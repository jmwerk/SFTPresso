import SFTPFileSystem from '../../src/core/fs/sftpFileSystem';
import { SSHClient } from '../../src/core/remote-client';
import { execCommand } from '../../src/core/remote-client/exec';
import { buildRemoteCommand } from '../../src/modules/afterUpload';
import { connectSftp } from './sshHelpers';

/**
 * `SFTP: Run Remote Command` against a real OpenSSH server: the unit tests
 * cover the promise/stream plumbing against a fake channel, what only a real
 * server can show is that a command actually runs, that its real exit code
 * comes back, and that a command the server never finishes is still killed
 * and reported rather than hanging the caller.
 */

let sftp: SFTPFileSystem;

beforeAll(async () => {
  sftp = await connectSftp();
});

afterAll(() => {
  if (sftp) {
    sftp.end();
  }
});

function rawClient() {
  const client = sftp.getClient();
  expect(client).toBeInstanceOf(SSHClient);
  return (client as SSHClient).getRawClient();
}

describe('execCommand against a real OpenSSH server', () => {
  it('runs a command and reports its stdout and exit code', async () => {
    const result = await execCommand(rawClient(), 'echo hi');

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
  });

  it('surfaces a non-zero exit code', async () => {
    const result = await execCommand(rawClient(), 'exit 3');

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(3);
  });

  it('captures stderr separately from stdout', async () => {
    const result = await execCommand(rawClient(), 'echo out; echo err 1>&2');

    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
  });

  it('kills and reports a command that exceeds the timeout', async () => {
    const startedAt = Date.now();
    const result = await execCommand(rawClient(), 'sleep 30', { timeout: 500 });
    const elapsed = Date.now() - startedAt;

    expect(result.timedOut).toBe(true);
    // settles on the timeout, not on the remote 'sleep 30' actually finishing
    expect(elapsed).toBeLessThan(5000);
  });

  it('leaves the connection usable for a later command after a timeout', async () => {
    await execCommand(rawClient(), 'sleep 30', { timeout: 300 });

    const result = await execCommand(rawClient(), 'echo still-alive');
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('still-alive');
  });
});

describe('afterUpload command wrapper against a real OpenSSH server', () => {
  it('runs in remotePath, including one with a quote in its name', async () => {
    const dir = "/tmp/after upload's dir";
    await execCommand(rawClient(), `mkdir -p "${dir}"`);

    const result = await execCommand(rawClient(), buildRemoteCommand(dir, 'pwd'), {
      closeStdin: true,
    });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(dir);
  });

  it('does not run the command when remotePath is missing', async () => {
    const result = await execCommand(rawClient(), buildRemoteCommand('/no/such/dir', 'echo ran'), {
      closeStdin: true,
    });

    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain('ran');
  });
});
