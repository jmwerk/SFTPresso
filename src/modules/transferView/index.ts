import * as vscode from 'vscode';
import { COMMAND_CLEAR_FAILED_TRANSFERS } from '../../constants';
import { registerCommand, setContextValue } from '../../host';
import TransferTask from '../../core/transferTask';
import TransferTreeDataProvider from './treeDataProvider';

export default class TransferView {
  private readonly _treeDataProvider: TransferTreeDataProvider;
  private readonly _view: vscode.TreeView<TransferTask>;

  constructor(context: vscode.ExtensionContext) {
    this._treeDataProvider = new TransferTreeDataProvider();

    this._view = vscode.window.createTreeView('sftpTransfers', {
      treeDataProvider: this._treeDataProvider,
    });

    registerCommand(context, COMMAND_CLEAR_FAILED_TRANSFERS, () =>
      this._treeDataProvider.clearFailed()
    );

    // progress ticks fire this constantly; only push the context key on change
    let hasFailed = false;
    context.subscriptions.push(
      this._view,
      this._treeDataProvider.onDidChangeTreeData(() => {
        if (hasFailed !== this._treeDataProvider.hasFailed()) {
          hasFailed = !hasFailed;
          setContextValue('transfers.hasFailed', hasFailed);
        }
      }),
      this._treeDataProvider.onDidChangeUnseenFailedCount(count => {
        // a failure that lands while the view is open has already been seen
        if (count > 0 && this._view.visible) {
          this._treeDataProvider.clearUnseenFailures();
          return;
        }
        this._view.badge =
          count > 0
            ? { value: count, tooltip: `${count} failed ${count === 1 ? 'transfer' : 'transfers'}` }
            : undefined;
      }),
      // opening the view is the user's acknowledgement of whatever failed
      this._view.onDidChangeVisibility(e => {
        if (e.visible) {
          this._treeDataProvider.clearUnseenFailures();
        }
      })
    );
  }
}
