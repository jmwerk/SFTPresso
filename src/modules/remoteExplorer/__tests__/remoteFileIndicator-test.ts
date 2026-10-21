// Covers what the user sees for a remote file: the status bar item for the active tab and the
// tab decorations, against a scripted set of open tabs.
const tabs: { groups: Array<{ tabs: any[] }>; active: any } = { groups: [], active: undefined };
const tabListeners: Array<() => void> = [];
const statusBarItem: any = { show: jest.fn(), hide: jest.fn() };

jest.mock('vscode', () => {
  const { URI } = jest.requireActual('vscode-uri');

  class EventEmitter {
    private listeners: Array<(e: any) => void> = [];
    event = (listener: (e: any) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(e?: any) {
      this.listeners.forEach(listener => listener(e));
    }
    dispose() {}
  }

  return {
    Uri: URI,
    EventEmitter,
    ThemeColor: class ThemeColor {
      constructor(public id: string) {}
    },
    StatusBarAlignment: { Left: 1 },
    window: {
      createStatusBarItem: () => statusBarItem,
      registerFileDecorationProvider: () => ({ dispose() {} }),
      tabGroups: {
        get all() {
          return tabs.groups;
        },
        get activeTabGroup() {
          return { activeTab: tabs.active };
        },
        onDidChangeTabs: (listener: () => void) => {
          tabListeners.push(listener);
          return { dispose() {} };
        },
        onDidChangeTabGroups: () => ({ dispose() {} }),
      },
    },
    workspace: { onDidChangeConfiguration: () => ({ dispose() {} }) },
  };
});

jest.mock('../../../helper', () => ({ toLocalPath: jest.fn(), toRemotePath: jest.fn() }));
jest.mock('../../../core', () => ({ upath: jest.requireActual('../../../core/upath').default }));

const extSetting: { openRemoteFilesReadOnly?: boolean } = {};
jest.mock('../../ext', () => ({ getExtensionSetting: () => extSetting }));

import * as vscode from 'vscode';
import UResource from '../../../core/uResource';
import RemoteFileIndicator, { presentRemoteFile, REMOTE_FILE_BADGE } from '../remoteFileIndicator';

const LIVE = { host: 'example.com', port: 62909 };
const STAGING = { host: 'example.com', port: 15526 };

function rootFor(remote: { host: string; port: number }, profiles: string[] = ['Live', 'Staging']): any {
  return {
    resource: UResource.makeResource({ remote, fsPath: '/www', remoteId: 1 }),
    explorerContext: {
      config: { ...remote, remotePath: '/www' },
      fileService: { name: 'client-site', getAvailableProfiles: () => profiles },
    },
  };
}

const uriOf = (fsPath: string, remote = LIVE) => UResource.makeResource({ remote, fsPath, remoteId: 1 }).uri;
const tabFor = (uri: vscode.Uri) => ({ input: { uri } });

function openTabs(...uris: vscode.Uri[]) {
  tabs.groups = [{ tabs: uris.map(tabFor) }];
  tabs.active = uris.length > 0 ? tabFor(uris[0]) : undefined;
  tabListeners.forEach(listener => listener());
}

beforeEach(() => {
  delete extSetting.openRemoteFilesReadOnly;
  tabs.groups = [];
  tabs.active = undefined;
  tabListeners.length = 0;
  statusBarItem.show.mockClear();
  statusBarItem.hide.mockClear();
});

describe('presentRemoteFile', () => {
  test('names the profile and server, on a warning background, for a writable file', () => {
    const presentation = presentRemoteFile(uriOf('/www/index.php'), rootFor(LIVE), 'Live', false);

    expect(presentation).toMatchObject({
      text: '$(cloud) Remote: Live',
      background: 'statusBarItem.warningBackground',
      writable: true,
      badge: REMOTE_FILE_BADGE,
    });
    expect(presentation.tooltip).toContain('index.php');
    expect(presentation.tooltip).toContain('example.com:62909');
    expect(presentation.tooltip).toContain('profile Live');
  });

  test('falls back to the config name when the config has no profiles', () => {
    expect(presentRemoteFile(uriOf('/www/a.txt'), rootFor(LIVE, []), null, false).text).toBe(
      '$(cloud) Remote: client-site'
    );
  });

  test('is quieter and says read-only when openRemoteFilesReadOnly is on', () => {
    const presentation = presentRemoteFile(uriOf('/www/a.txt'), rootFor(LIVE), 'Live', true);

    expect(presentation).toMatchObject({ text: '$(lock) Remote (read-only): Live', writable: false });
    expect(presentation.background).toBeUndefined();
  });

  test('flags a tab whose server the config no longer points at', () => {
    // opened on Live, then the profile switched the config to Staging's port
    const presentation = presentRemoteFile(uriOf('/www/a.txt', LIVE), rootFor(STAGING), 'Staging', false);

    expect(presentation).toMatchObject({
      text: '$(debug-disconnect) Remote: example.com:62909',
      background: 'statusBarItem.errorBackground',
      writable: false,
    });
    expect(presentation.tooltip).toContain('Saving is blocked');
  });
});

describe('RemoteFileIndicator', () => {
  test('shows the status bar item only while a remote file is the active tab', () => {
    const indicator = new RemoteFileIndicator(() => rootFor(LIVE));
    expect(statusBarItem.hide).toHaveBeenCalled();

    openTabs(uriOf('/www/index.php'));
    expect(statusBarItem.show).toHaveBeenCalled();
    expect(statusBarItem.text).toBe('$(cloud) Remote: (base config)');

    indicator.setActiveProfile('Live');
    expect(statusBarItem.text).toBe('$(cloud) Remote: Live');

    statusBarItem.hide.mockClear();
    openTabs(vscode.Uri.file('/local/index.php'));
    expect(statusBarItem.hide).toHaveBeenCalled();
  });

  test('a diff with a remote side counts as editing a remote file', () => {
    new RemoteFileIndicator(() => rootFor(LIVE, []));
    const remote = uriOf('/www/index.php');
    const diffTab = { input: { original: remote, modified: vscode.Uri.file('/local/index.php') } };

    tabs.groups = [{ tabs: [diffTab] }];
    tabs.active = diffTab;
    tabListeners.forEach(listener => listener());

    expect(statusBarItem.show).toHaveBeenCalled();
    expect(statusBarItem.text).toBe('$(cloud) Remote: client-site');
  });

  test('decorates open remote tabs only, and asks again when tabs open or close', () => {
    const indicator = new RemoteFileIndicator(() => rootFor(LIVE));
    const changed: vscode.Uri[][] = [];
    indicator.onDidChangeFileDecorations(uris => changed.push(uris || []));
    const open = uriOf('/www/index.php');
    const notOpen = uriOf('/www/other.php');

    openTabs(open);

    expect(indicator.provideFileDecoration(open)).toMatchObject({
      badge: REMOTE_FILE_BADGE,
      color: { id: 'sftp.remoteFileForeground' },
    });
    expect(indicator.provideFileDecoration(notOpen)).toBeUndefined();
    expect(changed).toEqual([[open]]);

    openTabs();
    expect(indicator.provideFileDecoration(open)).toBeUndefined();
    expect(changed).toEqual([[open], [open]]);
  });
});
