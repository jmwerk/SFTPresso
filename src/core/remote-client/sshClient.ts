import { Client } from 'ssh2';
import upath from '../upath';
import RemoteClient, { ErrorCode, ConnectOption, Config } from './remoteClient';
import localFs from '../localFs';
import { FileSystem, RemoteFileSystem, SFTPFileSystem } from '../fs';
import logger from '../../logger';
import CustomError from '../customError';
import { describeConnectError } from '../../helper/error';
import { isKnownHost, normalizeStrictHostKeyChecking } from './hostKeyStore';
import { verifyHostKey } from './hostKeyVerifier';

let MAX_OPEN_FD_NUM = 222;

// How long the handshake is given when a host key prompt is going to appear in
// the middle of it. ssh2's readyTimeout runs from connect() to 'ready', and the
// verifier holds the handshake open while the modal is up -- with the usual
// ten-second budget the connection would be torn down while the user is still
// reading the fingerprint they are being asked to check.
const HOST_KEY_PROMPT_READY_TIMEOUT = 5 * 60 * 1000;

export const DEFAULT_KEEPALIVE_INTERVAL = 30 * 1000;
export const DEFAULT_KEEPALIVE_COUNT_MAX = 2;

// undefined (unset in sftp.json and not derived from ~/.ssh/config) falls
// back to the default; an explicit value, including 0 to disable, wins.
export function resolveKeepaliveInterval(value: number | undefined): number {
  return value === undefined ? DEFAULT_KEEPALIVE_INTERVAL : value;
}

export function resolveKeepaliveCountMax(value: number | undefined): number {
  return value === undefined ? DEFAULT_KEEPALIVE_COUNT_MAX : value;
}

export default class SSHClient extends RemoteClient {
  private sftp: any;
  private hoppingClients: SSHClient[];
  private _opendFdNum: number = 0;
  private _queuedFdRequireCall: Array<(...args: any[]) => any> = [];

  _initClient() {
    return new Client();
  }

  _hasProvideAuth(connectOption: ConnectOption) {
    return (
      // interactiveAuth : boolean
      connectOption.interactiveAuth === true ||
      // or interactiveAuth : array of phrases
      (Array.isArray(connectOption.interactiveAuth) && !!connectOption.interactiveAuth.length) ||
      // or key defined
      ['password', 'agent', 'privateKeyPath'].some(key => connectOption[key] != null)
    );
  }

  async _doConnect(
    connectOption: ConnectOption,
    config: Config
  ): Promise<void> {
    const { hop, ...option } = connectOption;

    let lastOption: ConnectOption = option;
    let fs: FileSystem | RemoteFileSystem = localFs;
    let sock;
    if (
      (Array.isArray(hop) && hop.length > 0) ||
      (hop && Object.keys(hop).length > 0)
    ) {
      this.hoppingClients = [];
      // Every host in the chain is verified in its own right, so each hop
      // inherits the config's policy unless it overrides it. A bastion is
      // exactly as impersonatable as the host behind it.
      const inheritPolicy = (opt: ConnectOption): ConnectOption =>
        opt.strictHostKeyChecking === undefined
          ? { ...opt, strictHostKeyChecking: option.strictHostKeyChecking }
          : opt;

      const connectOptions = (Array.isArray(hop)
        ? [option].concat(hop)
        : [option, hop]
      ).map(inheritPolicy);
      lastOption = connectOptions.pop()!;

      for (let index = 0; index < connectOptions.length; index++) {
        const curOpt = connectOptions[index];
        if (curOpt.port === undefined) {
          curOpt.port = 22;
        }
        const preClient = this.hoppingClients[index - 1];
        if (preClient) {
          sock = await this._makeHopping(preClient, curOpt.host, curOpt.port);
          fs = new SFTPFileSystem(upath, {
            client: preClient,
          });
        }

        if (curOpt.privateKeyPath) {
          const buffer = await fs.readFile(curOpt.privateKeyPath);
          curOpt.privateKey = buffer.toString();
        }

        const client = new SSHClient(curOpt);
        this.hoppingClients.push(client);
        await client.connect({ ...curOpt, sock }, config);
      }

      const lastClient = this.hoppingClients[this.hoppingClients.length - 1];
      sock = await this._makeHopping(
        lastClient,
        lastOption.host,
        lastOption.port
      );
      fs = new SFTPFileSystem(upath, {
        client: lastClient,
      });
    }

    if (lastOption.privateKeyPath) {
      const buffer = await fs.readFile(lastOption.privateKeyPath);
      lastOption.privateKey = buffer.toString();
    }

    await this._connectSSHClient(this._client, { ...lastOption, sock }, config);
    this.sftp = await this._getSftp(this._client);

    if (lastOption.limitOpenFilesOnRemote) {
      if (typeof lastOption.limitOpenFilesOnRemote !== 'boolean') {
        MAX_OPEN_FD_NUM = Math.max(127, lastOption.limitOpenFilesOnRemote);
      }
      this._limitSftpFileDescriptor();
    }
  }

  // connect1(readline): Promise<void> {
  //   const {
  //     interactiveAuth,
  //     password,
  //     privateKeyPath,
  //     connectTimeout,
  //     ...option
  //   } = this.getOption();
  //   return new Promise<void>((resolve, reject) => {
  //     const connectWithCredential = (passwd?, privateKey?) =>
  //       this.client
  //         .on('ready', () => {
  //           this.client.sftp((err, sftp) => {
  //             if (err) {
  //               reject(err);
  //             }

  //             this.sftp = sftp;
  //             resolve();
  //           });
  //         })
  //         .on('error', err => {
  //           reject(err);
  //         })
  //         .connect({
  //           keepaliveInterval: 1000 * 30,
  //           keepaliveCountMax: 2,
  //           readyTimeout: interactiveAuth ? Math.max(60 * 1000, connectTimeout) : connectTimeout,
  //           ...option,
  //           privateKey,
  //           password: passwd,
  //           tryKeyboard: interactiveAuth,
  //         });

  //     if (interactiveAuth) {
  //       this.client.on('keyboard-interactive', function redo(
  //         name,
  //         instructions,
  //         instructionsLang,
  //         prompts,
  //         finish,
  //         stackedAnswers
  //       ) {
  //         const answers = stackedAnswers || [];
  //         if (answers.length < prompts.length) {
  //           readline(prompts[answers.length].prompt).then(answer => {
  //             answers.push(answer);
  //             redo(name, instructions, instructionsLang, prompts, finish, answers);
  //           });
  //         } else {
  //           finish(answers);
  //         }
  //       });
  //     }

  //     if (!privateKeyPath) {
  //       connectWithCredential(password);
  //       return;
  //     }

  //     fs.readFile(privateKeyPath, (err, data) => {
  //       if (err) {
  //         reject(err);
  //         return;
  //       }
  //       connectWithCredential(password, data);
  //     });
  //   });
  // }

  private _limitSftpFileDescriptor() {
    const sftp = this.sftp;
    // ssh2 0.8 kept the protocol object behind `sftp._stream`; since ssh2 1.x
    // the SFTP instance carries open/opendir/close itself, so the old hook
    // threw "Cannot read properties of undefined" and broke every connection
    // that set limitOpenFilesOnRemote.
    if (
      !sftp ||
      typeof sftp.open !== 'function' ||
      typeof sftp.opendir !== 'function' ||
      typeof sftp.close !== 'function'
    ) {
      logger.warn(
        'limitOpenFilesOnRemote is not supported by this ssh2 client; continuing without the file-descriptor limit.'
      );
      return;
    }

    const { open, opendir, close } = sftp;
    sftp.open = this._hookCallForRequestFileDescriptor(open);
    sftp.opendir = this._hookCallForRequestFileDescriptor(opendir);
    sftp.close = this._hookCallForReleaseFileDescriptor(close);
  }

  private _hookCallForReleaseFileDescriptor(fn) {
    const self = this;
    return function releaseFileDescriptor(this: any) {
      const last = arguments.length - 1;
      const args = Array.prototype.slice.call(arguments, 0, last);
      const cb = arguments[last];
      function wrapped(this: any) {
        // 队列到下一周期执行, 确保 cb 先执行.
        Promise.resolve().then(() => {
          if (self._queuedFdRequireCall.length > 0) {
            const queuedCall = self._queuedFdRequireCall.pop()!;
            queuedCall();
          }
        });
        self._opendFdNum -= 1;
        cb.apply(this, arguments);
      }
      args.push(wrapped);
      return fn.apply(this, args);
    };
  }

  private _hookCallForRequestFileDescriptor(fn) {
    const self = this;
    return function requestFileDescriptor(this: any) {
      const last = arguments.length - 1;
      const args = Array.prototype.slice.call(arguments, 0, last);
      const cb = arguments[last];
      function wrapped(this: any) {
        self._opendFdNum += 1;
        cb.apply(this, arguments);
      }
      args.push(wrapped);

      if (self._opendFdNum >= MAX_OPEN_FD_NUM) {
        self._queuedFdRequireCall.push(() => {
          fn.apply(this, args);
        });
        return;
      }

      return fn.apply(this, args);
    };
  }

  private async _connectSSHClient(
    client,
    remoteOption: ConnectOption,
    config: Config
  ): Promise<any> {
    const {
      interactiveAuth,
      connectTimeout,
      strictHostKeyChecking,
      keepaliveInterval,
      keepaliveCountMax,
      ...option
    } = remoteOption;

    const policy = normalizeStrictHostKeyChecking(strictHostKeyChecking);
    // ssh2 turns a refused key into a generic "Host denied (verification
    // failed)". Ours says which host, which fingerprints, and what to do about
    // it, so it is kept here and preferred over whatever the socket reports.
    let hostKeyError: Error | undefined;
    const hostVerifier = (key: Buffer, verify: (ok: boolean) => void) => {
      verifyHostKey({
        host: option.host,
        port: option.port,
        key,
        policy,
        prompt: config.hostKeyPrompt,
      }).then(
        () => verify(true),
        error => {
          hostKeyError = error;
          verify(false);
        }
      );
      // returning undefined tells ssh2 the verdict arrives via the callback
    };

    // Only 'ask' prompts, and only for a host no store has heard of. Asking the
    // store up front costs one small file read and keeps the extended deadline
    // off every other connection, where a stalled handshake should still give
    // up in `connectTimeout`.
    const willPromptForHostKey =
      policy === 'ask' && !(await isKnownHost(option.host, option.port));

    // explict compare to true, cause we want to distinct between string and true
    if (option.passphrase === true) {
      option.passphrase = await config.askForPasswd(
        `[${option.host}]: Enter your passphrase`
      );
      if (option.passphrase === undefined) {
        throw new CustomError(ErrorCode.CONNECT_CANCELLED, 'cancelled');
      }
    }

    return new Promise<void>((resolve, reject) => {
      if (interactiveAuth) {
        client.on('keyboard-interactive', function redo(
          name,
          instructions,
          instructionsLang,
          prompts,
          finish,
          stackedAnswers
        ) {
          const answers = stackedAnswers ||
            // load predefined answeres if any
            (Array.isArray(interactiveAuth) ? interactiveAuth : undefined) ||
            [];
          if (answers.length < prompts.length) {
            config
              .askForPasswd(
                `[${option.host}]: ${prompts[answers.length].prompt}`
              )
              .then(answer => {
                if (answer === undefined) {
                  return reject(
                    new CustomError(ErrorCode.CONNECT_CANCELLED, 'cancelled')
                  );
                }

                answers.push(answer);
                redo(
                  name,
                  instructions,
                  instructionsLang,
                  prompts,
                  finish,
                  answers
                );
              });
          } else {
            finish(answers);
          }
        });
      }

      client
        .on('ready', resolve)
        .on('error', err => {
          reject(hostKeyError || describeConnectError(err, option.host));
        })
        .on('close', () => this.end())
        .on('end', () => this.end())
        .connect({
          keepaliveInterval: resolveKeepaliveInterval(keepaliveInterval),
          keepaliveCountMax: resolveKeepaliveCountMax(keepaliveCountMax),
          readyTimeout: willPromptForHostKey
            ? Math.max(HOST_KEY_PROMPT_READY_TIMEOUT, connectTimeout || 0)
            : interactiveAuth
            ? Math.max(60 * 1000, connectTimeout || 0) // 60 secs, original
            // ? Math.max(1800 * 1000, connectTimeout || 0) // 30 mins
            // ? Math.max(10800 * 1000, connectTimeout || 0) // 180 mins
            : connectTimeout,
          ...option,
          tryKeyboard: !!interactiveAuth,
          // last, so nothing in the user's config can spread over it and turn
          // verification back off
          hostVerifier,
        });
    });
  }

  private _getSftp(client): Promise<any> {
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(sftp);
      });
    });
  }

  private _makeHopping(sshClient: SSHClient, dstHost, dstPort): Promise<any> {
    logger.info(`hopping from ${sshClient._option.host} to ${dstHost}`);
    return new Promise((resolve, reject) => {
      // Create a connect form 127.0.0.1:port to dstHost:dstPort
      sshClient._client.forwardOut(
        '127.0.0.1',
        sshClient._option.port,
        dstHost,
        dstPort,
        (error, stream) => {
          if (error) {
            return reject(error);
          }

          resolve(stream);
        }
      );
    });
  }

  end() {
    this._client.end();

    if (this.hoppingClients) {
      // last connect first end
      this.hoppingClients.reverse().forEach(client => client.end());
    }
  }

  getFsClient() {
    return this.sftp;
  }

  // The raw ssh2 client, for callers that need something the SFTP subsystem
  // does not expose -- currently `exec()` for SFTP: Run Remote Command.
  getRawClient(): Client {
    return this._client;
  }
}
