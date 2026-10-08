import { EventEmitter } from 'events';
import RemoteTerminal from '../remoteTerminal';

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  written: string[] = [];
  windows: number[][] = [];
  closeCalls = 0;

  write(data: string) {
    this.written.push(data);
  }

  setWindow(rows: number, cols: number, height: number, width: number) {
    this.windows.push([rows, cols, height, width]);
  }

  close() {
    this.closeCalls += 1;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  const pending = deferred<any>();
  const connect = jest.fn(() => pending.promise);
  const terminal = new RemoteTerminal({ host: 'example.com', connect });
  const output: string[] = [];
  const closes: Array<number | void> = [];
  terminal.onDidWrite(text => output.push(text));
  terminal.onDidClose!(code => closes.push(code));
  return { terminal, pending, connect, output, closes, text: () => output.join('') };
}

describe('RemoteTerminal', () => {
  it('connects with the initial dimensions and pipes output both ways', async () => {
    const { terminal, pending, connect, output, text } = setup();
    const channel = new FakeChannel();

    terminal.open({ columns: 100, rows: 30 });
    expect(connect).toHaveBeenCalledWith({ columns: 100, rows: 30 });
    expect(text()).toContain('Connecting to example.com');

    pending.resolve(channel);
    await flush();
    output.length = 0;

    channel.emit('data', Buffer.from('$ '));
    channel.stderr.emit('data', Buffer.from('warn\r\n'));
    terminal.handleInput('ls\r');

    expect(text()).toBe('$ warn\r\n');
    expect(channel.written).toEqual(['ls\r']);
    expect(channel.windows).toEqual([]);
  });

  it('defaults to 80x24 without initial dimensions', () => {
    const { terminal, connect } = setup();

    terminal.open(undefined);

    expect(connect).toHaveBeenCalledWith({ columns: 80, rows: 24 });
  });

  it('keeps a multi-byte character split across chunks intact', async () => {
    const { terminal, pending, output } = setup();
    const channel = new FakeChannel();
    terminal.open(undefined);
    pending.resolve(channel);
    await flush();
    output.length = 0;

    const bytes = Buffer.from('é');
    channel.emit('data', bytes.subarray(0, 1));
    channel.emit('data', bytes.subarray(1));

    expect(output.join('')).toBe('é');
  });

  it('resizes the pty, including a resize made while connecting', async () => {
    const { terminal, pending } = setup();
    const channel = new FakeChannel();

    terminal.open({ columns: 80, rows: 24 });
    terminal.setDimensions({ columns: 90, rows: 25 });
    pending.resolve(channel);
    await flush();
    terminal.setDimensions({ columns: 120, rows: 40 });

    expect(channel.windows).toEqual([
      [25, 90, 0, 0],
      [40, 120, 0, 0],
    ]);
  });

  it('closes with the exit code when the shell exits', async () => {
    const { terminal, pending, closes } = setup();
    const channel = new FakeChannel();
    terminal.open(undefined);
    pending.resolve(channel);
    await flush();

    channel.emit('exit', 0);
    channel.emit('close');

    expect(closes).toEqual([0]);
  });

  it('stays open with a message when the connection drops', async () => {
    const { terminal, pending, closes, text } = setup();
    const channel = new FakeChannel();
    terminal.open(undefined);
    pending.resolve(channel);
    await flush();

    channel.emit('error', new Error('read ECONNRESET'));
    channel.emit('close');

    expect(closes).toEqual([]);
    expect(text()).toContain('Connection to example.com closed: read ECONNRESET');

    terminal.handleInput('x');
    expect(closes).toEqual([undefined]);
    expect(channel.written).toEqual([]);
  });

  it('reports a failed connection and closes on the next key', async () => {
    const { terminal, pending, closes, text } = setup();

    terminal.open(undefined);
    pending.reject(new Error('All configured authentication methods failed'));
    await flush();

    expect(text()).toContain(
      'Could not open a shell on example.com: All configured authentication methods failed'
    );
    expect(text()).toContain('Press any key to close this terminal.');
    expect(closes).toEqual([]);

    terminal.handleInput('\r');
    expect(closes).toEqual([undefined]);
  });

  it('sends input typed while connecting once the shell is ready', async () => {
    const { terminal, pending } = setup();
    const channel = new FakeChannel();

    terminal.open(undefined);
    terminal.handleInput('l');
    terminal.handleInput('s\r');
    expect(channel.written).toEqual([]);

    pending.resolve(channel);
    await flush();
    terminal.handleInput('pwd\r');

    expect(channel.written).toEqual(['l', 's\r', 'pwd\r']);
  });

  it('drops input typed while connecting when the connection fails', async () => {
    const { terminal, pending, closes } = setup();

    terminal.open(undefined);
    terminal.handleInput('ls\r');
    pending.reject(new Error('timed out'));
    await flush();

    expect(closes).toEqual([]);
    terminal.handleInput('x');
    expect(closes).toEqual([undefined]);
  });

  it('closes the channel when the user closes the terminal', async () => {
    const { terminal, pending, closes } = setup();
    const channel = new FakeChannel();
    terminal.open(undefined);
    pending.resolve(channel);
    await flush();

    terminal.close();
    channel.emit('close');

    expect(channel.closeCalls).toBe(1);
    expect(closes).toEqual([]);
  });

  it('closes a channel that arrives after the terminal was closed', async () => {
    const { terminal, pending, output } = setup();
    const channel = new FakeChannel();
    terminal.open(undefined);
    terminal.close();
    output.length = 0;

    pending.resolve(channel);
    await flush();
    channel.emit('data', Buffer.from('late'));

    expect(channel.closeCalls).toBe(1);
    expect(output).toEqual([]);
  });

  it('prints nothing for a failed connection after the terminal was closed', async () => {
    const { terminal, pending, output } = setup();
    terminal.open(undefined);
    terminal.close();
    output.length = 0;

    pending.reject(new Error('cancelled'));
    await flush();

    expect(output).toEqual([]);
  });
});
