import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { URI } from 'vscode-uri';
import { upath } from '../core';
import { pathRelativeToWorkspace, getWorkspaceFolders } from '../host';

// from https://github.com/microsoft/vscode-eslint/blob/d97a8b5e99ad30d2ce32ffa5646447202f873413/server/src/eslintServer.ts#L816
function getFileSystemPath(uri: URI | string): string {
	let result = typeof uri === 'string' ? uri : uri.fsPath;
	if (process.platform === 'win32' && result.length >= 2 && result[1] === ':') {
		// Node by default uses an upper case drive letter and ESLint uses
		// === to compare paths which results in the equal check failing
		// if the drive letter is lower case in th URI. Ensure upper case.
		result = result[0].toUpperCase() + result.substr(1);
	}
	if (process.platform === 'win32' || process.platform === 'darwin') {
		// The path may no longer exist on disk -- e.g. a delete-watcher event
		// fires after the file is already gone -- in which case there's no
		// real path to resolve casing against, so fall back to the input as-is.
		try {
			const realpath = fs.realpathSync.native(result);
			// Only use the real path if only the casing has changed.
			if (realpath.toLowerCase() === result.toLowerCase()) {
				result = realpath;
			}
		} catch {
			// ignore, use result unresolved
		}
	}
	return result;
}

export function simplifyPath(absolutePath: string) {
  return pathRelativeToWorkspace(absolutePath);
}

// FIXME: use fs.pathResolver instead of upath
export function toRemotePath(localPath: string, localContext: string, remoteContext: string) {
  return upath.join(remoteContext, path.relative(getFileSystemPath(localContext), getFileSystemPath(localPath)));
}

// FIXME: use fs.pathResolver instead of upath
export function toLocalPath(remotePath: string, remoteContext: string, localContext: string) {
  return path.join(localContext, upath.relative(remoteContext, remotePath));
}

// Separator-boundary-safe "is at or under" checks, used by the rename/move
// feature for both root-escape and self-nesting validation. A plain
// `pathname.indexOf(parent) === 0` check -- the obvious first way to write
// this -- false-positives on prefix siblings (e.g. `/src` reads as a parent
// of `/src-legacy`), because nothing requires a boundary character after the
// parent; these two require one.

// Remote paths are always POSIX, regardless of the platform SFTPresso runs
// on, so this normalizes with upath (which also resolves `.`/`..` segments)
// rather than the platform-specific `path` module.
export function isRemotePathAtOrUnder(parent: string, pathname: string): boolean {
  const normalizedParent = upath.normalize(parent).replace(/\/+$/, '') || '/';
  const normalizedPath = upath.normalize(pathname);

  if (normalizedPath === normalizedParent) {
    return true;
  }

  const prefix = normalizedParent === '/' ? '/' : normalizedParent + '/';
  return normalizedPath.startsWith(prefix);
}

function trimTrailingSep(pathname: string): string {
  let end = pathname.length;
  while (end > 1 && pathname[end - 1] === path.sep) {
    end -= 1;
  }
  return pathname.slice(0, end);
}

// Local-fsPath equivalent, using the platform path module/separator.
export function isLocalPathAtOrUnder(parent: string, pathname: string): boolean {
  const normalizedParent = trimTrailingSep(path.normalize(parent));
  const normalizedPath = path.normalize(pathname);

  if (normalizedPath === normalizedParent) {
    return true;
  }

  const prefix = normalizedParent === path.sep ? path.sep : normalizedParent + path.sep;
  return normalizedPath.startsWith(prefix);
}

export function replaceHomePath(pathname: string) {
  return pathname.substr(0, 2) === '~/' ? path.join(os.homedir(), pathname.slice(2)) : pathname;
}

export function resolvePath(from: string, to: string) {
  return path.resolve(from, replaceHomePath(to));
}

export function isInWorkspace(filepath: string) {
  const workspaceFolders = getWorkspaceFolders();
  return (
    workspaceFolders &&
    workspaceFolders.some(
      // vscode can't keep filepath's stable, covert them to toLowerCase before check
      folder => filepath.toLowerCase().indexOf(folder.uri.fsPath.toLowerCase()) === 0
    )
  );
}
