import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as sshConfig from 'ssh-config';
import app from '../app';
import logger from '../logger';
import { getUserSetting } from '../host';
import { replaceHomePath, resolvePath } from '../helper';
import { SETTING_KEY_REMOTE } from '../constants';
import upath from './upath';
import Ignore from './ignore';
import { FileSystem } from './fs';
import Scheduler from './scheduler';
import { createRemoteIfNoneExist, removeRemoteFs } from './remoteFs';
import TransferTask, { isRetryable } from './transferTask';
import localFs from './localFs';

type Omit<T, U> = Pick<T, Exclude<keyof T, U>>;

interface Root {
  name: string;
  context: string;
  watcher: WatcherConfig;
  defaultProfile: string;
}

interface Host {
  host: string;
  port: number;
  username: string;
  password: string;
  remotePath: string;
  connectTimeout: number;
}

interface ServiceOption {
  protocol: string;
  remote?: string;
  uploadOnSave: boolean;
  useTempFile: boolean;
  openSsh: boolean;
  downloadOnOpen: boolean | 'confirm';
  conflictCheck: boolean;
  filePerm?: number;
  dirPerm?: number;
  syncOption: {
    delete: boolean;
    skipCreate: boolean;
    ignoreExisting: boolean;
    update: boolean;
  };
  ignore: string[];
  ignoreFile: string;
  remoteExplorer: {
    filesExclude?: string[];
    order: number;
  };
  remoteTimeOffsetInHours: number;
  limitOpenFilesOnRemote: number | true;
  retry: RetryOption;
  // ms of inactivity after which a pooled connection is checked before reuse
  idleTimeout: number;
  // ms without progress before a transfer is treated as stalled
  stallTimeout: number;
  // ms a single remote request may go unanswered before it is failed
  operationTimeout: number;
  // OpenSSH's StrictHostKeyChecking: how an unknown or changed SSH host key is
  // treated. sftp only.
  strictHostKeyChecking: boolean | 'ask' | 'accept-new';
}

export interface RetryOption {
  // how many extra attempts a failed transfer gets
  attempts: number;
  // base backoff in ms, doubled on every attempt
  delay: number;
}

export interface WatcherConfig {
  files: false | string;
  autoUpload: boolean;
  autoDelete: boolean;
  autoRename: boolean;
}

interface SftpOption {
  // sftp
  agent?: string;
  privateKeyPath?: string;
  passphrase: string | true;
  interactiveAuth: boolean | string[];
  algorithms: any;
  sshConfigPath?: string;
  concurrency: number;
  sshCustomParams?: string;
  hop: (Host & SftpOption)[] | (Host & SftpOption);
}

interface FtpOption {
  secure: boolean | 'control' | 'implicit';
  secureOptions: any;
}

export interface FileServiceConfig
  extends Root,
    Host,
    ServiceOption,
    SftpOption,
    FtpOption {
  profiles?: {
    [x: string]: FileServiceConfig;
  };
}

export interface ServiceConfig
  extends Root,
    Host,
    Omit<ServiceOption, 'ignore'>,
    SftpOption,
    FtpOption {
  ignore?: ((fsPath: string) => boolean) | null;
}

export interface WatcherService {
  create(
    watcherBase: string,
    watcherConfig: WatcherConfig,
    ignore?: ServiceConfig['ignore']
  ): any;
  dispose(watcherBase: string): void;
}

interface TransferScheduler {
  // readonly _scheduler: Scheduler;
  size: number;
  add(x: TransferTask): void;
  run(): Promise<void>;
  stop(): void;
  // true once stop() ran, so the tree walk feeding this scheduler can bail out
  // instead of collecting tasks nothing will ever run
  isStopped(): boolean;
}

type ConfigValidator = (x: any) => { message: string } | undefined;

const DEFAULT_SSHCONFIG_FILE = '~/.ssh/config';

// Last word on how long a connect attempt may take, when neither sftp.json nor
// ~/.ssh/config says.
export const DEFAULT_CONNECT_TIMEOUT = 10 * 1000;

export const DEFAULT_RETRY_OPTION: RetryOption = { attempts: 2, delay: 1000 };

// however long the backoff grows to, never make the user wait longer than this
// between attempts
const MAX_RETRY_DELAY = 15 * 1000;

// Backoff before retry number `attempt` (1 for the first retry). With the
// default base delay that gives 2s, 4s, 8s, ... capped at 15s.
export function getRetryDelay(attempt: number, baseDelay: number): number {
  return Math.min(baseDelay * 2 ** attempt, MAX_RETRY_DELAY);
}

function filesIgnoredFromConfig(config: FileServiceConfig): string[] {
  const cache = app.fsCache;
  const ignore: string[] =
    config.ignore && config.ignore.length ? config.ignore : [];

  const ignoreFile = config.ignoreFile;
  if (!ignoreFile) {
    return ignore;
  }

  let ignoreFromFile;
  if (cache.has(ignoreFile)) {
    ignoreFromFile = cache.get(ignoreFile);
  } else if (fs.existsSync(ignoreFile)) {
    ignoreFromFile = fs.readFileSync(ignoreFile).toString();
    cache.set(ignoreFile, ignoreFromFile);
  } else {
    throw new Error(
      `File ${ignoreFile} not found. Check your config of "ignoreFile"`
    );
  }

  return ignore.concat(ignoreFromFile.split(/\r?\n/g));
}

function getHostInfo(config) {
  const ignoreOptions = [
    'name',
    'remotePath',
    'uploadOnSave',
    'useTempFile',
    'openSsh',
    'downloadOnOpen',
    'conflictCheck',
    'ignore',
    'ignoreFile',
    'watcher',
    'concurrency',
    'syncOption',
    'sshConfigPath',
    // reuse policy, not part of which remote this is -- see ConnectionPolicy
    'idleTimeout',
    // transfer policy, likewise
    'stallTimeout',
    // request policy, likewise
    'operationTimeout',
    // host key policy, likewise -- tightening it must not open a second
    // connection to the same server, and it is not part of which host this is
    'strictHostKeyChecking',
  ];

  return Object.keys(config).reduce((obj, key) => {
    if (ignoreOptions.indexOf(key) === -1) {
      obj[key] = config[key];
    }
    return obj;
  }, {});
}

function chooseDefaultPort(protocol) {
  return protocol === 'ftp' ? 21 : 22;
}

function setConfigValue(config, key, value) {
  if (config[key] === undefined) {
    if (key === 'port') {
      config[key] = parseInt(value, 10);
    } else {
      config[key] = value;
    }
  }
}

// A whole number of milliseconds from an ssh config duration, or undefined if
// the value isn't one. Deliberately strict: Number('') and Number(' ') are both
// 0, and a directive with no value should be reported, not read as "disabled".
function secondsToMilliseconds(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }

  return Math.round(seconds * 1000);
}

function mergeConfigWithExternalRefer(
  config: FileServiceConfig
): FileServiceConfig {
  const copyed = Object.assign({}, config);

  if (config.remote) {
    const remoteMap = getUserSetting(SETTING_KEY_REMOTE);
    const remote = remoteMap.get<Record<string, any>>(config.remote);
    if (!remote) {
      throw new Error(`Can\'t not find remote "${config.remote}"`);
    }
    const remoteKeyMapping = new Map([['scheme', 'protocol']]);

    const remoteKeyIgnored = new Map([['rootPath', 1]]);

    Object.keys(remote).forEach(key => {
      if (remoteKeyIgnored.has(key)) {
        return;
      }

      const targetKey = remoteKeyMapping.has(key)
        ? remoteKeyMapping.get(key)
        : key;
      setConfigValue(copyed, targetKey, remote[key]);
    });
  }

  if (config.protocol !== 'sftp') {
    return copyed;
  }

  const sshConfigPath = replaceHomePath(
    config.sshConfigPath || DEFAULT_SSHCONFIG_FILE
  );

  const cache = app.fsCache;
  let sshConfigContent;
  if (cache.has(sshConfigPath)) {
    sshConfigContent = cache.get(sshConfigPath);
  } else {
    try {
      sshConfigContent = fs.readFileSync(sshConfigPath, 'utf8');
    } catch (error) {
      logger.warn(error.message, `load ${sshConfigPath} failed`);
      sshConfigContent = '';
    }
    cache.set(sshConfigPath, sshConfigContent);
  }

  if (!sshConfigContent) {
    return copyed;
  }

  const parsedSSHConfig = sshConfig.parse(sshConfigContent);
  const section = parsedSSHConfig.find({
    Host: copyed.host,
  });

  if (section === null) {
    return copyed;
  }

  // `serveraliveinterval` and `connecttimeout` used to map to `keepalive` and
  // `connTimeout`. ssh2 has never read either name -- it wants
  // `keepaliveInterval` and takes the connect deadline from our own
  // `connectTimeout` -- so both directives were dropped on the floor rather
  // than merely mis-scaled.
  const mapping = new Map([
    ['hostname', 'host'],
    ['port', 'port'],
    ['user', 'username'],
    ['identityfile', 'privateKeyPath'],
    ['serveraliveinterval', 'keepaliveInterval'],
    ['connecttimeout', 'connectTimeout'],
  ]);

  // ~/.ssh/config states both of these in seconds; the options they feed are in
  // milliseconds. ssh2 also type-checks them (`typeof === 'number'`), so the
  // raw string the parser hands us is discarded even under the right key.
  const durationInSeconds = new Set(['keepaliveInterval', 'connectTimeout']);

  section.config.forEach(line => {
    if (!line.param) {
      return;
    }

    const key = mapping.get(line.param.toLowerCase());
    if (key === undefined) {
      return;
    }

    if (key === 'host') {
      copyed[key] = line.value;
      return;
    }

    if (durationInSeconds.has(key)) {
      const milliseconds = secondsToMilliseconds(line.value);
      if (milliseconds === undefined) {
        logger.warn(
          `Ignoring "${line.param} ${line.value}" from ${sshConfigPath}:` +
            ' expected a number of seconds.'
        );
        return;
      }

      setConfigValue(copyed, key, milliseconds);
      logger.debug(
        `${line.param} ${line.value} from ${sshConfigPath}` +
          ` -> ${key} ${copyed[key]}ms`
      );
      return;
    }

    setConfigValue(copyed, key, line.value);
  });

  // Bug introduced in pull request #69 : Fix ssh config resolution
  /* const parsedSSHConfig = sshConfig.parse(sshConfigContent);
  const computed = parsedSSHConfig.compute(copyed.host);

  const mapping = new Map([
    ['hostname', 'host'],
    ['port', 'port'],
    ['user', 'username'],
    ['serveraliveinterval', 'keepalive'],
    ['connecttimeout', 'connTimeout'],
  ]);

  Object.entries<any>(computed).forEach(([param, value]) => {
    if (param.toLowerCase() === 'identityfile') {
      setConfigValue(copyed, 'privateKeyPath', value[0]);
      return;
    }

    const key = mapping.get(param.toLowerCase());

    if (key !== undefined) {
      // don't need consider config priority, always set to the resolve host.
      if (key === 'host') {
        copyed[key] = value;
      } else {
        setConfigValue(copyed, key, value);
      }
    }
  }); */

  return copyed;
}

function getCompleteConfig(
  config: FileServiceConfig,
  workspace: string
): FileServiceConfig {
  const mergedConfig = mergeConfigWithExternalRefer(config);

  // Applied here rather than in the config defaults, so ConnectTimeout from
  // ~/.ssh/config gets a chance first. Only an explicit sftp.json value outranks
  // it -- and an explicit value is the one thing a default can never impersonate.
  if (mergedConfig.connectTimeout === undefined) {
    mergedConfig.connectTimeout = DEFAULT_CONNECT_TIMEOUT;
  }

  if (mergedConfig.agent && mergedConfig.privateKeyPath) {
    logger.warn(
      'Config Option Conflicted. You are specifing "agent" and "privateKey" at the same time, ' +
        'the later will be ignored.'
    );
  }

  // remove the './' part from a relative path
  mergedConfig.remotePath = upath.normalize(mergedConfig.remotePath);
  if (mergedConfig.privateKeyPath) {
    mergedConfig.privateKeyPath = resolvePath(
      workspace,
      mergedConfig.privateKeyPath
    );
  }

  if (mergedConfig.ignoreFile) {
    mergedConfig.ignoreFile = resolvePath(workspace, mergedConfig.ignoreFile);
  }

  // convert ingore config to ignore function
  if (mergedConfig.agent && mergedConfig.agent.startsWith('$')) {
    const evnVarName = mergedConfig.agent.slice(1);
    const val = process.env[evnVarName];
    if (!val) {
      throw new Error(`Environment variable "${evnVarName}" not found`);
    }
    mergedConfig.agent = val;
  }

  return mergedConfig;
}

function mergeProfile(
  target: FileServiceConfig,
  source: FileServiceConfig
): FileServiceConfig {
  const res = Object.assign({}, target);
  delete res.profiles;

  const keys = Object.keys(source);
  for (const key of keys) {
    if (key === 'ignore') {
      res.ignore = res.ignore.concat(source.ignore);
    } else {
      res[key] = source[key];
    }
  }

  return res;
}

// cache key standing in for "no profile applies", so it can't collide with a
// real profile name
const NO_PROFILE_KEY = '\u0000no-profile';

enum Event {
  QUEUE_TRANSFER = 'QUEUE_TRANSFER',
  BEFORE_TRANSFER = 'BEFORE_TRANSFER',
  AFTER_TRANSFER = 'AFTER_TRANSFER',
  PROGRESS_TRANSFER = 'PROGRESS_TRANSFER',
}

let id = 0;

export default class FileService {
  private _eventEmitter: EventEmitter = new EventEmitter();
  private _name: string;
  private _profiles: string[];
  private _pendingTransferTasks: Set<TransferTask> = new Set();
  private _transferSchedulers: TransferScheduler[] = [];
  private _config: FileServiceConfig;
  private _configValidator: ConfigValidator;
  // resolved configs by profile name. getConfig() is on hot paths (every file
  // save, every explorer entry), and resolving re-reads the ssh config and the
  // ignore file every time.
  private _configCache: Map<string, ServiceConfig> = new Map();
  // ignore files whose contents we put in the shared app.fsCache while
  // resolving, so invalidation can drop them too
  private _cachedIgnoreFiles: Set<string> = new Set();
  private _watcherService: WatcherService = {
    create() {
      /* do nothing  */
    },
    dispose() {
      /* do nothing  */
    },
  };
  id: number;
  baseDir: string;
  workspace: string;

  constructor(baseDir: string, workspace: string, config: FileServiceConfig) {
    this.id = ++id;
    this.workspace = workspace;
    this.baseDir = baseDir;
    this._config = config;
    if (config.profiles) {
      this._profiles = Object.keys(config.profiles);
    }
  }

  get name(): string {
    return this._name ? this._name : '';
  }

  set name(name: string) {
    this._name = name;
  }

  setConfigValidator(configValidator: ConfigValidator) {
    this._configValidator = configValidator;
  }

  setWatcherService(watcherService: WatcherService) {
    if (this._watcherService) {
      this._disposeWatcher();
    }

    this._watcherService = watcherService;
    this._createWatcher();
  }

  // Rebuild the watcher from the currently resolved config. Call after anything
  // that can change which config the service resolves to -- switching profile,
  // editing a value in memory -- since the watcher is built once and would
  // otherwise keep watching under the old rules.
  reloadWatcher() {
    this._disposeWatcher();
    this._createWatcher();
  }

  getAvailableProfiles(): string[] {
    return this._profiles || [];
  }

  getPendingTransferTasks(): TransferTask[] {
    return Array.from(this._pendingTransferTasks);
  }

  isTransferring() {
    return this._transferSchedulers.length > 0;
  }

  cancelTransferTasks() {
    // keep the order
    // 1, remove tasks not start
    this._transferSchedulers.forEach(transfer => transfer.stop());
    this._transferSchedulers.length = 0;

    // 2. cancel running task
    this._pendingTransferTasks.forEach(t => t.cancel());
    this._pendingTransferTasks.clear();
  }

  onQueueTransfer(listener: (task: TransferTask) => void) {
    this._eventEmitter.on(Event.QUEUE_TRANSFER, listener);
  }

  beforeTransfer(listener: (task: TransferTask) => void) {
    this._eventEmitter.on(Event.BEFORE_TRANSFER, listener);
  }

  afterTransfer(listener: (err: Error | null, task: TransferTask) => void) {
    this._eventEmitter.on(Event.AFTER_TRANSFER, listener);
  }

  onProgressTransfer(listener: (task: TransferTask) => void) {
    this._eventEmitter.on(Event.PROGRESS_TRANSFER, listener);
  }

  createTransferScheduler(
    concurrency,
    retryOption: RetryOption = DEFAULT_RETRY_OPTION,
    stallTimeout: number = 0
  ): TransferScheduler {
    const fileService = this;
    const { attempts: maxRetries, delay: retryBaseDelay } = {
      ...DEFAULT_RETRY_OPTION,
      ...retryOption,
    };
    const scheduler = new Scheduler({
      autoStart: false,
      concurrency,
    });

    // tasks waiting out their backoff, with the failure that put them there.
    // They are in neither the queue nor the pending set, so the scheduler can go
    // idle while they wait -- we hold the run() promise open for them instead.
    const retryTimers = new Map<
      TransferTask,
      { timer: ReturnType<typeof setTimeout>; error: Error }
    >();

    scheduler.onTaskStart(task => {
      const transferTask = task as TransferTask;
      // emitted synchronously before run(), so the task is armed in time
      transferTask.stallTimeout = stallTimeout;
      this._pendingTransferTasks.add(transferTask);
      transferTask.setProgressListener(() =>
        this._eventEmitter.emit(Event.PROGRESS_TRANSFER, transferTask)
      );
      this._eventEmitter.emit(Event.BEFORE_TRANSFER, task);
    });
    scheduler.onTaskDone((err, task) => {
      const transferTask = task as TransferTask;
      this._pendingTransferTasks.delete(transferTask);

      if (
        err &&
        !isStopped &&
        !transferTask.isCancelled() &&
        transferTask.attempts < maxRetries &&
        isRetryable(err)
      ) {
        transferTask.reset();
        transferTask.attempts += 1;
        const delay = getRetryDelay(transferTask.attempts, retryBaseDelay);
        logger.warn(
          `${transferTask.transferType} ${transferTask.localFsPath} failed` +
            ` (${err.message}), retrying in ${delay}ms` +
            ` (attempt ${transferTask.attempts} of ${maxRetries})`
        );
        const timer = setTimeout(() => {
          retryTimers.delete(transferTask);
          if (isStopped) {
            // nothing left to run this task; let run() settle
            finishRun();
            return;
          }
          scheduler.add(transferTask);
        }, delay);
        retryTimers.set(transferTask, { timer, error: err });
        return;
      }

      this._eventEmitter.emit(Event.AFTER_TRANSFER, err, task);
      transferTask.dispose();
    });

    let runningPromise: Promise<void> | null = null;
    let resolveRunning: (() => void) | null = null;
    let isStopped: boolean = false;

    // settle run(), but only once every task (including ones sitting in a
    // backoff) is accounted for
    function finishRun() {
      if (!resolveRunning || retryTimers.size > 0) {
        return;
      }

      const resolve = resolveRunning;
      resolveRunning = null;
      runningPromise = null;
      fileService._removeScheduler(transferScheduler);
      resolve();
    }

    const transferScheduler: TransferScheduler = {
      get size() {
        return scheduler.size;
      },
      stop() {
        isStopped = true;
        // a task mid-backoff will never run again, so cancel it and let it
        // report as cancelled -- otherwise it would hang around forever in the
        // Transfers view and the progress counters
        const abandoned = Array.from(retryTimers.entries());
        retryTimers.clear();
        abandoned.forEach(([task, { timer, error }]) => {
          clearTimeout(timer);
          task.cancel();
          fileService._eventEmitter.emit(Event.AFTER_TRANSFER, error, task);
          task.dispose();
        });
        scheduler.empty();
        if (scheduler.pendingCount <= 0) {
          finishRun();
        }
      },
      isStopped() {
        return isStopped;
      },
      add(task: TransferTask) {
        if (isStopped) {
          return;
        }

        fileService._eventEmitter.emit(Event.QUEUE_TRANSFER, task);
        scheduler.add(task);
      },
      run() {
        if (isStopped) {
          return Promise.resolve();
        }

        if (scheduler.size <= 0) {
          fileService._removeScheduler(transferScheduler);
          return Promise.resolve();
        }

        if (!runningPromise) {
          runningPromise = new Promise(resolve => {
            resolveRunning = resolve;
            scheduler.onIdle(finishRun);
            scheduler.start();
          });
        }
        return runningPromise;
      },
    };
    fileService._storeScheduler(transferScheduler);

    return transferScheduler;
  }

  getLocalFileSystem(): FileSystem {
    return localFs;
  }

  getRemoteFileSystem(config: ServiceConfig): Promise<FileSystem> {
    return createRemoteIfNoneExist(getHostInfo(config), {
      idleTimeout: config.idleTimeout,
      operationTimeout: config.operationTimeout,
      strictHostKeyChecking: config.strictHostKeyChecking,
    });
  }

  getConfig(useProfile = app.state.profile): ServiceConfig {
    let config = this._config;
    const hasProfile =
      config.profiles && Object.keys(config.profiles).length > 0;
    // a profile only matters when the config defines some, so everything else
    // shares a single cache entry
    const activeProfile = hasProfile && useProfile ? useProfile : null;
    const cacheKey = activeProfile === null ? NO_PROFILE_KEY : activeProfile;

    const cached = this._configCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    if (activeProfile) {
      logger.info(`Using profile: ${activeProfile}`);
      const profile = config.profiles![activeProfile];
      if (!profile) {
        throw new Error(
          `Unkown Profile "${activeProfile}".` +
            ' Please check your profile setting.' +
            ' You can set a profile by running command `SFTP: Set Profile`.'
        );
      }
      config = mergeProfile(config, profile);
    }

    const completeConfig = getCompleteConfig(config, this.workspace);
    const error =
      this._configValidator && this._configValidator(completeConfig);
    if (error) {
      let errorMsg = `Config validation fail: ${error.message}.`;
      if (hasProfile && app.state.profile == null) {
        errorMsg += ' You might want to set a profile first.';
      }
      // never cache a failure -- it has to surface on every call
      throw new Error(errorMsg);
    }

    const serviceConfig = this._resolveServiceConfig(completeConfig);
    if (serviceConfig.ignoreFile) {
      this._cachedIgnoreFiles.add(serviceConfig.ignoreFile);
    }
    this._configCache.set(cacheKey, serviceConfig);

    return serviceConfig;
  }

  // drop the memoized configs so the next getConfig() resolves from scratch.
  // Call this whenever the config, or a file it points at, can have changed.
  invalidateConfigCache() {
    this._configCache.clear();
    // ignore file contents live in the shared fs cache, so they'd otherwise
    // survive and get re-used by the freshly resolved config
    this._cachedIgnoreFiles.forEach(ignoreFile => app.fsCache.delete(ignoreFile));
    this._cachedIgnoreFiles.clear();
  }

  getAllConfig(): Array<ServiceConfig> {
    const profiles = this._config.profiles;
    return profiles ? Object.keys(profiles).map(p => this.getConfig(p)) : [];
  }

  // the raw (unmerged) config this service was created from
  getRawConfig(): FileServiceConfig {
    return this._config;
  }

  // update a top-level config value in memory so behaviour changes without a
  // full reload (callers are responsible for persisting the change to disk)
  setConfigValue(key: keyof FileServiceConfig, value: any) {
    (this._config as any)[key] = value;
    this.invalidateConfigCache();
    // the watcher holds a resolved snapshot -- its pattern and its ignore
    // function -- so `SFTP: Add to Ignore List` and friends have to rebuild it
    this.reloadWatcher();
  }

  // Closes every pooled connection this service can own -- one per profile,
  // plus the profile-less one -- and drops them, so the next command dials
  // fresh. Safe to call when nothing is connected. Returns how many were
  // actually open, so the caller can report a number that is true.
  disconnect(): number {
    return this._disposeFileSystem();
  }

  dispose() {
    this._disposeWatcher();
    this._disposeFileSystem();
  }

  private _resolveServiceConfig(
    fileServiceConfig: FileServiceConfig
  ): ServiceConfig {
    const serviceConfig: ServiceConfig = fileServiceConfig as any;

    if (serviceConfig.port === undefined) {
      serviceConfig.port = chooseDefaultPort(serviceConfig.protocol);
    }
    if (serviceConfig.protocol === 'ftp') {
      serviceConfig.concurrency = 1;
    }
    serviceConfig.ignore = this._createIgnoreFn(fileServiceConfig);

    return serviceConfig;
  }

  private _storeScheduler(scheduler: TransferScheduler) {
    this._transferSchedulers.push(scheduler);
  }

  private _removeScheduler(scheduler: TransferScheduler) {
    const index = this._transferSchedulers.findIndex(s => s === scheduler);
    if (index !== -1) {
      this._transferSchedulers.splice(index, 1);
    }
  }

  private _createIgnoreFn(config: FileServiceConfig): ServiceConfig['ignore'] {
    const localContext = this.baseDir;
    const remoteContext = config.remotePath;

    const ignoreConfig = filesIgnoredFromConfig(config);
    if (ignoreConfig.length <= 0) {
      return null;
    }

    const ignore = Ignore.from(ignoreConfig);
    const ignoreFunc = fsPath => {
      // vscode will always return path with / as separator
      const normalizedPath = path.normalize(fsPath);
      let relativePath;
      if (normalizedPath.indexOf(localContext) === 0) {
        // local path
        relativePath = path.relative(localContext, fsPath);
      } else {
        // remote path
        relativePath = upath.relative(remoteContext, fsPath);
      }

      // skip root
      return relativePath !== '' && ignore.ignores(relativePath);
    };

    return ignoreFunc;
  }

  // Built from the profile-merged config, not the raw one. A profile that turns
  // autoUpload off for production is one of the main reasons to use profiles at
  // all, and reading `config.watcher` off the raw config made that setting a
  // no-op. Resolving can throw (an invalid config, an unset profile the config
  // requires); fall back to the raw watcher rather than leaving the service
  // half-constructed.
  private _createWatcher() {
    let watcherConfig: WatcherConfig;
    let ignore: ServiceConfig['ignore'] = null;
    try {
      const config = this.getConfig();
      watcherConfig = config.watcher;
      ignore = config.ignore;
    } catch (error) {
      logger.debug(
        `watcher falling back to the unresolved config: ${(error as Error).message}`
      );
      watcherConfig = this._config.watcher;
    }

    this._watcherService.create(this.baseDir, watcherConfig, ignore);
  }

  private _disposeWatcher() {
    this._watcherService.dispose(this.baseDir);
  }

  // Every config this service can resolve to: the profile-less one, plus one
  // per defined profile. Each is guarded on its own -- a profile that no longer
  // validates must not stop the rest from being visited.
  private _eachResolvableConfig(fn: (config: ServiceConfig) => void) {
    const profileKeys: Array<string | null> = [null, ...(this._profiles || [])];

    profileKeys.forEach(profile => {
      let config: ServiceConfig;
      try {
        config = this.getConfig(profile);
      } catch (error) {
        logger.debug(
          `skipping profile "${profile === null ? '<none>' : profile}":` +
            ` ${(error as Error).message}`
        );
        return;
      }

      // two profiles can resolve to the same remote; that is harmless here,
      // since removing an already-removed connection is a no-op that reports
      // itself as such
      fn(config);
    });
  }

  // Closes the pooled connection of *every* profile, not just the active one.
  // A user with dev/staging/prod who has used two of them, then switched
  // profile and hit SFTP: Disconnect, would otherwise be left with the other
  // connection open -- quite possibly the wedged one they ran the command to
  // clear. Same leak applied on config reload and on deactivate.
  private _disposeFileSystem(): number {
    let closed = 0;
    this._eachResolvableConfig(config => {
      if (removeRemoteFs(getHostInfo(config))) {
        closed += 1;
      }
    });

    return closed;
  }
}
