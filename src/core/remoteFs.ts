import upath from './upath';
import { promptForPassword } from '../host';
import hostKeyPrompt from '../hostKeyPrompt';
import logger from '../logger';
import app from '../app';
import { ConnectionState } from '../ui/connectionStatusBar';
import { ConnectOption } from './remote-client/remoteClient';
import {
  FileSystem,
  RemoteFileSystem,
  SFTPFileSystem,
  FTPFileSystem,
} from './fs';
import localFs from './localFs';
import { connectionIdentity } from './connectionIdentity';

// Fallback when the config carries no connectTimeout to size the probe from.
const DEFAULT_PROBE_TIMEOUT = 10 * 1000;

// Policy that governs how a pooled connection is reused. Deliberately kept out
// of the connection options, and so out of connectionIdentity(): these knobs
// describe how we treat a connection, not which remote it points at, and
// folding them into the identity would open a second connection to the same
// server whenever one of them changed.
export interface ConnectionPolicy {
  // ms of inactivity after which a pooled connection is probed before reuse.
  // 0 (the default) disables the check and reuses the connection blindly.
  idleTimeout?: number;

  // ms a single remote request may go unanswered before it is failed and the
  // connection dropped. 0 waits indefinitely. Baked into the file system when
  // it is constructed, so a change takes effect on the next reconnect.
  operationTimeout?: number;

  // How an unknown or changed SSH host key is treated (OpenSSH's
  // StrictHostKeyChecking). Policy, like the two above -- a user who tightens
  // it should not end up with a second connection to the same server.
  strictHostKeyChecking?: boolean | string;
}

class KeepAliveRemoteFs {
  private isValid: boolean = false;

  private hasConnected: boolean = false;

  private pendingPromise: Promise<RemoteFileSystem> | null;

  private fs: RemoteFileSystem;

  // when this connection was last handed out, for the idle check below
  private lastUsedAt: number = 0;

  constructor(private readonly id: string) {}

  // Hands out the pooled connection, opening or replacing it if needed.
  //
  // Everything is funnelled through one in-flight acquisition, because the
  // work below is not safe to run twice at once. Uploading three files runs
  // three commands concurrently, and each one calls this: without the gate
  // all three would find the same connection valid, all three would probe it,
  // all three would invalidate it, and all three would then open a connection
  // that overwrites the last one. Only the final instance stays in `fs`; the
  // rest are orphaned mid-handshake, and their sockets erroring out takes the
  // surviving connection down with them. Sharing one acquisition means one
  // probe, one reconnect, and one connection handed to all three callers.
  getFs(
    option: ConnectOption & {
      protocol: string;
      remoteTimeOffsetInHours: number;
    },
    policy: ConnectionPolicy = {}
  ): Promise<RemoteFileSystem> {
    if (this.pendingPromise) {
      return this.pendingPromise;
    }

    const acquisition = this._acquire(option, policy);
    this.pendingPromise = acquisition;
    // Identity-checked so a slow acquisition that has already been superseded
    // cannot clear its successor's entry on the way out.
    const release = () => {
      if (this.pendingPromise === acquisition) {
        this.pendingPromise = null;
      }
    };
    acquisition.then(release, release);

    return acquisition;
  }

  private async _acquire(
    option: ConnectOption & {
      protocol: string;
      remoteTimeOffsetInHours: number;
    },
    policy: ConnectionPolicy
  ): Promise<RemoteFileSystem> {
    if (this.isValid && (await this.isStale(policy, option))) {
      // drops the connection and leaves isValid false, so we reconnect below
      this.invalid('idle');
    }

    if (this.isValid) {
      this.lastUsedAt = Date.now();
      return this.fs;
    }

    const connectOption = Object.assign({}, option);
    let FsConstructor: typeof SFTPFileSystem | typeof FTPFileSystem;
    if (option.protocol === 'sftp') {
      // Added to the copy, after the pool identity was computed from `option`,
      // so changing the policy does not open a second connection.
      connectOption.strictHostKeyChecking = policy.strictHostKeyChecking;
      connectOption.debug = function debug(str) {
        const log = str.match(/^DEBUG(?:\[SFTP\])?: (.*?): (.*?)$/);

        if (log) {
          if (log[1] === 'Parser') return;
          logger.debug(`${log[1]}: ${log[2]}`);
        } else {
          logger.debug(str);
        }
      };
      FsConstructor = SFTPFileSystem;
    } else if (option.protocol === 'ftp') {
      connectOption.debug = function debug(str) {
        // basic-ftp logs "> CMD" / "< RESPONSE" lines and masks PASS itself
        logger.debug(str.trimEnd());
      };
      FsConstructor = FTPFileSystem;
    } else {
      throw new Error(`unsupported protocol ${option.protocol}`);
    }

    const fs = new FsConstructor(upath, {
      clientOption: connectOption,
      remoteTimeOffsetInHours: option.remoteTimeOffsetInHours,
      operationTimeout: policy.operationTimeout,
    });
    // Scoped to this instance rather than bound straight to invalid(). A
    // connection that has already been replaced still emits 'close' and
    // 'error' as its socket unwinds, and invalid() acts on whatever `fs`
    // currently points at -- so a dead connection's dying breath would tear
    // down the healthy one that replaced it.
    fs.onDisconnected((reason: string, err?: Error) => {
      if (this.fs !== fs) {
        logger.debug(`ignoring '${reason}' from a replaced connection`);
        return;
      }
      this.invalid(reason, err);
    });
    this.fs = fs;

    app.sftpBarItem.showMsg('connecting...', connectOption.connectTimeout);
    app.connectionBarItem.setState(
      this.id,
      this.hasConnected ? ConnectionState.Reconnecting : ConnectionState.Connecting
    );

    return fs
      .connect(connectOption, {
        askForPasswd: promptForPassword,
        hostKeyPrompt,
      })
      .then(
        () => {
          app.sftpBarItem.reset();
          this.isValid = true;
          this.hasConnected = true;
          this.lastUsedAt = Date.now();
          app.connectionBarItem.setState(this.id, ConnectionState.Connected);
          return fs;
        },
        err => {
          fs.end();
          this.invalid('error');
          throw err;
        }
      );
  }

  // Whether the pooled connection has been sitting long enough that it may have
  // been closed underneath us, verified by asking the server.
  //
  // Only the *reuse* path is guarded, deliberately. A background timer would
  // have to close the connection while nothing is watching, and nothing here
  // knows whether a transfer is still running on it -- getFs() is called once
  // per command, not per operation, so a long upload looks identical to an idle
  // connection from the outside. Probing on the way out instead means a live
  // connection simply answers and is handed straight back, and only one that
  // has actually gone away is dropped.
  private async isStale(
    policy: ConnectionPolicy,
    option: ConnectOption
  ): Promise<boolean> {
    const idleTimeout = policy.idleTimeout || 0;
    if (idleTimeout <= 0 || this.lastUsedAt === 0) {
      return false;
    }

    const idleFor = Date.now() - this.lastUsedAt;
    if (idleFor < idleTimeout) {
      return false;
    }

    const timeout =
      option.connectTimeout && option.connectTimeout > 0
        ? option.connectTimeout
        : DEFAULT_PROBE_TIMEOUT;

    // On the happy path this check is completely invisible -- a healthy server
    // answers in a millisecond and nothing about the operation changes -- which
    // makes "it is working" and "it is not wired up" look identical. Trace both
    // outcomes so the option can be confirmed active from the output channel.
    logger.debug(`probing connection after ${idleFor}ms idle (timeout ${timeout}ms)`);

    let timer: NodeJS.Timeout | undefined;
    try {
      const probe = this.fs.probe();
      // A half-open socket never answers, so the probe can stay pending for
      // good; keep its eventual rejection from surfacing as an unhandled one
      // once the race below has already been decided against it.
      probe.catch(() => undefined);

      await Promise.race([
        probe,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`idle connection did not answer in ${timeout}ms`)),
            timeout
          );
        }),
      ]);
      logger.debug('probe answered, reusing the connection');
      return false;
    } catch (err) {
      logger.info(
        `reconnecting: ${(err as Error).message} (idle for ${idleFor}ms)`
      );
      return true;
    } finally {
      clearTimeout(timer as NodeJS.Timeout);
    }
  }

  invalid(reason: string, err?: Error) {
    if (err) {
      logger.error(`connection ${reason}: ${err.message}`);
    }
    // Deliberately does not clear pendingPromise. This can fire from a socket
    // event while an acquisition is still running, and dropping the gate then
    // would let a second caller start a competing one -- the very race this
    // entry exists to prevent. getFs() clears it when the acquisition it
    // started actually settles.
    if (this.fs) {
      this.fs.end();
    }
    this.isValid = false;
    app.connectionBarItem.setState(
      this.id,
      reason === 'error' ? ConnectionState.Error : ConnectionState.Idle
    );
  }

  end() {
    // may never have got as far as constructing one, e.g. an unsupported
    // protocol threw out of the acquisition
    if (this.fs) {
      this.fs.end();
    }
    app.connectionBarItem.clear(this.id);
  }
}

function getLocalFs() {
  return Promise.resolve(localFs);
}

const fsTable: {
  [x: string]: KeepAliveRemoteFs;
} = {};

export function createRemoteIfNoneExist(
  option,
  policy: ConnectionPolicy = {}
): Promise<FileSystem> {
  if (option.protocol === 'local') {
    return getLocalFs();
  }

  const identity = connectionIdentity(option);
  const fs = fsTable[identity];
  if (fs !== undefined) {
    return fs.getFs(option, policy);
  }

  const fsInstance = new KeepAliveRemoteFs(identity);
  fsTable[identity] = fsInstance;
  return fsInstance.getFs(option, policy);
}

// Closes the pooled connection for `option` and drops it from the pool.
// Returns whether there was one to close, so callers can report an honest
// count rather than one connection per config they tried.
export function removeRemoteFs(option): boolean {
  const identity = connectionIdentity(option);
  const fs = fsTable[identity];
  if (fs === undefined) {
    return false;
  }

  fs.end();
  delete fsTable[identity];
  return true;
}

// Closes every pooled connection. The last-resort escape hatch: a connection
// whose config can no longer be resolved -- an sftp.json edited while it was
// open -- is unreachable through removeRemoteFs(), because the option object
// that produced its identity is gone.
export function removeAllRemoteFs(): number {
  const identities = Object.keys(fsTable);
  identities.forEach(identity => {
    fsTable[identity].end();
    delete fsTable[identity];
  });

  return identities.length;
}
