import FileSystem, { FileOption } from './fileSystem';
import { RemoteClient, ConnectOption, RemoteClientConfig } from '../remote-client';
import { guardOperations } from './operationTimeout';
import logger from '../../logger';

interface RFSOptionDefaults {
  remoteTimeOffsetInHours: number;
  operationTimeout: number;
}

type RFSOption = Partial<RFSOptionDefaults> & {
  client?: RemoteClient;
  clientOption?: ConnectOption;
};

const SECONDS_PER_HOUR = 60 * 60;
const MILLISECONDS_PER_HOUR = SECONDS_PER_HOUR * 1000;

const defaultOption: RFSOptionDefaults = {
  remoteTimeOffsetInHours: 0,
  operationTimeout: 0,
};

export default abstract class RemoteFileSystem extends FileSystem {
  protected client: RemoteClient;
  private _remoteTimeOffsetInMilliseconds: number = 0;
  private _remoteTimeOffsetInSeconds: number = 0;

  constructor(pathResolver, option: RFSOption) {
    super(pathResolver);

    const _option = {
      ...defaultOption,
      ...option,
    };
    const { client, clientOption, remoteTimeOffsetInHours, operationTimeout } = _option;
    if (client) {
      this.client = client;
    } else if (clientOption) {
      this.client = this._createClient(clientOption);
    } else {
      throw new Error('No client or clientOption is provided');
    }

    this.setRemoteTimeOffsetInHours(remoteTimeOffsetInHours);

    // _timedOperations() deliberately returns a literal, so calling an
    // overridden method from the base constructor is safe here -- it cannot
    // read subclass fields, which are not initialized until this returns
    guardOperations(this, this._timedOperations(), operationTimeout, error =>
      this._onOperationTimeout(error)
    );
  }

  // Names of the operations that get a deadline. Only single round trips
  // belong here: an operation built out of several of these is covered by its
  // parts, and one that moves bytes can legitimately take as long as it takes.
  protected _timedOperations(): string[] {
    return [];
  }

  private _onOperationTimeout(error: Error) {
    logger.warn(`${error.message}; dropping the connection`);
    // A server that stopped answering one request will not answer the next
    // one either, and the pooled connection is handed straight back to every
    // later command. end() runs the client's disconnect notification, which
    // is what the pool listens on to evict this instance -- without it the
    // wedged connection survives and only reloading the window clears it.
    try {
      this.end();
    } catch (endError) {
      logger.warn(`failed to close the timed-out connection: ${endError.message}`);
    }
  }

  setRemoteTimeOffsetInHours(offset: number) {
    this._remoteTimeOffsetInSeconds = offset * SECONDS_PER_HOUR;
    this._remoteTimeOffsetInMilliseconds = offset * MILLISECONDS_PER_HOUR;
  }

  getClient() {
    if (!this.client) {
      throw new Error('client not found!');
    }
    return this.client;
  }

  connect(connectOpetion: ConnectOption, config: RemoteClientConfig): Promise<void> {
    return this.client.connect(
      connectOpetion,
      config
    );
  }

  onDisconnected(cb) {
    this.client.onDisconnected(cb);
  }

  // A cheap round-trip that tells a live connection apart from one the server
  // has dropped without telling us. Resolves when the remote answers, rejects
  // when it refuses, and simply never settles on a half-open socket -- callers
  // are expected to race it against a timeout.
  abstract probe(): Promise<void>;

  end() {
    this.client.end();
  }

  toLocalTime(remoteTimeMilliseconds: number): number {
    return remoteTimeMilliseconds - this._remoteTimeOffsetInMilliseconds;
  }

  toRemoteTimeInSecnonds(localtime: number): number {
    return localtime + this._remoteTimeOffsetInSeconds;
  }

  async readFile(path: string, option?: FileOption): Promise<string | Buffer> {
    return new Promise<string | Buffer>(async (resolve, reject) => {
      let stream;
      try {
        stream = await this.get(path, option);
      } catch (error) {
        return reject(error);
      }

      const arr: Buffer[] = [];
      const onData = chunk => {
        arr.push(chunk);
      };
      const onEnd = err => {
        if (err) {
          return reject(err);
        }

        const buffer = Buffer.concat(arr);
        resolve(
          option && option.encoding ? buffer.toString(option.encoding as BufferEncoding) : buffer
        );
      };

      stream.on('data', onData);
      stream.on('error', onEnd);
      stream.on('end', onEnd);
    });
  }

  protected abstract _createClient(option: ConnectOption): any;
}
