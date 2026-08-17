jest.mock('fs');

// Records the option each connection is constructed with, so the plumbing from
// ~/.ssh/config all the way to the client can be asserted rather than assumed.
jest.mock('../fs', () => {
  class FakeRemoteFs {
    static instances: FakeRemoteFs[] = [];

    constructor(public pathResolver: any, public option: any) {
      FakeRemoteFs.instances.push(this);
    }

    connect() {
      return Promise.resolve();
    }
    onDisconnected() {
      /* never fired here */
    }
    end() {
      /* nothing to close */
    }
    probe() {
      return Promise.resolve();
    }
  }

  return {
    __esModule: true,
    FileSystem: class {},
    LocalFileSystem: class {
      constructor(public pathResolver: any) {}
    },
    RemoteFileSystem: FakeRemoteFs,
    SFTPFileSystem: FakeRemoteFs,
    FTPFileSystem: FakeRemoteFs,
  };
});

import { vol } from 'memfs';
import * as os from 'os';
import * as path from 'path';
import app from '../../app';
import { SFTPFileSystem } from '../fs';
import FileService, {
  DEFAULT_CONNECT_TIMEOUT,
  FileServiceConfig,
} from '../fileService';

const FakeRemoteFs = SFTPFileSystem as any;

const SSH_CONFIG_PATH = path.join(os.homedir(), '.ssh', 'config');

// each test needs its own entry in the module-level connection pool
let hostCounter = 0;

function createService(
  sshConfig: string,
  extra: Partial<FileServiceConfig> = {}
): FileService {
  vol.fromJSON({ [SSH_CONFIG_PATH]: sshConfig });
  hostCounter += 1;

  return new FileService('/ws', '/ws', {
    name: 'test',
    context: '/ws',
    protocol: 'sftp',
    host: 'myserver',
    username: `bob-${hostCounter}`,
    remotePath: '/var/www',
    watcher: { files: false, autoUpload: false, autoDelete: false },
    ...extra,
  } as any as FileServiceConfig);
}

beforeEach(() => {
  vol.reset();
  app.fsCache.clear();
  app.state.profile = null;
  FakeRemoteFs.instances.length = 0;
});

describe('~/.ssh/config durations', () => {
  test('ServerAliveInterval is seconds, keepaliveInterval is milliseconds', () => {
    const config = createService(
      ['Host myserver', '  HostName real.example.com', '  ServerAliveInterval 30'].join('\n')
    ).getConfig();

    // 30ms would be ~33 keepalive packets a second for the life of the
    // connection; and under the old `keepalive` key ssh2 never saw it at all
    expect((config as any).keepaliveInterval).toBe(30000);
    expect((config as any).keepalive).toBeUndefined();
  });

  test('ConnectTimeout is seconds too', () => {
    const config = createService(
      ['Host myserver', '  ConnectTimeout 45'].join('\n')
    ).getConfig();

    expect(config.connectTimeout).toBe(45000);
    expect((config as any).connTimeout).toBeUndefined();
  });

  test('an explicit sftp.json value still wins over the ssh config', () => {
    const config = createService(['Host myserver', '  ConnectTimeout 45'].join('\n'), {
      connectTimeout: 5000,
    } as Partial<FileServiceConfig>).getConfig();

    expect(config.connectTimeout).toBe(5000);
  });

  test('the built-in default applies when neither says', () => {
    const config = createService(['Host myserver', '  User alice'].join('\n')).getConfig();

    expect(config.connectTimeout).toBe(DEFAULT_CONNECT_TIMEOUT);
  });

  test.each([['nonsense'], ['3s'], [''], ['  '], ['-5']])(
    'a value of "%s" is ignored rather than producing NaN',
    value => {
      const config = createService(
        ['Host myserver', `  ServerAliveInterval ${value}`].join('\n')
      ).getConfig();

      expect((config as any).keepaliveInterval).toBeUndefined();
    }
  );

  test('a fractional interval is rounded to whole milliseconds', () => {
    const config = createService(
      ['Host myserver', '  ServerAliveInterval 0.5'].join('\n')
    ).getConfig();

    expect((config as any).keepaliveInterval).toBe(500);
  });

  // Renaming the key is only half of it: `keepalive` and `connTimeout` were
  // dropped precisely because nothing downstream read them. These assert the
  // resolved value survives getHostInfo() and the pool and reaches the client
  // option the SSH library is handed.
  test('the resolved values reach the client connect option', async () => {
    const service = createService(
      [
        'Host myserver',
        '  ServerAliveInterval 30',
        '  ConnectTimeout 45',
      ].join('\n')
    );

    await service.getRemoteFileSystem(service.getConfig());

    expect(FakeRemoteFs.instances).toHaveLength(1);
    const { clientOption } = FakeRemoteFs.instances[0].option;
    expect(clientOption.keepaliveInterval).toBe(30000);
    expect(clientOption.connectTimeout).toBe(45000);
    // the dead names must not come back
    expect(clientOption.keepalive).toBeUndefined();
    expect(clientOption.connTimeout).toBeUndefined();
  });

  test('a rejected value leaves the client on its own default', async () => {
    const service = createService(
      ['Host myserver', '  ServerAliveInterval nonsense'].join('\n')
    );

    await service.getRemoteFileSystem(service.getConfig());

    const { clientOption } = FakeRemoteFs.instances[0].option;
    expect('keepaliveInterval' in clientOption).toBe(false);
    expect(clientOption.connectTimeout).toBe(DEFAULT_CONNECT_TIMEOUT);
  });

  test('the non-duration directives are unaffected', () => {
    const config = createService(
      [
        'Host myserver',
        '  HostName real.example.com',
        '  Port 2222',
        '  User alice',
      ].join('\n')
    ).getConfig();

    expect(config.host).toBe('real.example.com');
    expect(config.port).toBe(2222);
    // HostName always applies; User only fills in a username sftp.json left out
    expect(config.username).not.toBe('alice');
    expect(config.username).toMatch(/^bob-/);
  });
});

describe('~/.ssh/config host resolution (compute)', () => {
  // One fixture exercising every kind of Host/Match resolution `compute()`
  // does that the old `find({ Host })` couldn't: a literal Host, a wildcard
  // Host, a Match block, and repeated IdentityFile lines in one section.
  const FIXTURE = [
    'Host literal.example.com',
    '  HostName literal-resolved.example.com',
    '  Port 2200',
    '  User literaluser',
    '  IdentityFile ~/.ssh/id_literal',
    '',
    'Host *.wildcard.example.com',
    '  HostName wildcard-resolved.example.com',
    '  User wildcarduser',
    '',
    'Match host match.example.com',
    '  HostName match-resolved.example.com',
    '  User matchuser',
    '',
    'Host multikey.example.com',
    '  IdentityFile ~/.ssh/id_first',
    '  IdentityFile ~/.ssh/id_second',
    '  HostName multikey-resolved.example.com',
    '',
    'Host alive.example.com',
    '  HostName alive-resolved.example.com',
    '  ServerAliveInterval 30',
  ].join('\n');

  test.each([
    [
      'literal host',
      'literal.example.com',
      {
        host: 'literal-resolved.example.com',
        port: 2200,
        privateKeyPath: path.join(os.homedir(), '.ssh', 'id_literal'),
      },
    ],
    [
      'wildcard host (Host *.wildcard.example.com)',
      'sub.wildcard.example.com',
      { host: 'wildcard-resolved.example.com' },
    ],
    [
      'Match block (Match host match.example.com)',
      'match.example.com',
      { host: 'match-resolved.example.com' },
    ],
    [
      'multiple IdentityFile lines: the first one wins',
      'multikey.example.com',
      {
        host: 'multikey-resolved.example.com',
        privateKeyPath: path.join(os.homedir(), '.ssh', 'id_first'),
      },
    ],
    [
      'ServerAliveInterval unit conversion still applies via compute()',
      'alive.example.com',
      { host: 'alive-resolved.example.com', keepaliveInterval: 30000 },
    ],
    [
      'a host with no matching section is left untouched',
      'unmatched.example.com',
      { host: 'unmatched.example.com' },
    ],
  ])('%s', (_label, host, expected: Record<string, any>) => {
    const config = createService(FIXTURE, { host }).getConfig();

    expect(config.host).toBe(expected.host);

    if ('port' in expected) {
      expect(config.port).toBe(expected.port);
    }
    if ('privateKeyPath' in expected) {
      expect(config.privateKeyPath).toBe(expected.privateKeyPath);
    }
    if ('keepaliveInterval' in expected) {
      expect((config as any).keepaliveInterval).toBe(expected.keepaliveInterval);
    }
  });
});
