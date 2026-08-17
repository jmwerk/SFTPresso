import { EventEmitter } from 'events';
import { execCommand } from '../exec';

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  closeCalls = 0;
  signalCalls: string[] = [];

  close() {
    this.closeCalls += 1;
  }

  signal(sig: string) {
    this.signalCalls.push(sig);
  }
}

function fakeClient(channel: FakeChannel, execError?: Error) {
  return {
    // synchronous, unlike real ssh2 -- removes any race between the test
    // attaching listeners via execCommand and it emitting events on `channel`
    exec: (_command: string, cb: (err: Error | undefined, stream: any) => void) => {
      cb(execError, channel);
    },
  } as any;
}

describe('execCommand', () => {
  it('collects stdout/stderr and resolves with the exit code', async () => {
    const channel = new FakeChannel();
    const resultPromise = execCommand(fakeClient(channel), 'echo hi; echo warn >&2');

    channel.emit('data', Buffer.from('hi\n'));
    channel.stderr.emit('data', Buffer.from('warn\n'));
    channel.emit('close', 0, null);

    await expect(resultPromise).resolves.toEqual({
      code: 0,
      signal: null,
      stdout: 'hi\n',
      stderr: 'warn\n',
      timedOut: false,
    });
  });

  it('surfaces a non-zero exit code rather than rejecting', async () => {
    const channel = new FakeChannel();
    const resultPromise = execCommand(fakeClient(channel), 'exit 3');

    channel.emit('close', 3, null);

    const result = await resultPromise;
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('rejects when the channel could not be opened', async () => {
    const channel = new FakeChannel();
    const error = new Error('no channels available');

    await expect(execCommand(fakeClient(channel, error), 'echo hi')).rejects.toBe(error);
  });

  it('invokes onStdout/onStderr as chunks arrive', async () => {
    const channel = new FakeChannel();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const resultPromise = execCommand(fakeClient(channel), 'echo hi', {
      onStdout: chunk => stdoutChunks.push(chunk),
      onStderr: chunk => stderrChunks.push(chunk),
    });

    channel.emit('data', Buffer.from('out'));
    channel.stderr.emit('data', Buffer.from('err'));
    channel.emit('close', 0, null);
    await resultPromise;

    expect(Buffer.concat(stdoutChunks).toString()).toBe('out');
    expect(Buffer.concat(stderrChunks).toString()).toBe('err');
  });

  it('kills and reports a command that exceeds the timeout, without waiting for close', async () => {
    const channel = new FakeChannel();
    const resultPromise = execCommand(fakeClient(channel), 'sleep 999', { timeout: 20 });

    // the remote never answers -- 'close' is never emitted -- yet the promise
    // still settles because the timeout forces it
    const result = await resultPromise;

    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(channel.signalCalls).toContain('KILL');
    expect(channel.closeCalls).toBe(1);
  });

  it('ignores a late close after the timeout has already settled the promise', async () => {
    const channel = new FakeChannel();
    const resultPromise = execCommand(fakeClient(channel), 'sleep 999', { timeout: 20 });

    const result = await resultPromise;
    // arrives after settle(); must not throw or change the resolved value
    channel.emit('close', 137, null);

    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
  });

  it("rejects when the channel emits 'error' mid-command (e.g. a dropped connection)", async () => {
    const channel = new FakeChannel();
    const resultPromise = execCommand(fakeClient(channel), 'php artisan queue:work');

    // without a listener, EventEmitter throws synchronously on an unhandled
    // 'error' event -- this must not crash the extension host either
    const error = new Error('read ECONNRESET');
    expect(() => channel.emit('error', error)).not.toThrow();

    await expect(resultPromise).rejects.toBe(error);
  });

  it("ignores a late channel 'error' after the timeout has already settled the promise", async () => {
    const channel = new FakeChannel();
    const resultPromise = execCommand(fakeClient(channel), 'sleep 999', { timeout: 20 });

    const result = await resultPromise;
    // arrives after settle(); must not reject or throw
    expect(() => channel.emit('error', new Error('read ECONNRESET'))).not.toThrow();

    expect(result.timedOut).toBe(true);
  });
});
