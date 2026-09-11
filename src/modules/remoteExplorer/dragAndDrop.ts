import * as path from 'path';
import { fileURLToPath } from 'url';
import * as vscode from 'vscode';
import { upath, Resource, UResource } from '../../core';
import { isRemotePathAtOrUnder, reportError } from '../../helper';
import { showWarningMessage } from '../../host';
import { handleCtxFromUri, renameRemote, upload } from '../../fileHandlers';
import { ExplorerItem, ExplorerRoot } from './treeDataProvider';

// Must be application/vnd.code.tree.<view id, lowercased> for VS Code to
// treat it as this view's own drag data.
export const REMOTE_EXPLORER_MIME_TYPE = 'application/vnd.code.tree.remoteexplorer';

// What the OS (Finder, Explorer, most Linux file managers) puts on the
// clipboard/drag payload when dragging real files in -- see RFC 2483.
export const EXTERNAL_FILE_MIME_TYPE = 'text/uri-list';

export interface PlannedMove {
  item: ExplorerItem;
  newRemotePath: string;
}

export interface SkippedMove {
  item: ExplorerItem;
  reason: string;
}

export interface DropPlan {
  moves: PlannedMove[];
  skipped: SkippedMove[];
}

function isRoot(item: ExplorerItem): item is ExplorerRoot {
  return (item as ExplorerRoot).explorerContext !== undefined;
}

/**
 * Works out what a drop of `sources` onto `target` should do. Pure function
 * of the tree state -- no network or vscode API calls -- so it can be
 * exercised directly in tests.
 */
export function planDrop(
  sources: readonly ExplorerItem[],
  target: ExplorerItem | undefined,
  findRoot: (uri: Resource['uri']) => ExplorerRoot | null | undefined
): DropPlan | null {
  if (!target || !target.isDirectory) {
    return null;
  }

  const destRoot = findRoot(target.resource.uri);
  if (!destRoot || !destRoot.explorerContext.config.remoteExplorer.enableDragAndDrop) {
    return null;
  }

  const destDirPath = target.resource.fsPath;
  const moves: PlannedMove[] = [];
  const skipped: SkippedMove[] = [];

  // A folder's rename carries everything under it along in one call -- an
  // item that is itself a descendant of another selected item is already
  // moving as part of that ancestor's rename and must not also be planned as
  // its own move. Besides being redundant, moving the ancestor first would
  // invalidate the descendant's own (pre-move) source path before its turn
  // came up in a sequential execution, surfacing as a spurious per-item error.
  const selectedPaths = sources.filter(item => !isRoot(item)).map(item => item.resource.fsPath);
  const movesWithAnotherSelectedAncestor = (srcPath: string) =>
    selectedPaths.some(
      other => other !== srcPath && isRemotePathAtOrUnder(other, srcPath)
    );

  sources.forEach(item => {
    if (isRoot(item)) {
      skipped.push({ item, reason: "a connection root can't be moved" });
      return;
    }

    if (movesWithAnotherSelectedAncestor(item.resource.fsPath)) {
      // moving along with its selected ancestor -- not worth reporting
      return;
    }

    const srcRoot = findRoot(item.resource.uri);
    if (!srcRoot) {
      skipped.push({ item, reason: "can't find its configuration" });
      return;
    }
    if (srcRoot.explorerContext.id !== destRoot.explorerContext.id) {
      skipped.push({ item, reason: "can't move to a different configuration" });
      return;
    }

    const srcPath = item.resource.fsPath;
    if (srcPath === destDirPath || isRemotePathAtOrUnder(srcPath, destDirPath)) {
      skipped.push({ item, reason: "can't move into itself" });
      return;
    }
    if (upath.dirname(srcPath) === destDirPath) {
      // Already directly inside the target directory -- a harmless no-op,
      // not worth reporting as skipped.
      return;
    }

    moves.push({ item, newRemotePath: upath.join(destDirPath, upath.basename(srcPath)) });
  });

  return { moves, skipped };
}

function describe(item: ExplorerItem): string {
  return upath.basename(item.resource.fsPath);
}

// `file:` URIs only -- a drop can also carry `http:`/other schemes (e.g.
// dragging a link), which there's nothing local to upload for.
function toLocalPath(uri: string): string | null {
  if (!/^file:/i.test(uri)) {
    return null;
  }
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

export interface ExternalDropPlan {
  destDirPath: string;
  localPaths: string[];
}

/**
 * Works out what a drop of external files (dragged in from Finder/Explorer/
 * whatever the OS calls it) onto `target` should upload. Pure function of its
 * arguments -- no vscode or network calls -- so it can be tested directly.
 */
export function planExternalDrop(
  target: ExplorerItem | undefined,
  rawUriList: string,
  findRoot: (uri: Resource['uri']) => ExplorerRoot | null | undefined
): ExternalDropPlan | null {
  if (!target || !target.isDirectory) {
    return null;
  }

  const destRoot = findRoot(target.resource.uri);
  if (!destRoot || !destRoot.explorerContext.config.remoteExplorer.enableDragAndDrop) {
    return null;
  }

  const localPaths = rawUriList
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(toLocalPath)
    .filter((p): p is string => !!p);

  if (!localPaths.length) {
    return null;
  }

  return { destDirPath: target.resource.fsPath, localPaths };
}

export class RemoteExplorerDragAndDropController implements vscode.TreeDragAndDropController<ExplorerItem> {
  readonly dragMimeTypes = [REMOTE_EXPLORER_MIME_TYPE];
  readonly dropMimeTypes = [REMOTE_EXPLORER_MIME_TYPE, EXTERNAL_FILE_MIME_TYPE];

  constructor(
    private readonly _findRoot: (uri: Resource['uri']) => ExplorerRoot | null | undefined,
    private readonly _refresh: (item: ExplorerItem) => void
  ) {}

  handleDrag(source: readonly ExplorerItem[], dataTransfer: vscode.DataTransfer): void {
    const draggable = source.filter(item => {
      if (isRoot(item)) {
        return false;
      }
      const root = this._findRoot(item.resource.uri);
      return !!root && !!root.explorerContext.config.remoteExplorer.enableDragAndDrop;
    });

    if (!draggable.length) {
      return;
    }

    dataTransfer.set(REMOTE_EXPLORER_MIME_TYPE, new vscode.DataTransferItem(draggable));
  }

  async handleDrop(target: ExplorerItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    // A drag out of this same view carries both mime types on some platforms
    // (VS Code adds text/uri-list itself for tree items with a resourceUri),
    // so the internal move must win over treating it as an upload.
    const internalItem = dataTransfer.get(REMOTE_EXPLORER_MIME_TYPE);
    if (internalItem) {
      await this._handleInternalDrop(target, internalItem);
      return;
    }

    const externalItem = dataTransfer.get(EXTERNAL_FILE_MIME_TYPE);
    if (externalItem) {
      await this._handleExternalDrop(target, externalItem);
    }
  }

  private async _handleInternalDrop(
    target: ExplorerItem | undefined,
    transferItem: vscode.DataTransferItem
  ): Promise<void> {
    const sources: ExplorerItem[] = transferItem.value;
    if (!sources || !sources.length) {
      return;
    }

    const plan = planDrop(sources, target, this._findRoot);
    if (!plan) {
      return;
    }

    if (plan.skipped.length) {
      showWarningMessage(
        `Can't move ${plan.skipped.map(s => `'${describe(s.item)}' (${s.reason})`).join(', ')}.`
      );
    }

    if (!plan.moves.length) {
      return;
    }

    if (plan.moves.length > 1) {
      const choice = await vscode.window.showWarningMessage(
        `Move ${plan.moves.length} items to '${describe(target!)}'?`,
        { modal: true },
        'Move'
      );
      if (choice !== 'Move') {
        return;
      }
    }

    // Every remaining planned move is independent of every other -- a
    // selected item nested under another selected item was already filtered
    // out of `plan.moves` above -- so these can safely run concurrently
    // rather than paying for N sequential round trips.
    await Promise.all(
      plan.moves.map(async ({ item, newRemotePath }) => {
        try {
          await renameRemote(handleCtxFromUri(item.resource.uri), { newRemotePath });
        } catch (err) {
          reportError(err instanceof Error ? err : new Error(String(err)), `when moving '${describe(item)}'`);
        }
      })
    );

    this._refresh(target!);
  }

  private async _handleExternalDrop(
    target: ExplorerItem | undefined,
    transferItem: vscode.DataTransferItem
  ): Promise<void> {
    const raw = await transferItem.asString();
    const plan = planExternalDrop(target, raw, this._findRoot);
    if (!plan) {
      return;
    }

    // planExternalDrop already confirmed target/findRoot agree, so this is safe.
    const destRoot = this._findRoot(target!.resource.uri)!;
    await uploadLocalPaths(destRoot, plan.destDirPath, plan.localPaths);
  }
}

/**
 * Uploads each of `localPaths` (files or folders, anywhere on disk -- not
 * necessarily under any configured local workspace) into `destDirPath` on
 * `destRoot`'s server, preserving each one's own basename. Shared by the
 * external drag-and-drop above and the "Upload Here" command, which both
 * reduce to "upload these arbitrary local paths into this remote directory".
 * Each upload is independent -- one failure is reported and doesn't stop the
 * rest.
 */
export async function uploadLocalPaths(
  destRoot: ExplorerRoot,
  destDirPath: string,
  localPaths: readonly string[]
): Promise<void> {
  const { fileService, config, id } = destRoot.explorerContext;

  await Promise.all(
    localPaths.map(async localPath => {
      const targetResource = UResource.from(vscode.Uri.file(localPath), {
        localBasePath: path.dirname(localPath),
        remoteBasePath: destDirPath,
        remoteId: id,
        remote: { host: config.host, port: config.port },
      });

      try {
        await upload({ fileService, config, target: targetResource }, { ignore: null });
      } catch (err) {
        reportError(
          err instanceof Error ? err : new Error(String(err)),
          `when uploading '${path.basename(localPath)}'`
        );
      }
    })
  );
}
