import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { FileSystem, FileType, isNotFoundError } from './fs';
import type { ServiceConfig } from './fileService';
import upath from './upath';
import logger from '../logger';

export const DEFAULT_BACKUP_DIR = '.sftpresso-backup';
export const DEFAULT_BACKUP_KEEP = 5;

export interface BackupOption {
  // absolute, already joined with the server's folder
  root: string;
  // 0 keeps every backup
  keep: number;
}

type BackupConfig = { dir?: string; keep?: number } | boolean | null | undefined;

// The configured folder as written, relative to the local context; for the ignore list.
export function backupDirSetting(config: { backup?: BackupConfig }): string | undefined {
  const value = config.backup;
  if (!value) {
    return undefined;
  }
  return (value !== true && value.dir) || DEFAULT_BACKUP_DIR;
}

export function resolveBackup(
  config: Pick<ServiceConfig, 'host' | 'backup'>,
  localBaseDir: string
): BackupOption | undefined {
  const dir = backupDirSetting(config);
  if (!dir) {
    return undefined;
  }
  const value = config.backup;
  const keep =
    typeof value === 'object' && value && typeof value.keep === 'number'
      ? value.keep
      : DEFAULT_BACKUP_KEEP;
  // per server, so profiles pointing at staging and production don't share history
  const server = String(config.host || 'remote').replace(/[^\w.-]/g, '_');
  return { root: path.resolve(localBaseDir, dir, server), keep };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

// Local time, sortable as text: 20261112-153000-123
export function backupStamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `-${pad(date.getMilliseconds(), 3)}`
  );
}

// The stamp goes before the extension so editors still highlight the backup.
function splitName(name: string): [string, string] {
  const ext = path.extname(name);
  return [ext ? name.slice(0, -ext.length) : name, ext];
}

export function backupName(name: string, stamp: string): string {
  const [stem, ext] = splitName(name);
  return `${stem}.${stamp}${ext}`;
}

function backupPattern(name: string): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const [stem, ext] = splitName(name);
  return new RegExp(`^${escape(stem)}\\.\\d{8}-\\d{6}-\\d{3}${escape(ext)}$`);
}

async function prune(dir: string, name: string, keep: number) {
  if (keep <= 0) {
    return;
  }
  const pattern = backupPattern(name);
  const backups = (await fs.promises.readdir(dir)).filter(n => pattern.test(n)).sort();
  const excess = backups.slice(0, Math.max(0, backups.length - keep));
  await Promise.all(
    excess.map(n =>
      fs.promises
        .unlink(path.join(dir, n))
        .catch(error => logger.warn(`couldn't prune backup ${n}: ${error.message}`))
    )
  );
}

// Downloads the remote file into the backup folder before it gets overwritten.
// Resolves to the backup's path, or undefined when there was nothing to back up.
export async function backupRemoteFile(
  option: BackupOption,
  remoteFs: FileSystem,
  remotePath: string,
  remoteFsPath: string,
  now: Date = new Date()
): Promise<string | undefined> {
  let stat;
  try {
    stat = await remoteFs.lstat(remoteFsPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
  if (stat.type !== FileType.File) {
    return undefined;
  }

  const relative = upath.relative(remotePath, remoteFsPath);
  if (!relative || relative.startsWith('..') || upath.isAbsolute(relative)) {
    logger.warn(`not backing up ${remoteFsPath}: outside remotePath ${remotePath}`);
    return undefined;
  }

  const dir = path.join(option.root, upath.dirname(relative));
  const name = upath.basename(relative);
  const dest = path.join(dir, backupName(name, backupStamp(now)));
  const partial = dest + '.part';

  await fs.promises.mkdir(dir, { recursive: true });
  try {
    await pipeline(await remoteFs.get(remoteFsPath), fs.createWriteStream(partial));
    await fs.promises.rename(partial, dest);
  } catch (error) {
    await fs.promises.rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }

  await prune(dir, name, option.keep);
  logger.info(`backed up ${remoteFsPath} to ${dest}`);
  return dest;
}

// The TransferTask hook for uploads; undefined when backups are off.
export function createBackupHook(
  config: ServiceConfig,
  localBaseDir: string
): ((targetFsPath: string, targetFs: FileSystem) => Promise<void>) | undefined {
  const option = resolveBackup(config, localBaseDir);
  if (!option) {
    return undefined;
  }
  return async (targetFsPath, targetFs) => {
    await backupRemoteFile(option, targetFs, config.remotePath, targetFsPath);
  };
}
