import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { detectAgentCandidates } from '../modules/sshAgentDetect';

function listenOnSocket(socketPath: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

// Unix domain sockets only -- there is nothing to listen on as a named pipe
// from within a portable Jest test on Windows.
const describeUnix = process.platform === 'win32' ? describe.skip : describe;

describeUnix('detectAgentCandidates', () => {
  let tmpDir: string;
  let originalSshAuthSock: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sftpresso-agent-test-'));
    originalSshAuthSock = process.env.SSH_AUTH_SOCK;
  });

  afterEach(() => {
    if (originalSshAuthSock === undefined) {
      delete process.env.SSH_AUTH_SOCK;
    } else {
      process.env.SSH_AUTH_SOCK = originalSshAuthSock;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds a live socket referenced by $SSH_AUTH_SOCK', async () => {
    const socketPath = path.join(tmpDir, 'agent.sock');
    const server = await listenOnSocket(socketPath);
    try {
      process.env.SSH_AUTH_SOCK = socketPath;
      const candidates = await detectAgentCandidates();
      expect(candidates).toContainEqual(
        expect.objectContaining({ label: '$SSH_AUTH_SOCK', value: socketPath })
      );
    } finally {
      await closeServer(server);
    }
  });

  it('does not offer $SSH_AUTH_SOCK when it points at a dead or missing path', async () => {
    process.env.SSH_AUTH_SOCK = path.join(tmpDir, 'nothing-listening-here.sock');
    const candidates = await detectAgentCandidates();
    expect(candidates.some(c => c.label === '$SSH_AUTH_SOCK')).toBe(false);
  });

  it('does not offer a regular file even if $SSH_AUTH_SOCK points at one', async () => {
    const filePath = path.join(tmpDir, 'not-a-socket.txt');
    fs.writeFileSync(filePath, 'hello');
    process.env.SSH_AUTH_SOCK = filePath;
    const candidates = await detectAgentCandidates();
    expect(candidates.some(c => c.label === '$SSH_AUTH_SOCK')).toBe(false);
  });
});

// Forced to 'darwin' regardless of the host running this suite, with the
// launchd root pointed at a real temp directory instead of the real,
// version-dependent system paths -- this is the scan that once looked only
// in /private/tmp and missed the actual (/private/var/run) location.
describe('detectAgentCandidates on macOS', () => {
  const originalPlatform = process.platform;
  let tmpDir: string;

  beforeEach(() => {
    // /tmp directly, not os.tmpdir() -- on macOS the latter resolves to a
    // long /var/folders/... path that, once com.apple.launchd.*/Listeners is
    // appended, exceeds AF_UNIX's ~104-byte sun_path limit.
    tmpDir = fs.mkdtempSync(path.join('/tmp', 'sftpresso-agent-darwin-test-'));
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    delete process.env.SSH_AUTH_SOCK;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds a live per-boot launchd agent socket under the configured root', async () => {
    const launchdDir = path.join(tmpDir, 'com.apple.launchd.testboot');
    fs.mkdirSync(launchdDir);
    const listenerPath = path.join(launchdDir, 'Listeners');
    const server = await listenOnSocket(listenerPath);
    try {
      const candidates = await detectAgentCandidates([tmpDir]);
      expect(candidates).toContainEqual(
        expect.objectContaining({ label: 'macOS SSH Agent', value: listenerPath })
      );
    } finally {
      await closeServer(server);
    }
  });

  it('ignores a launchd-named directory with no live Listeners socket', async () => {
    fs.mkdirSync(path.join(tmpDir, 'com.apple.launchd.stale'));
    const candidates = await detectAgentCandidates([tmpDir]);
    expect(candidates.some(c => c.label === 'macOS SSH Agent')).toBe(false);
  });
});
