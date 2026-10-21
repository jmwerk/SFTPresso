import * as vscode from 'vscode';
import { registerCommand, setContextValue } from '../../host';
import {
  COMMAND_REMOTEEXPLORER_REFRESH,
  COMMAND_REMOTEEXPLORER_REFRESH_ACTIVE_FILE,
  COMMAND_REMOTEEXPLORER_VIEW_CONTENT,
} from '../../constants';
import { UResource } from '../../core';
import { toRemotePath } from '../../helper';
import { REMOTE_SCHEME } from '../../constants';
import { getFileService } from '../serviceManager';
import RemoteTreeDataProvider, { ExplorerItem, ExplorerNode, isProfileRow } from './treeDataProvider';
import { RemoteExplorerDragAndDropController } from './dragAndDrop';
import RemoteFileSystemProvider from './remoteFileSystemProvider';
import logger from '../../logger';

export default class RemoteExplorer {
  private _explorerView: vscode.TreeView<ExplorerNode>;
  private _treeDataProvider: RemoteTreeDataProvider;

  constructor(context: vscode.ExtensionContext) {
    this._treeDataProvider = new RemoteTreeDataProvider();
    const fileSystem = new RemoteFileSystemProvider(uri => this._treeDataProvider.findRoot(uri));
    context.subscriptions.push(
      vscode.workspace.registerFileSystemProvider(REMOTE_SCHEME, fileSystem, { isCaseSensitive: true }),
      this._treeDataProvider.onDidChange(uri => fileSystem.notifyChanged(uri)),
      // a file saved, created or removed through an editor shows up in the tree without a refresh
      fileSystem.onDidChangeFile(events =>
        events
          .filter(event => event.type !== vscode.FileChangeType.Changed)
          .forEach(event =>
            this._treeDataProvider
              .refresh({ resource: UResource.makeResource(event.uri), isDirectory: false })
              .catch(error => logger.warn(`Remote Explorer refresh failed: ${error.message}`))
          )
      )
    );

    this._explorerView = vscode.window.createTreeView('remoteExplorer', {
      showCollapseAll: true,
      treeDataProvider: this._treeDataProvider,
      canSelectMany: true,
      dragAndDropController: new RemoteExplorerDragAndDropController(
        uri => this._treeDataProvider.findRoot(uri),
        item => this._treeDataProvider.refresh(item)
      ),
    });

    registerCommand(context, COMMAND_REMOTEEXPLORER_REFRESH, () => this._refreshSelection());
    registerCommand(context, COMMAND_REMOTEEXPLORER_REFRESH_ACTIVE_FILE, () => this._refreshActiveRemoteFile());
    registerCommand(context, COMMAND_REMOTEEXPLORER_VIEW_CONTENT, (item: ExplorerItem) =>
      this._treeDataProvider.showItem(item)
    );
  }

  refresh(item?: ExplorerItem) {
    if (item && !UResource.isRemote(item.resource.uri)) {
      const uri = item.resource.uri;
      const fileService = getFileService(uri);
      if (!fileService) {
        if (uri.toString(true) === "file:///${command:sftp.sync.remoteToLocal}") {
          throw '';
        } else {
          throw new Error(`Config Not Found. (${uri.toString(true)})`);
        }
      }
      const config = fileService.getConfig();
      const localPath = item.resource.fsPath;
      const remotePath = toRemotePath(localPath, config.context, config.remotePath);
      item.resource = UResource.makeResource({
        remote: {
          host: config.host,
          port: config.port,
        },
        fsPath: remotePath,
        remoteId: fileService.id,
      });
    }

    this._treeDataProvider.refresh(item);
  }

  // Takes effect on the next refresh, which the caller triggers on every profile change.
  setProfiles(activeProfile: string | null, availableProfiles: string[]) {
    this._treeDataProvider.setActiveProfile(activeProfile, availableProfiles);
  }

  reveal(item: ExplorerItem): Thenable<void> {
    return item ? this._explorerView.reveal(item) : Promise.resolve();
  }

  findRoot(remoteUri: vscode.Uri) {
    return this._treeDataProvider.findRoot(remoteUri);
  }

  getFilter(): string | null {
    return this._treeDataProvider.getFilter();
  }

  setFilter(filter: string | null | undefined): void {
    const changed = this._treeDataProvider.setFilter(filter);
    if (!changed) {
      return;
    }

    const active = this._treeDataProvider.getFilter();
    this._explorerView.description = active ? `Filter: "${active}"` : undefined;
    setContextValue('remoteExplorer.filterActive', Boolean(active));
    this._treeDataProvider.refresh();
  }

  clearFilter(): void {
    this.setFilter(null);
  }

  private _refreshSelection() {
    if (this._explorerView.selection.length) {
      this._explorerView.selection.forEach(item => {
        if (!isProfileRow(item)) {
          this.refresh(item);
        }
      });
    } else {
      this.refresh();
    }
  }

  private _refreshActiveRemoteFile() {
    const focusedEditor = vscode.window.activeTextEditor;
    if (focusedEditor) {

      const remoteFileUri = focusedEditor.document.uri;
      const root = this._treeDataProvider.findRoot(remoteFileUri);
      const incompleteResource = UResource.makeResource(remoteFileUri);

      if (!root) {
        return;
      }
      const remoteFileItem = {
        resource: UResource.updateResource(root.resource, {
          remotePath: incompleteResource.fsPath
        }),
        isDirectory: false
      };

      this.refresh(remoteFileItem);
    }
    
  }
}
