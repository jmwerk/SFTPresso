import * as querystring from 'querystring';
import { Readable } from 'stream';
import * as vscode from 'vscode';
import { FileStats, FileSystem, FileType, ServiceConfig } from '../../core';
import logger from '../../logger';
import { getExtensionSetting } from '../ext';
import type { ExplorerRoot } from './treeDataProvider';

type FindRoot = (uri: vscode.Uri) => ExplorerRoot | null | undefined;

interface Target {
  remoteFs: FileSystem;
  config: ServiceConfig;
  path: string;
}

// ENOENT from tests and local paths, status 2 (NO_SUCH_FILE) from ssh2, and basic-ftp's
// 550 reply or ftpFileSystem.lstat's own message for a missing entry
function isNotFound(error: any): boolean {
  if (!error) {
    return false;
  }
  const message = String(error.message || '').toLowerCase();
  return (
    error.code === 'ENOENT' ||
    error.code === 2 ||
    message === 'file not exist' ||
    (error.code === 550 && /no such file|not found|not exist/.test(message))
  );
}

// status 3 (PERMISSION_DENIED) from ssh2
function isPermissionDenied(error: any): boolean {
  return !!error && (error.code === 'EACCES' || error.code === 3);
}

function toFileSystemError(error: any, uri: vscode.Uri): Error {
  if (error instanceof vscode.FileSystemError) {
    return error;
  }
  if (isNotFound(error)) {
    return vscode.FileSystemError.FileNotFound(uri);
  }
  if (isPermissionDenied(error)) {
    return vscode.FileSystemError.NoPermissions(uri);
  }
  return error;
}

function toVscodeFileType(type: FileType): vscode.FileType {
  switch (type) {
    case FileType.Directory:
      return vscode.FileType.Directory;
    case FileType.File:
      return vscode.FileType.File;
    case FileType.SymbolicLink:
      return vscode.FileType.SymbolicLink;
    default:
      return vscode.FileType.Unknown;
  }
}

// VS Code derives child URIs with Uri.joinPath, which keeps the parent's query, so the query's
// fsPath is only trusted while it still names the same path as the uri itself.
export function remotePathOf(uri: vscode.Uri): string {
  const { fsPath } = querystring.parse(uri.query);
  if (typeof fsPath === 'string' && '/' + fsPath.replace(/^\/+/, '') === uri.path) {
    return fsPath;
  }
  return uri.path;
}

function isReadOnly(): boolean {
  return !!getExtensionSetting().openRemoteFilesReadOnly;
}

/**
 * Serves `remote:` URIs straight from the server, so a file opened from the Remote Explorer
 * can be edited and saved in place. VS Code compares the mtime/size from stat() against what
 * it loaded and asks before overwriting a file someone else changed in the meantime.
 */
export default class RemoteFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._onDidChangeFile.event;

  constructor(private readonly _findRoot: FindRoot) {}

  // Remote servers can't push changes; open editors reload when the Remote Explorer refreshes.
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  notifyChanged(uri: vscode.Uri) {
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this._run(uri, async ({ remoteFs, path }) => {
      const stat = await remoteFs.lstat(path);
      const isLink = stat.type === FileType.SymbolicLink;
      const resolved = isLink ? await this._followLink(remoteFs, path) : null;
      const target = resolved || stat;
      return {
        // a link whose target can't be told apart is opened as a file, the common case
        type: isLink
          ? vscode.FileType.SymbolicLink | (resolved ? toVscodeFileType(resolved.type) : vscode.FileType.File)
          : toVscodeFileType(stat.type),
        ctime: target.mtime,
        mtime: target.mtime,
        size: target.size,
        permissions: isReadOnly() ? vscode.FilePermission.Readonly : undefined,
      };
    });
  }

  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this._run(uri, async ({ remoteFs, path }) => {
      const entries = await remoteFs.list(path);
      return entries.map(entry => [entry.name, toVscodeFileType(entry.type)] as [string, vscode.FileType]);
    });
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this._run(uri, async ({ remoteFs, path }) => {
      const data = await remoteFs.readFile(path);
      return typeof data === 'string' ? Buffer.from(data) : data;
    });
  }

  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    return this._runWrite(uri, async ({ remoteFs, config, path }) => {
      const existing = await this._lstatOrNull(remoteFs, path);
      if (existing && existing.type === FileType.Directory) {
        throw vscode.FileSystemError.FileIsADirectory(uri);
      }
      if (!existing && !options.create) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      if (existing && !options.overwrite) {
        throw vscode.FileSystemError.FileExists(uri);
      }

      const mode = config.filePerm
        ? parseInt(String(config.filePerm), 8)
        : existing
        ? existing.mode & 0o7777
        : undefined;
      const body = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
      const input = () => Readable.from(body.length > 0 ? [body] : []);

      // a temp file renamed over a symlink would replace the link, so write through it instead
      if (config.useTempFile && !(existing && existing.type === FileType.SymbolicLink)) {
        const tempPath = path + '.new';
        await remoteFs.put(input(), tempPath, { mode });
        if (config.openSsh) {
          await remoteFs.renameAtomic(tempPath, path);
        } else {
          if (existing) {
            await remoteFs.unlink(path);
          }
          await remoteFs.rename(tempPath, path);
        }
      } else {
        await remoteFs.put(input(), path, { mode });
      }

      logger.info(`saved ${path} on the server`);
      this._onDidChangeFile.fire([
        { type: existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri },
      ]);
    });
  }

  createDirectory(uri: vscode.Uri): Promise<void> {
    return this._runWrite(uri, async ({ remoteFs, path }) => {
      await remoteFs.mkdir(path);
      this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Created, uri }]);
    });
  }

  delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    return this._runWrite(uri, async ({ remoteFs, path }) => {
      const stat = await remoteFs.lstat(path);
      if (stat.type === FileType.Directory) {
        await remoteFs.rmdir(path, options.recursive);
      } else {
        await remoteFs.unlink(path);
      }
      this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    });
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    return this._runWrite(oldUri, async ({ remoteFs, path }) => {
      const newPath = this._resolve(newUri).path;
      const existing = await this._lstatOrNull(remoteFs, newPath);
      if (existing) {
        // never remove a whole directory as a side effect of a rename
        if (!options.overwrite || existing.type === FileType.Directory) {
          throw vscode.FileSystemError.FileExists(newUri);
        }
        await remoteFs.unlink(newPath);
      }
      await remoteFs.rename(path, newPath);
      this._onDidChangeFile.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri },
      ]);
    });
  }

  private _resolve(uri: vscode.Uri): { root: ExplorerRoot; path: string } {
    let root: ExplorerRoot | null | undefined;
    try {
      root = this._findRoot(uri);
    } catch {
      root = null;
    }
    if (!root) {
      throw vscode.FileSystemError.Unavailable(
        `No SFTP config matches ${uri.toString(true)}. Reopen the file from the Remote Explorer.`
      );
    }

    // The authority is host:port at the time the file was opened. A profile switch can point
    // the same config at another server, and this file must never be read from or saved there.
    const current = root.resource.uri.authority;
    if (uri.authority !== current) {
      throw vscode.FileSystemError.Unavailable(
        `This file was opened from ${uri.authority}, but "${root.explorerContext.fileService.name}"` +
          ` now connects to ${current}. Reopen it from the Remote Explorer.`
      );
    }

    return { root, path: remotePathOf(uri) };
  }

  private async _run<T>(uri: vscode.Uri, op: (target: Target) => Promise<T>): Promise<T> {
    try {
      const { root, path } = this._resolve(uri);
      const { fileService, config } = root.explorerContext;
      const remoteFs = await fileService.getRemoteFileSystem(config);
      return await op({ remoteFs, config, path });
    } catch (error) {
      throw toFileSystemError(error, uri);
    }
  }

  private _runWrite<T>(uri: vscode.Uri, op: (target: Target) => Promise<T>): Promise<T> {
    if (isReadOnly()) {
      return Promise.reject(
        vscode.FileSystemError.NoPermissions(
          'Remote files are read-only (sftp.openRemoteFilesReadOnly). Use "Edit in Local" instead.'
        )
      );
    }
    return this._run(uri, op);
  }

  private async _lstatOrNull(remoteFs: FileSystem, path: string): Promise<FileStats | null> {
    try {
      return await remoteFs.lstat(path);
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  // FileSystem has no stat(), but a handle opened through the link stats its target. Opening a
  // directory fails, so a link that can't be opened is taken to point at one.
  private async _followLink(remoteFs: FileSystem, path: string): Promise<FileStats | null> {
    let fd;
    try {
      fd = await remoteFs.open(path, 'r');
    } catch {
      return { type: FileType.Directory, mode: 0, size: 0, mtime: 0, atime: 0 };
    }
    try {
      const stat = await remoteFs.fstat(fd);
      return stat.type === FileType.SymbolicLink ? null : stat;
    } catch {
      return null;
    } finally {
      await remoteFs.close(fd).catch(() => undefined);
    }
  }
}
