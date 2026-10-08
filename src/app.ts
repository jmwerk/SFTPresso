import { ExtensionContext } from 'vscode';
import { LRUCache } from 'lru-cache';
import StatusBarItem from './ui/statusBarItem';
import ConnectionStatusBar from './ui/connectionStatusBar';
import UploadOnSaveStatusBar from './ui/uploadOnSaveStatusBar';
import { STATUS_PRIORITY } from './ui/statusBarPriority';
import {
  COMMAND_TOGGLE_OUTPUT,
  VIEW_TRANSFERS_FOCUS,
  COMMAND_SET_PROFILE,
} from './constants';
import AppState from './modules/appState';
import RemoteExplorer from './modules/remoteExplorer';
import TransferView from './modules/transferView';
import { BASE_CONFIG } from './modules/remoteExplorer/profileLabel';

interface App {
  vscodeContext: ExtensionContext;
  fsCache: LRUCache<string, string>;
  state: AppState;
  sftpBarItem: StatusBarItem;
  connectionBarItem: ConnectionStatusBar;
  uploadOnSaveBarItem: UploadOnSaveStatusBar;
  transferBarItem: StatusBarItem;
  remoteExplorer: RemoteExplorer;
  transferView: TransferView;
}

const app: App = Object.create(null);

app.state = new AppState();
app.sftpBarItem = new StatusBarItem(
  'sftpresso.profile',
  'SFTPresso Profile',
  STATUS_PRIORITY.profile,
  () => {
    if (app.state.profile) {
      return `SFTP: ${app.state.profile}`;
    }
    return app.state.availableProfiles.length > 0 ? `SFTP: ${BASE_CONFIG}` : 'SFTP';
  },
  // upload on save has its own toggle item next to this one
  () =>
    app.state.availableProfiles.length > 0 ? 'SFTPresso — click to switch profile' : 'SFTPresso',
  () =>
    app.state.availableProfiles.length > 0 ? COMMAND_SET_PROFILE : COMMAND_TOGGLE_OUTPUT
);
app.connectionBarItem = new ConnectionStatusBar();
app.uploadOnSaveBarItem = new UploadOnSaveStatusBar();
app.transferBarItem = new StatusBarItem(
  'sftpresso.transfers',
  'SFTPresso Transfers',
  STATUS_PRIORITY.transfers,
  () => '',
  'SFTPresso transfers (click to show)',
  VIEW_TRANSFERS_FOCUS
);
app.fsCache = new LRUCache<string, string>({ max: 6 });

export default app;
