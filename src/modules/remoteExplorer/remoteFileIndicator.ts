import * as vscode from 'vscode';
import { COMMAND_REMOTEEXPLORER_REFRESH_ACTIVE_FILE, EXTENSION_NAME, REMOTE_SCHEME } from '../../constants';
import { STATUS_PRIORITY } from '../../ui/statusBarPriority';
import { upath } from '../../core';
import { getExtensionSetting } from '../ext';
import { configProfile, hostAddress } from './profileLabel';
import type { ExplorerRoot } from './treeDataProvider';

type FindRoot = (uri: vscode.Uri) => ExplorerRoot | null | undefined;

export interface RemoteFilePresentation {
  text: string;
  tooltip: string;
  background?: string;
  badge: string;
  // whether saving would actually reach the server, which is what earns the loud styling
  writable: boolean;
}

export const REMOTE_FILE_BADGE = '☁';

export function presentRemoteFile(
  uri: vscode.Uri,
  root: ExplorerRoot | null | undefined,
  activeProfile: string | null,
  readOnly: boolean
): RemoteFilePresentation {
  const name = upath.basename(uri.path);

  // same check RemoteFileSystemProvider makes before every read and save
  if (!root || root.resource.uri.authority !== uri.authority) {
    return {
      text: `$(debug-disconnect) Remote: ${uri.authority}`,
      tooltip:
        `${name} was opened from ${uri.authority}, which the config no longer points at.` +
        ' Saving is blocked. Reopen the file from the Remote Explorer.',
      background: 'statusBarItem.errorBackground',
      badge: REMOTE_FILE_BADGE,
      writable: false,
    };
  }

  const { fileService, config } = root.explorerContext;
  const profile = configProfile(activeProfile, fileService.getAvailableProfiles());
  const target = profile || fileService.name || hostAddress(config);
  const where = [
    hostAddress(config),
    fileService.name && `config "${fileService.name}"`,
    profile && `profile ${profile}`,
  ]
    .filter(Boolean)
    .join(', ');

  if (readOnly) {
    return {
      text: `$(lock) Remote (read-only): ${target}`,
      tooltip: `${name} is open read-only from the server (${where}). Click to reload it from the server.`,
      badge: REMOTE_FILE_BADGE,
      writable: false,
    };
  }

  return {
    text: `$(cloud) Remote: ${target}`,
    tooltip:
      `Editing ${name} directly on the server (${where}). Saving writes straight to the server.` +
      ' Click to reload it from the server.',
    background: 'statusBarItem.warningBackground',
    badge: REMOTE_FILE_BADGE,
    writable: true,
  };
}

function tabUri(tab: vscode.Tab | undefined): vscode.Uri | undefined {
  // text and custom (image preview) tabs carry a uri, diffs a pair; webviews carry none
  const input = tab && (tab.input as { uri?: unknown; original?: unknown; modified?: unknown });
  if (!input) {
    return undefined;
  }
  const uris = [input.uri, input.original, input.modified].filter(
    (uri): uri is vscode.Uri => uri instanceof vscode.Uri
  );
  return uris.find(uri => uri.scheme === REMOTE_SCHEME) || uris[0];
}

function isRemote(uri: vscode.Uri | undefined): uri is vscode.Uri {
  return !!uri && uri.scheme === REMOTE_SCHEME;
}

/**
 * Makes a file opened from the Remote Explorer unmistakable: a status bar item while it's the
 * active tab, and a coloured, badged tab title for every open remote file.
 */
export default class RemoteFileIndicator implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _statusBarItem: vscode.StatusBarItem;
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
  private readonly _disposables: vscode.Disposable[] = [];
  private _openUris = new Map<string, vscode.Uri>();
  private _activeProfile: string | null = null;

  constructor(private readonly _findRoot: FindRoot) {
    this._statusBarItem = vscode.window.createStatusBarItem(
      'sftpresso.remoteFile',
      vscode.StatusBarAlignment.Left,
      STATUS_PRIORITY.remoteFile
    );
    this._statusBarItem.name = 'SFTPresso Remote File';
    this._statusBarItem.command = COMMAND_REMOTEEXPLORER_REFRESH_ACTIVE_FILE;

    this._disposables.push(
      this._statusBarItem,
      this._onDidChangeFileDecorations,
      vscode.window.registerFileDecorationProvider(this),
      vscode.window.tabGroups.onDidChangeTabs(() => this.update()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.update()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(`${EXTENSION_NAME}.openRemoteFilesReadOnly`)) {
          this.refresh();
        }
      })
    );
    this.update();
  }

  // RemoteExplorer refreshes again once the roots are rebuilt for a profile switch; this one
  // covers startup, where tabs restored from the last session have no refresh coming.
  setActiveProfile(profile: string | null) {
    this._activeProfile = profile;
    this.refresh();
  }

  refresh() {
    this.update();
    this._onDidChangeFileDecorations.fire(Array.from(this._openUris.values()));
  }

  update() {
    this._updateOpenUris();

    const active = tabUri(vscode.window.tabGroups.activeTabGroup.activeTab);
    if (!isRemote(active)) {
      this._statusBarItem.hide();
      return;
    }

    const presentation = this._present(active);
    this._statusBarItem.text = presentation.text;
    this._statusBarItem.tooltip = presentation.tooltip;
    this._statusBarItem.backgroundColor = presentation.background
      ? new vscode.ThemeColor(presentation.background)
      : undefined;
    this._statusBarItem.accessibilityInformation = { label: presentation.tooltip, role: 'button' };
    this._statusBarItem.show();
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    // only open files: decorating every remote: uri would also badge each Remote Explorer row
    if (!this._openUris.has(uri.toString())) {
      return undefined;
    }

    const presentation = this._present(uri);
    return {
      badge: presentation.badge,
      tooltip: presentation.writable ? 'Remote file: saving writes to the server' : 'Remote file',
      color: new vscode.ThemeColor(
        presentation.writable ? 'sftp.remoteFileForeground' : 'disabledForeground'
      ),
    };
  }

  dispose() {
    this._disposables.forEach(disposable => disposable.dispose());
  }

  private _present(uri: vscode.Uri): RemoteFilePresentation {
    let root: ExplorerRoot | null | undefined;
    try {
      root = this._findRoot(uri);
    } catch {
      root = null;
    }
    return presentRemoteFile(uri, root, this._activeProfile, !!getExtensionSetting().openRemoteFilesReadOnly);
  }

  // Tabs opening and closing change which uris are decorated, so both sides get re-asked.
  private _updateOpenUris() {
    const next = new Map<string, vscode.Uri>();
    vscode.window.tabGroups.all.forEach(group =>
      group.tabs.forEach(tab => {
        const uri = tabUri(tab);
        if (isRemote(uri)) {
          next.set(uri.toString(), uri);
        }
      })
    );

    const changed = [
      ...Array.from(next.entries()).filter(([key]) => !this._openUris.has(key)),
      ...Array.from(this._openUris.entries()).filter(([key]) => !next.has(key)),
    ].map(([, uri]) => uri);

    this._openUris = next;
    if (changed.length > 0) {
      this._onDidChangeFileDecorations.fire(changed);
    }
  }
}
