const showWarningMessage = jest.fn();
const executeCommand = jest.fn();
const getExtension = jest.fn();

jest.mock('vscode', () => {
  const disposable = { dispose() {} };
  const anyFn = () => disposable;
  const ns = () =>
    new Proxy(
      {
        showWarningMessage,
      },
      { get: (t, k) => (k in t ? t[k] : anyFn) }
    );

  return {
    window: ns(),
    extensions: { getExtension },
    EventEmitter: class {
      get event() {
        return () => disposable;
      }
      fire() {}
      dispose() {}
    },
  };
});

jest.mock('../../host', () => ({
  showWarningMessage,
  executeCommand,
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, critical() {} },
}));

import { checkForLegacyExtensions } from '../legacyExtensionCheck';

function makeContext(suppressed = false) {
  const store: { [key: string]: any } = {
    'sftp.legacyExtensionCheck.suppressed': suppressed,
  };
  return {
    workspaceState: {
      get: (key: string) => store[key],
      update: (key: string, value: any) => {
        store[key] = value;
        return Promise.resolve();
      },
    },
    store,
  } as any;
}

describe('checkForLegacyExtensions', () => {
  beforeEach(() => {
    showWarningMessage.mockReset();
    executeCommand.mockReset();
    getExtension.mockReset();
  });

  it('does nothing when neither legacy extension is present', () => {
    getExtension.mockReturnValue(undefined);

    checkForLegacyExtensions(makeContext());

    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('warns when liximomo.sftp is enabled', () => {
    getExtension.mockImplementation((id: string) =>
      id === 'liximomo.sftp' ? { packageJSON: { displayName: 'SFTP' } } : undefined
    );
    showWarningMessage.mockResolvedValue(undefined);

    checkForLegacyExtensions(makeContext());

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    const [message] = showWarningMessage.mock.calls[0];
    expect(message).toContain('SFTP');
  });

  it('treats an installed-but-disabled extension as absent', () => {
    // getExtension() returns undefined for disabled extensions — nothing
    // else in this module needs to special-case "installed but disabled".
    getExtension.mockReturnValue(undefined);

    checkForLegacyExtensions(makeContext());

    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('warns when Natizyskunk.sftp is enabled', () => {
    getExtension.mockImplementation((id: string) =>
      id === 'Natizyskunk.sftp' ? { packageJSON: { displayName: 'SFTP' } } : undefined
    );
    showWarningMessage.mockResolvedValue(undefined);

    checkForLegacyExtensions(makeContext());

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    const [message] = showWarningMessage.mock.calls[0];
    expect(message).toContain('SFTP');
  });

  it('stays quiet once suppressed for the workspace', () => {
    getExtension.mockImplementation((id: string) =>
      id === 'Natizyskunk.sftp' ? { packageJSON: {} } : undefined
    );

    checkForLegacyExtensions(makeContext(true));

    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('reveals the extension when "Show Me" is chosen', async () => {
    getExtension.mockImplementation((id: string) =>
      id === 'liximomo.sftp' ? { packageJSON: {} } : undefined
    );
    showWarningMessage.mockResolvedValue('Show Me');

    checkForLegacyExtensions(makeContext());
    await Promise.resolve();
    await Promise.resolve();

    expect(executeCommand).toHaveBeenCalledWith('workbench.extensions.action.showExtensionsWithIds', [
      'liximomo.sftp',
    ]);
  });

  it('persists suppression for the workspace when "Don\'t Show Again" is chosen', async () => {
    getExtension.mockImplementation((id: string) =>
      id === 'liximomo.sftp' ? { packageJSON: {} } : undefined
    );
    showWarningMessage.mockResolvedValue("Don't Show Again");

    const context = makeContext();
    checkForLegacyExtensions(context);
    await Promise.resolve();
    await Promise.resolve();

    expect(context.store['sftp.legacyExtensionCheck.suppressed']).toBe(true);
  });
});
