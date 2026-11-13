import * as vscode from 'vscode';
import { COMMAND_TOGGLE_UPLOAD_ON_SAVE } from '../constants';
import { STATUS_PRIORITY } from './statusBarPriority';

// Always-visible toggle for the active config's uploadOnSave: dimmed when off,
// hidden only when no single config applies (state null).
export default class UploadOnSaveStatusBar {
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      'sftpresso.uploadOnSave',
      vscode.StatusBarAlignment.Left,
      STATUS_PRIORITY.uploadOnSave
    );
    this.statusBarItem.name = vscode.l10n.t('SFTPresso Upload on Save');
    this.statusBarItem.text = '$(cloud-upload)';
    this.statusBarItem.command = COMMAND_TOGGLE_UPLOAD_ON_SAVE;
  }

  update(uploadOnSave: boolean | null) {
    if (uploadOnSave === null) {
      this.statusBarItem.hide();
      return;
    }

    const state = uploadOnSave ? vscode.l10n.t('On') : vscode.l10n.t('Off');
    this.statusBarItem.tooltip = vscode.l10n.t('Upload on Save: {0} — click to toggle', state);
    this.statusBarItem.accessibilityInformation = {
      label: vscode.l10n.t('SFTPresso upload on save: {0}', state),
      role: 'button',
    };
    this.statusBarItem.color = uploadOnSave
      ? undefined
      : new vscode.ThemeColor('disabledForeground');
    this.statusBarItem.show();
  }

  dispose() {
    this.statusBarItem.dispose();
  }
}
