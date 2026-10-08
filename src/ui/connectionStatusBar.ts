import * as vscode from 'vscode';
import { COMMAND_TEST_CONNECTION } from '../constants';
import { STATUS_PRIORITY } from './statusBarPriority';

export enum ConnectionState {
  Idle = 'idle',
  Connecting = 'connecting',
  Reconnecting = 'reconnecting',
  Connected = 'connected',
  Lost = 'lost',
  Error = 'error',
}

// Precedence when several connections are live at once: an in-flight
// (re)connect wins over an error, which wins over a healthy connection.
const STATE_PRIORITY = [
  ConnectionState.Reconnecting,
  ConnectionState.Connecting,
  ConnectionState.Error,
  ConnectionState.Lost,
  ConnectionState.Connected,
  ConnectionState.Idle,
];

interface StatePresentation {
  text: string;
  tooltip: string;
  background?: string;
}

// Icon-only: the profile item next to it already says "SFTP", and the tooltip
// plus accessibility label carry the words.
function present(state: ConnectionState): StatePresentation {
  switch (state) {
    case ConnectionState.Connecting:
      return { text: '$(sync~spin)', tooltip: 'connecting…' };
    case ConnectionState.Reconnecting:
      return { text: '$(sync~spin)', tooltip: 'reconnecting…' };
    case ConnectionState.Connected:
      return { text: '$(vm-active)', tooltip: 'connected' };
    case ConnectionState.Lost:
      return {
        text: '$(debug-disconnect)',
        // no background: servers routinely close idle connections, which is benign
        tooltip: 'connection lost, reconnects on next use',
      };
    case ConnectionState.Error:
      return {
        text: '$(error)',
        tooltip: 'connection error',
        background: 'statusBarItem.errorBackground',
      };
    case ConnectionState.Idle:
    default:
      return { text: '$(plug)', tooltip: 'idle' };
  }
}

// A single status-bar indicator that surfaces the health of the remote
// connections. Connections reconnect lazily, so this makes silent
// reconnects and auth failures visible. Clicking it runs Test Connection.
export default class ConnectionStatusBar {
  private statusBarItem: vscode.StatusBarItem;
  private states: Map<string, ConnectionState> = new Map();
  // Which connections count. The pool keeps one per target, so without this a connection
  // that failed under another profile would keep showing an error over the live one.
  private isRelevant: (id: string) => boolean = () => true;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      'sftpresso.connection',
      vscode.StatusBarAlignment.Left,
      STATUS_PRIORITY.connection
    );
    this.statusBarItem.name = 'SFTPresso Connection';
    this.statusBarItem.command = COMMAND_TEST_CONNECTION;
    this._render();
  }

  setState(id: string, state: ConnectionState) {
    this.states.set(id, state);
    this._render();
  }

  clear(id: string) {
    this.states.delete(id);
    this._render();
  }

  setRelevance(isRelevant: (id: string) => boolean) {
    this.isRelevant = isRelevant;
    this._render();
  }

  // re-render after what isRelevant answers may have changed, e.g. a profile switch
  refresh() {
    this._render();
  }

  show() {
    this.statusBarItem.show();
  }

  hide() {
    this.statusBarItem.hide();
  }

  dispose() {
    this.statusBarItem.dispose();
  }

  private _aggregate(): ConnectionState {
    const active = new Set<ConnectionState>();
    this.states.forEach((state, id) => {
      if (this.isRelevant(id)) {
        active.add(state);
      }
    });
    for (const state of STATE_PRIORITY) {
      if (active.has(state)) {
        return state;
      }
    }
    return ConnectionState.Idle;
  }

  private _render() {
    const { text, tooltip, background } = present(this._aggregate());
    this.statusBarItem.text = text;
    this.statusBarItem.tooltip = `SFTPresso: ${tooltip} — click to test connection`;
    this.statusBarItem.accessibilityInformation = {
      label: `SFTPresso connection: ${tooltip}`,
      role: 'button',
    };
    this.statusBarItem.backgroundColor = background
      ? new vscode.ThemeColor(background)
      : undefined;
  }
}
