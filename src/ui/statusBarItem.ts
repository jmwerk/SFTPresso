import * as vscode from 'vscode';

enum Status {
  ok = 1,
  warn,
  error,
}

export default class StatusBarItem {
  static Status = Status;

  private _name: string | (() => string);
  private _tooltip: string | (() => string);
  private _command: string | (() => string);
  private statusBarItem: vscode.StatusBarItem;
  private spinning = false;
  private resetTimer: any = null;
  private text: string;
  private status: Status = Status.ok;

  // id and itemName identify the item in the status bar's hide/show menu
  constructor(id: string, itemName: string, name, tooltip, command) {
    this._name = name;
    this._tooltip = tooltip;
    this._command = command;
    this.statusBarItem = vscode.window.createStatusBarItem(id, vscode.StatusBarAlignment.Left);
    this.statusBarItem.name = itemName;
    this.statusBarItem.command = this.command;
    this.reset = this.reset.bind(this);
    this.reset();
  }

  private get name() {
    return typeof this._name === 'function' ? this._name() : this._name;
  }

  private get tooltip() {
    return typeof this._tooltip === 'function' ? this._tooltip() : this._tooltip;
  }

  private get command() {
    return typeof this._command === 'function' ? this._command() : this._command;
  }

  updateStatus(status: Status) {
    this.status = status;
    this._render();
  }

  getText() {
    return this.statusBarItem.text;
  }

  show() {
    this.statusBarItem.show();
  }

  hide() {
    this.statusBarItem.hide();
  }

  isSpinning() {
    return this.spinning;
  }

  startSpinner() {
    this.spinning = true;
    this._render();
  }

  stopSpinner() {
    this.spinning = false;
    this._render();
  }

  showMsg(text: string, hideAfterTimeout?: number);
  showMsg(text: string, tooltip: string, hideAfterTimeout?: number);
  showMsg(text: string, tooltip?: string | number, hideAfterTimeout?: number) {
    if (typeof tooltip === 'number') {
      hideAfterTimeout = tooltip;
      tooltip = text;
    }

    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }

    this.text = text;
    this.statusBarItem.tooltip = tooltip;
    this._render();
    if (hideAfterTimeout) {
      this.resetTimer = setTimeout(this.reset, hideAfterTimeout);
    }
  }

  private _render() {
    // a message that already leads with an icon shows activity on its own
    if (this.isSpinning() && !this.text.startsWith('$(')) {
      this.statusBarItem.text = `$(sync~spin) ${this.text}`;
    } else if (this.name === this.text) {
      switch (this.status) {
        case Status.ok:
          this.statusBarItem.text = this.text;
          break;
        case Status.warn:
          this.statusBarItem.text = `$(alert) ${this.text}`;
          break;
        case Status.error:
          this.statusBarItem.text = `$(issue-opened) ${this.text}`;
          break;
        default:
          this.statusBarItem.text = this.text;
      }
    } else {
      this.statusBarItem.text = this.text;
    }
  }

  reset() {
    // a pending hide-timer from showMsg() has nothing left to hide once we are
    // back to the default text, and would otherwise re-render over whatever
    // state replaced it
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }

    this.text = this.name;
    this.statusBarItem.tooltip = this.tooltip;
    this.statusBarItem.command = this.command;
    this._render();
  }
}
