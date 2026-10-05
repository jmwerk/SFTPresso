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
    this.statusBarItem.name = 'SFTPresso Upload on Save';
    this.statusBarItem.text = '$(cloud-upload)';
    this.statusBarItem.command = COMMAND_TOGGLE_UPLOAD_ON_SAVE;
  }

  update(uploadOnSave: boolean | null) {
    if (uploadOnSave === null) {
      this.statusBarItem.hide();
      return;
    }

    const state = uploadOnSave ? 'On' : 'Off';
    this.statusBarItem.tooltip = `Upload on Save: ${state} — click to toggle`;
    this.statusBarItem.accessibilityInformation = {
      label: `SFTPresso upload on save: ${state}`,
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
