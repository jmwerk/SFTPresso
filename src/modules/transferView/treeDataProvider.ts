import * as vscode from 'vscode';
import * as path from 'path';
import TransferTask, { TransferDirection } from '../../core/transferTask';
import { formatBytes, formatDuration } from '../../utils';
import { onTransferEvent } from '../serviceManager';

type TransferStatus = 'queued' | 'transferring' | 'error';

export default class TransferTreeDataProvider implements vscode.TreeDataProvider<TransferTask> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TransferTask | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _items: Map<TransferTask, TransferStatus> = new Map();
  // failed rows stay until retried or cleared, so Retry is always reachable
  private readonly _errors: Map<TransferTask, string> = new Map();

  // Failures the user hasn't seen yet. Drives the view badge until the Transfers
  // view is opened.
  private _unseenFailedCount = 0;
  private readonly _onDidChangeUnseenFailedCount = new vscode.EventEmitter<number>();
  readonly onDidChangeUnseenFailedCount = this._onDidChangeUnseenFailedCount.event;

  constructor() {
    onTransferEvent(({ type, task, error }) => {
      switch (type) {
        case 'queued':
          this._errors.delete(task);
          this._items.set(task, 'queued');
          break;
        case 'start':
          this._errors.delete(task);
          this._items.set(task, 'transferring');
          break;
        case 'progress':
          // only the affected row needs to re-render its description
          if (this._items.get(task) === 'transferring') {
            this._onDidChangeTreeData.fire(task);
          }
          return;
        case 'done':
          if (error && !task.isCancelled()) {
            this._items.set(task, 'error');
            this._errors.set(task, error.message || String(error));
            this._unseenFailedCount++;
            this._onDidChangeUnseenFailedCount.fire(this._unseenFailedCount);
          } else {
            this._items.delete(task);
          }
          break;
      }

      this._onDidChangeTreeData.fire(undefined);
    });
  }

  clearUnseenFailures(): void {
    if (this._unseenFailedCount === 0) {
      return;
    }
    this._unseenFailedCount = 0;
    this._onDidChangeUnseenFailedCount.fire(0);
  }

  hasFailed(): boolean {
    return this._errors.size > 0;
  }

  clearFailed(): void {
    for (const task of this._errors.keys()) {
      this._items.delete(task);
    }
    this._errors.clear();
    this.clearUnseenFailures();
    this._onDidChangeTreeData.fire(undefined);
  }

  private _progressDescription(task: TransferTask): string {
    const transferred = task.transferredBytes;
    const total = task.totalBytes;
    const bytesPerSecond = task.bytesPerSecond;

    // the sidebar truncates long descriptions, so lead with what changes
    const parts: string[] = [];
    // live rows re-render on every tick, which closes hovers, so the total lives here
    if (total && total > 0) {
      const percent = Math.min(100, Math.floor((transferred / total) * 100));
      parts.push(`${percent}% of ${formatBytes(total)}`);
    } else {
      parts.push(formatBytes(transferred));
    }

    // state first: the sidebar truncates from the end
    if (task.isStalled) {
      return ['stalled', ...parts].join(' · ');
    }

    // omit the speed segment until a second sample lands, rather than
    // showing a misleading "0 B/s" on the first progress tick
    if (bytesPerSecond !== undefined) {
      parts.push(`${formatBytes(bytesPerSecond)}/s`);
      if (total && total > 0 && bytesPerSecond > 0) {
        parts.push(formatDuration(Math.max(0, total - transferred) / bytesPerSecond));
      }
    }

    return parts.join(' · ');
  }

  private _tooltip(task: TransferTask, status: TransferStatus): vscode.MarkdownString {
    const isUpload = task.transferType === TransferDirection.LOCAL_TO_REMOTE;
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${isUpload ? 'Upload' : 'Download'}**\n\n`);
    tooltip.appendText(`From: ${task.srcFsPath}\n\nTo: ${task.targetFsPath}`);

    if (status === 'error') {
      tooltip.appendText(`\n\nFailed: ${this._errors.get(task)}`);
    }
    return tooltip;
  }

  getTreeItem(task: TransferTask): vscode.TreeItem {
    const status = this._items.get(task) || 'queued';
    const item = new vscode.TreeItem(path.basename(task.localFsPath));
    const isUpload = task.transferType === TransferDirection.LOCAL_TO_REMOTE;

    if (status === 'transferring') {
      item.description =
        task.transferredBytes > 0
          ? this._progressDescription(task)
          : isUpload
          ? 'uploading'
          : 'downloading';
      item.iconPath = task.isStalled
        ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
        : new vscode.ThemeIcon(isUpload ? 'cloud-upload' : 'cloud-download');
    } else if (status === 'error') {
      item.description = 'failed';
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    } else {
      item.description = 'queued';
      item.iconPath = new vscode.ThemeIcon('clock');
    }
    item.tooltip = this._tooltip(task, status);
    item.contextValue = status === 'error' ? 'failedTransfer' : 'activeTransfer';

    return item;
  }

  getChildren(): TransferTask[] {
    return Array.from(this._items.keys()).reverse();
  }
}
