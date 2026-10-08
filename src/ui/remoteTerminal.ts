import type { Event, Pseudoterminal, TerminalDimensions } from 'vscode';
import { StringDecoder } from 'string_decoder';
import { ClientChannel } from 'ssh2';

// Minimal stand-in for vscode.EventEmitter, so the terminal runs (and is tested)
// without the extension host.
class Emitter<T> {
  private listeners: Array<(value: T) => void> = [];

  readonly event: Event<T> = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter(l => l !== listener);
      },
    };
  };

  fire(value: T) {
    this.listeners.slice().forEach(listener => listener(value));
  }
}

const DEFAULT_DIMENSIONS: TerminalDimensions = { columns: 80, rows: 24 };

export interface RemoteTerminalOptions {
  host: string;
  connect(dimensions: TerminalDimensions): Promise<ClientChannel>;
}

type State = 'idle' | 'connecting' | 'open' | 'ended' | 'closed';

// A VS Code terminal backed by a pty channel on the extension's own SSH
// connection, rather than a local `ssh` process that knows nothing of its auth.
export default class RemoteTerminal implements Pseudoterminal {
  private readonly writeEmitter = new Emitter<string>();
  private readonly closeEmitter = new Emitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  private state: State = 'idle';
  private channel: ClientChannel | undefined;
  private dimensions: TerminalDimensions = DEFAULT_DIMENSIONS;
  // typed before the shell was ready; sent once it is, so no keystroke is lost
  private pendingInput: string[] = [];

  constructor(private readonly options: RemoteTerminalOptions) {}

  open(initialDimensions: TerminalDimensions | undefined) {
    if (initialDimensions) {
      this.dimensions = initialDimensions;
    }
    this.state = 'connecting';
    this.writeEmitter.fire(`Connecting to ${this.options.host}…\r\n`);

    const requested = this.dimensions;
    this.options.connect(requested).then(
      channel => this.attach(channel, requested),
      error => this.end(`Could not open a shell on ${this.options.host}: ${error.message}`)
    );
  }

  handleInput(data: string) {
    if (this.state === 'open') {
      this.channel!.write(data);
    } else if (this.state === 'connecting') {
      this.pendingInput.push(data);
    } else if (this.state === 'ended') {
      this.state = 'closed';
      this.closeEmitter.fire();
    }
  }

  setDimensions(dimensions: TerminalDimensions) {
    this.dimensions = dimensions;
    if (this.state === 'open') {
      this.resize();
    }
  }

  // The user closed the terminal.
  close() {
    const wasOpen = this.state === 'open';
    this.state = 'closed';
    if (wasOpen) {
      this.channel!.close();
    }
  }

  private attach(channel: ClientChannel, requested: TerminalDimensions) {
    if (this.state === 'closed') {
      // closed while the shell was still being opened
      channel.close();
      return;
    }
    this.channel = channel;
    this.state = 'open';
    if (
      this.dimensions.columns !== requested.columns ||
      this.dimensions.rows !== requested.rows
    ) {
      this.resize();
    }

    // Per stream, so a multi-byte character split across chunks isn't mangled.
    const stdout = new StringDecoder('utf8');
    const stderr = new StringDecoder('utf8');
    let exitCode: number | undefined;
    let channelError: Error | undefined;

    channel.on('data', (chunk: Buffer) => this.write(stdout.write(chunk)));
    channel.stderr.on('data', (chunk: Buffer) => this.write(stderr.write(chunk)));
    // code is null when the shell was killed by a signal instead of exiting
    channel.on('exit', (code: number | null) => {
      if (typeof code === 'number') {
        exitCode = code;
      }
    });
    channel.on('error', (error: Error) => {
      channelError = error;
    });
    channel.on('close', () => {
      if (this.state !== 'open') {
        return;
      }
      if (exitCode !== undefined) {
        // the shell exited (`exit`, Ctrl+D): close like a local terminal does
        this.state = 'closed';
        this.closeEmitter.fire(exitCode);
        return;
      }
      // no exit status: the connection dropped, or SFTP: Disconnect ended it
      const reason = channelError ? `: ${channelError.message}` : '.';
      this.end(`Connection to ${this.options.host} closed${reason}`);
    });

    this.pendingInput.forEach(data => channel.write(data));
    this.pendingInput = [];
  }

  private write(text: string) {
    if (text && this.state === 'open') {
      // a pty already sends \r\n, so the output is passed through untouched
      this.writeEmitter.fire(text);
    }
  }

  private resize() {
    this.channel!.setWindow(this.dimensions.rows, this.dimensions.columns, 0, 0);
  }

  // Leaves the terminal on screen with the reason, instead of closing it out
  // from under the user before they can read what went wrong.
  private end(message: string) {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'ended';
    this.writeEmitter.fire(
      `\r\n\x1b[31m${message}\x1b[0m\r\nPress any key to close this terminal.\r\n`
    );
  }
}
