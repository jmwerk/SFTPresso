import * as vscode from 'vscode';
import { showTextDocument } from '../../host';
import {
  upath,
  UResource,
  Resource,
  FileService,
  FileType,
  FileEntry,
  Ignore,
  ServiceConfig,
} from '../../core';
import {
  COMMAND_REMOTEEXPLORER_VIEW_CONTENT,
  COMMAND_REMOTEEXPLORER_EDITINLOCAL,
} from '../../constants';
import { getAllFileService } from '../serviceManager';
import { getExtensionSetting } from '../ext';

type Id = number;

const previewDocumentPathPrefix = '/~ ';

const DEFAULT_FILES_EXCLUDE = ['.git', '.svn', '.hg', 'CVS', '.DS_Store'];
/**
 * covert the url path for a customed docuemnt title
 *
 *  There is no api to custom title.
 *  So we change url path for custom title.
 *  This is not break anything because we get fspth from uri.query.'
 */
function makePreivewUrl(uri: vscode.Uri) {
  // const query = querystring.parse(uri.query);
  // query.originPath = uri.path;
  // query.originQuery = uri.query;

  return uri.with({
    path: previewDocumentPathPrefix + upath.basename(uri.path),
    // query: querystring.stringify(query),
  });
}

interface ExplorerChild {
  resource: Resource;
  isDirectory: boolean;
}

export interface ExplorerRoot extends ExplorerChild {
  explorerContext: {
    fileService: FileService;
    config: ServiceConfig;
    id: Id;
  };
}

export type ExplorerItem = ExplorerRoot | ExplorerChild;

function dirFirstSort(fileA: ExplorerItem, fileB: ExplorerItem) {
  if (fileA.isDirectory === fileB.isDirectory) {
    return fileA.resource.fsPath.localeCompare(fileB.resource.fsPath);
  }

  return fileA.isDirectory ? -1 : 1;
}

export default class RemoteTreeData
  implements vscode.TreeDataProvider<ExplorerItem>, vscode.TextDocumentContentProvider {
  private _roots: ExplorerRoot[] | null;
  private _rootsMap: Map<Id, ExplorerRoot> | null;
  private _map: Map<vscode.Uri['query'], ExplorerItem>;
  private _filter: string | null = null;
  private _filterEpoch = 0;
  // Directory listings fetched while walking descendants for a match, keyed by
  // fsPath. Only alive during an active filter session -- normal (unfiltered)
  // browsing always re-lists, unchanged from before filtering existed.
  private _searchCache: Map<string, Promise<FileEntry[]>> | null = null;

  private _onDidChangeFolder: vscode.EventEmitter<
    ExplorerItem | undefined | null | void
  > = new vscode.EventEmitter<ExplorerItem | undefined | null | void>();
  private _onDidChangeFile: vscode.EventEmitter<vscode.Uri> = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeTreeData: vscode.Event<
    ExplorerItem | undefined | null | void
  > = this._onDidChangeFolder.event;
  readonly onDidChange: vscode.Event<vscode.Uri> = this._onDidChangeFile.event;

  async refresh(item?: ExplorerItem): Promise<any> {
    // any explicit refresh means "get me fresh data" -- drop whatever the
    // filter search walked past, so it doesn't paper over changes on the server
    this._searchCache = null;

    // refresh root
    if (!item) {
      // clear cache
      this._roots = null;
      this._rootsMap = null;

      this._onDidChangeFolder.fire();
      return;
    }

    if (item.isDirectory) {
      this._onDidChangeFolder.fire(item);

      // refresh top level files as well
      const children = await this.getChildren(item);
      children
        .filter(i => !i.isDirectory)
        .forEach(i => this._onDidChangeFile.fire(makePreivewUrl(i.resource.uri)));
    } else {
      const parent = await this.getParent(item);
      if (parent) {
        this._onDidChangeFolder.fire(parent);
      }
      this._onDidChangeFile.fire(makePreivewUrl(item.resource.uri));
    }
  }

  getTreeItem(item: ExplorerItem): vscode.TreeItem {
    const isRoot = (item as ExplorerRoot).explorerContext !== undefined;
    let customLabel;
    if (isRoot) {
      customLabel = (item as ExplorerRoot).explorerContext.fileService.name;
    }
    if (!customLabel) {
      customLabel = upath.basename(item.resource.fsPath);
    }
    return {
      label: customLabel,
      resourceUri: item.resource.uri,
      collapsibleState: item.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : undefined,
      contextValue: isRoot ? 'root' : item.isDirectory ? 'folder' : 'file',
      command: item.isDirectory
        ? undefined
        : {
            command: getExtensionSetting().downloadWhenOpenInRemoteExplorer
              ? COMMAND_REMOTEEXPLORER_EDITINLOCAL
              : COMMAND_REMOTEEXPLORER_VIEW_CONTENT,
            arguments: [item],
            title: 'View Remote Resource',
          },
    };
  }

  /**
   * Set the active substring filter (case-insensitive). Pass `null`/empty to clear it.
   * Returns whether the effective filter actually changed.
   */
  setFilter(filter: string | null | undefined): boolean {
    const trimmed = filter && filter.trim() ? filter.trim() : null;
    if (trimmed === this._filter) {
      return false;
    }
    const wasActive = this._filter !== null;
    this._filter = trimmed;
    this._filterEpoch += 1;
    if (trimmed === null && wasActive) {
      // search session ended -- back to always-fresh unfiltered browsing
      this._searchCache = null;
    }
    return true;
  }

  getFilter(): string | null {
    return this._filter;
  }

  async getChildren(item?: ExplorerItem): Promise<ExplorerItem[]> {
    if (!item) {
      return this._getRoots();
    }

    const root = this.findRoot(item.resource.uri);
    if (!root) {
      throw new Error(`Can't find config for remote resource ${item.resource.uri}.`);
    }

    const fileEntries = await this._listEntries(root, item.resource.fsPath);

    const epoch = this._filterEpoch;
    const filterAtStart = this._filter;
    const matchedEntries = filterAtStart
      ? await this._filterEntriesByQuery(root, fileEntries, filterAtStart.toLowerCase())
      : fileEntries;

    // The filter search above can be slow (recursive, network-bound). If the
    // filter changed while it was in flight, don't hand back results for a
    // query that's no longer current -- retry against whatever's current now.
    // The search cache makes the retry cheap rather than a second full walk.
    if (epoch !== this._filterEpoch) {
      return this.getChildren(item);
    }

    return matchedEntries.map(file => this._toItem(item, file)).sort(dirFirstSort);
  }

  private _toItem(parent: ExplorerItem, file: FileEntry): ExplorerItem {
    const isDirectory = file.type === FileType.Directory;
    const newResource = UResource.updateResource(parent.resource, {
      remotePath: file.fspath,
    });
    const mapItem = this._map.get(newResource.uri.query);
    if (mapItem) {
      return mapItem;
    }

    const newItem = { resource: newResource, isDirectory };
    this._map.set(newItem.resource.uri.query, newItem);
    return newItem;
  }

  private async _listEntries(root: ExplorerRoot, fsPath: string): Promise<FileEntry[]> {
    const config = root.explorerContext.config;
    const remotefs = await root.explorerContext.fileService.getRemoteFileSystem(config);
    const fileEntries = await remotefs.list(fsPath);

    const filesExcludeList: string[] =
      config.remoteExplorer && config.remoteExplorer.filesExclude
        ? config.remoteExplorer.filesExclude.concat(DEFAULT_FILES_EXCLUDE)
        : DEFAULT_FILES_EXCLUDE;

    const ignore = new Ignore(filesExcludeList);
    return fileEntries.filter(file => {
      const relativePath = upath.relative(config.remotePath, file.fspath);
      return !ignore.ignores(relativePath);
    });
  }

  // Keeps a directory if it, or any of its descendants, matches the query --
  // otherwise a match three levels down would be unreachable once its
  // non-matching ancestors got filtered out of the listing above them.
  // Siblings are checked concurrently (real speedup over SFTP, which
  // pipelines; a no-op over FTP, which already serializes everything through
  // one connection queue) and listings are cached for the rest of this
  // filter session so re-typing over an unchanged prefix doesn't re-walk it.
  private async _filterEntriesByQuery(
    root: ExplorerRoot,
    fileEntries: FileEntry[],
    query: string
  ): Promise<FileEntry[]> {
    const matches = await Promise.all(
      fileEntries.map(file => this._matchesQuery(root, file, query))
    );
    return fileEntries.filter((_file, index) => matches[index]);
  }

  private async _matchesQuery(root: ExplorerRoot, file: FileEntry, query: string): Promise<boolean> {
    const basename = upath.basename(file.fspath).toLowerCase();
    if (basename.includes(query)) {
      return true;
    }
    if (file.type !== FileType.Directory) {
      return false;
    }
    return this._hasMatchingDescendant(root, file.fspath, query);
  }

  private async _hasMatchingDescendant(
    root: ExplorerRoot,
    fsPath: string,
    query: string
  ): Promise<boolean> {
    const children = await this._listEntriesForSearch(root, fsPath);
    const matches = await Promise.all(
      children.map(file => this._matchesQuery(root, file, query))
    );
    return matches.some(Boolean);
  }

  // Same listing as _listEntries, but memoized (by promise, so concurrent
  // lookups of the same path also collapse into one request) for the
  // duration of the current filter session.
  private _listEntriesForSearch(root: ExplorerRoot, fsPath: string): Promise<FileEntry[]> {
    if (!this._searchCache) {
      this._searchCache = new Map();
    }
    let cached = this._searchCache.get(fsPath);
    if (!cached) {
      cached = this._listEntries(root, fsPath);
      this._searchCache.set(fsPath, cached);
    }
    return cached;
  }

  async getParent(item: ExplorerChild): Promise<ExplorerItem> {
    const resourceUri = item.resource.uri;
    const root = this.findRoot(resourceUri);
    if (!root) {
      throw new Error(`Can't find config for remote resource ${resourceUri}.`);
    }

    if (item.resource.fsPath === root.resource.fsPath) {
      return root;
    }

    const fspath = upath.dirname(item.resource.fsPath);
    const newResource = UResource.updateResource(item.resource, {
      remotePath: fspath,
    });
    const mapItem = this._map.get(newResource.uri.query);
    if (mapItem) {
      return mapItem;
    } else {
      const newMapItem = {
        resource: newResource,
        isDirectory: true,
      };
      this._map.set(newResource.uri.query, newMapItem);
      await this.getChildren(newMapItem);
      return newMapItem;
    }
  }

  findRoot(uri: vscode.Uri): ExplorerRoot | null | undefined {
    if (!this._rootsMap) {
      return null;
    }

    const rootId = UResource.makeResource(uri).remoteId;
    return this._rootsMap.get(rootId);
  }

  async provideTextDocumentContent(
    uri: vscode.Uri,
    token: vscode.CancellationToken
  ): Promise<string> {
    const root = this.findRoot(uri);
    if (!root) {
      throw new Error(`Can't find remote for resource ${uri}.`);
    }

    const config = root.explorerContext.config;
    const remotefs = await root.explorerContext.fileService.getRemoteFileSystem(config);
    const buffer = await remotefs.readFile(UResource.makeResource(uri).fsPath);
    return buffer.toString();
  }

  showItem(item: ExplorerItem): void {
    if (item.isDirectory) {
      return;
    }

    showTextDocument(makePreivewUrl(item.resource.uri));
  }

  private _getRoots(): ExplorerRoot[] {
    if (this._roots) {
      return this._roots;
    }

    this._roots = [];
    this._rootsMap = new Map();
    this._map = new Map();
    getAllFileService().forEach(fileService => {
      const config = fileService.getConfig();
      const id = fileService.id;
      const item = {
        resource: UResource.makeResource({
          remote: {
            host: config.host,
            port: config.port,
          },
          fsPath: config.remotePath,
          remoteId: id,
        }),
        isDirectory: true,
        explorerContext: {
          fileService,
          config,
          id,
        },
      };
      this._roots!.push(item);
      this._rootsMap!.set(id, item);
      this._map.set(item.resource.uri.query, item);
    });
    this._roots.sort((a,b) => a.explorerContext.config.remoteExplorer.order - b.explorerContext.config.remoteExplorer.order || a.explorerContext.fileService.name.localeCompare(b.explorerContext.fileService.name));
    return this._roots;
  }
}
