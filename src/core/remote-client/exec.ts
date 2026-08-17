import { Client, ClientChannel } from 'ssh2';

export interface ExecResult {
  // null when the command was killed before it could exit (timeout, or the
  // channel closed some other way) rather than exiting normally
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  // ms before the command is killed and the promise resolves with
  // timedOut: true. 0 or undefined waits indefinitely.
  timeout?: number;
  onStdout?(chunk: Buffer): void;
  onStderr?(chunk: Buffer): void;
}

// Runs `command` over an already-connected ssh2 client and collects its
// output. Never rejects on a non-zero exit -- that is a normal outcome for a
// remote command and is reported through `code`, not thrown.
//
// On timeout the channel is closed to stop *us* waiting, but plain `exec`
// (no pty) gives ssh2 no reliable way to force the remote process to die:
// OpenSSH's server does not act on channel "signal" requests for exec
// sessions, so `stream.signal()` is sent best-effort and the remote process
// may keep running detached after the promise settles. `timedOut: true`
// reflects that the wait was abandoned, not that the process is confirmed
// dead.
export function execCommand(
  client: Client,
  command: string,
  options: ExecOptions = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream: ClientChannel) => {
      if (err) {
        reject(err);
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      // Shared by every way this can finish (close, timeout, channel error),
      // so each one only has to say what it wants to do once, not repeat the
      // idempotency guard and timer cleanup.
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        fn();
      };

      const settle = (code: number | null, signal: string | null) =>
        finish(() =>
          resolve({
            code,
            signal,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            timedOut,
          })
        );

      if (options.timeout && options.timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            stream.signal('KILL');
          } catch {
            // best-effort; not every server implements channel signals
          }
          stream.close();
          // Settled here rather than waiting for 'close': a hung remote is
          // exactly the case a timeout exists for, and the server may never
          // acknowledge the close.
          settle(null, null);
        }, options.timeout);
      }

      stream
        .on('close', (code: number | null, signal: string | null) => {
          settle(code, signal ?? null);
        })
        // A mid-command connection drop can surface as a channel-level
        // 'error' instead of 'close' -- without this, that case would leave
        // the promise unsettled (and the caller waiting) forever, since
        // neither 'close' nor the timeout would ever fire.
        .on('error', (error: Error) => {
          finish(() => reject(error));
        })
        .on('data', (chunk: Buffer) => {
          stdoutChunks.push(chunk);
          if (options.onStdout) {
            options.onStdout(chunk);
          }
        });

      stream.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
        if (options.onStderr) {
          options.onStderr(chunk);
        }
      });
    });
  });
}
