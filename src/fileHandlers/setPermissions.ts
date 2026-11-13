import { FileType, upath } from '../core';
import logger from '../logger';
import createFileHandler from './createFileHandler';

export interface SetPermissionsOption {
  mode: number;
  // Set to also walk a folder's contents: folders get `mode`, files get `fileMode`.
  fileMode?: number;
  // Structurally a vscode.CancellationToken, so the command can pass withProgress's.
  token?: { readonly isCancellationRequested: boolean };
  onProgress?: (changed: number, fsPath: string) => void;
}

export interface SetPermissionsResult {
  changed: number;
  failed: Array<{ fsPath: string; error: Error }>;
  cancelled: boolean;
}

export function parseMode(value: string): number | undefined {
  const trimmed = value.trim();
  return /^[0-7]{3,4}$/.test(trimmed) ? parseInt(trimmed, 8) : undefined;
}

export function formatMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, '0');
}

export const setRemotePermissions = createFileHandler<SetPermissionsOption & { result?: SetPermissionsResult }>({
  name: 'setRemotePermissions',
  async handle({ mode, fileMode, token, onProgress, result }) {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const outcome: SetPermissionsResult = result || { changed: 0, failed: [], cancelled: false };

    const apply = async (fsPath: string, value: number) => {
      try {
        await remoteFs.chmod(fsPath, value);
        outcome.changed += 1;
        if (onProgress) {
          onProgress(outcome.changed, fsPath);
        }
      } catch (error) {
        logger.warn(`chmod ${formatMode(value)} ${fsPath} failed: ${error.message}`);
        outcome.failed.push({ fsPath, error });
      }
    };

    // Children before their folder, so a stricter folder mode can't lock us out mid-walk.
    // Symlinks are skipped: chmod follows them, possibly outside remotePath.
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await remoteFs.list(dir);
      } catch (error) {
        logger.warn(`list ${dir} failed: ${error.message}`);
        outcome.failed.push({ fsPath: dir, error });
        return;
      }

      for (const entry of entries) {
        if (token && token.isCancellationRequested) {
          outcome.cancelled = true;
          return;
        }
        const fsPath = upath.join(dir, entry.name);
        if (entry.type === FileType.Directory) {
          await walk(fsPath);
          await apply(fsPath, mode);
        } else if (entry.type === FileType.File) {
          await apply(fsPath, fileMode!);
        }
      }
    };

    const { remoteFsPath } = this.target;
    const stat = await remoteFs.lstat(remoteFsPath);
    if (stat.type === FileType.SymbolicLink) {
      throw new Error(`'${remoteFsPath}' is a symbolic link; set permissions on its target instead.`);
    }

    if (stat.type === FileType.Directory && fileMode !== undefined) {
      await walk(remoteFsPath);
      if (outcome.cancelled) {
        return;
      }
    }
    await apply(remoteFsPath, mode);
  },
});
