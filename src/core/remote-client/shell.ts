import { Client, ClientChannel, PseudoTtyOptions } from 'ssh2';

export interface ShellOptions {
  cols: number;
  rows: number;
  term?: string;
  // Remote directory the shell starts in. undefined or '/' starts wherever the
  // server puts a login (normally the home directory).
  cwd?: string;
}

export const DEFAULT_TERM = 'xterm-256color';

// POSIX single-quoting: the only character that needs care inside '…' is ' itself.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// The command an exec'd pty session runs to land in `cwd` with a login shell.
// A failed cd prints its own error and still falls through to the shell, so a
// stale remotePath leaves the user in their home directory rather than nowhere.
export function startInDirectoryCommand(cwd: string): string {
  return `cd ${shellQuote(cwd)}; exec "\${SHELL:-/bin/sh}" -l`;
}

// Opens an interactive pty session over an already-connected ssh2 client. It is
// one more channel on that connection, so it shares its auth, hops and host key
// check instead of reconnecting.
export function openShell(client: Client, options: ShellOptions): Promise<ClientChannel> {
  const pty: PseudoTtyOptions = {
    term: options.term || DEFAULT_TERM,
    cols: options.cols,
    rows: options.rows,
  };

  return new Promise((resolve, reject) => {
    const done = (err: Error | undefined, stream: ClientChannel) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stream);
    };

    if (options.cwd && options.cwd !== '/') {
      // exec rather than shell(): there is no portable way to make shell() start
      // anywhere but home without typing a visible `cd` into the session
      client.exec(startInDirectoryCommand(options.cwd), { pty }, done);
    } else {
      client.shell(pty, done);
    }
  });
}
