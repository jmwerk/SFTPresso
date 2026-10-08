import SFTPFileSystem from '../../src/core/fs/sftpFileSystem';
import { SSHClient } from '../../src/core/remote-client';
import { openShell } from '../../src/core/remote-client/shell';
import RemoteTerminal from '../../src/ui/remoteTerminal';
import { SSH_BASE_DIR, connectSftp, uniqueDir } from './sshHelpers';

/**
 * `SFTP: Open SSH in Terminal` against a real OpenSSH server: a pty session on
 * the pooled connection that starts in remotePath, follows terminal resizes and
 * closes with the shell's own exit code.
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

function startTerminal(cwd?: string) {
  let output = '';
  let resolveClosed!: (code: number | void) => void;
  const closed = new Promise<number | void>(resolve => (resolveClosed = resolve));
  const terminal = new RemoteTerminal({
    host: 'test',
    connect: dims => openShell(rawClient(), { cols: dims.columns, rows: dims.rows, cwd }),
  });
  terminal.onDidWrite(text => {
    output += text;
    // busybox's line editor asks for the cursor position and blocks on the
    // answer, which VS Code's own terminal would send
    if (text.includes('\x1b[6n')) {
      terminal.handleInput('\x1b[1;1R');
    }
  });
  terminal.onDidClose!(code => resolveClosed(code));
  terminal.open({ columns: 80, rows: 24 });

  // resolves once the output so far matches, polling because a pty echoes and
  // prompts in chunks of its own choosing
  const waitFor = async (pattern: RegExp, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (!pattern.test(output)) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${pattern}; got:\n${output}`);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };

  return { terminal, closed, waitFor };
}

describe('RemoteTerminal against a real OpenSSH server', () => {
  test('starts in cwd and closes with the exit code', async () => {
    const dir = uniqueDir();
    await sftp.mkdir(dir);
    const { terminal, closed, waitFor } = startTerminal(dir);

    // marker split by quotes so the echoed command line itself can't match
    terminal.handleInput(`echo "cwd=$(pwd)=d""one"\r`);
    await waitFor(new RegExp(`cwd=${dir}=done`));

    terminal.handleInput('exit 7\r');
    await expect(closed).resolves.toBe(7);
  });

  test('falls back to the home directory when cwd is missing', async () => {
    const { terminal, closed, waitFor } = startTerminal(`${uniqueDir()}/gone`);

    terminal.handleInput(`echo "cwd=$(pwd)=d""one"\r`);
    await waitFor(new RegExp(`cwd=${SSH_BASE_DIR}=done`));

    terminal.handleInput('exit\r');
    await expect(closed).resolves.toBe(0);
  });

  test('resizes the remote pty', async () => {
    const { terminal, closed, waitFor } = startTerminal();
    terminal.handleInput('true\r');
    await waitFor(/\$|#/);

    terminal.setDimensions({ columns: 132, rows: 41 });
    terminal.handleInput(`echo "size=$(stty size)=d""one"\r`);
    await waitFor(/size=41 132=done/);

    terminal.handleInput('exit\r');
    await closed;
  });
});
