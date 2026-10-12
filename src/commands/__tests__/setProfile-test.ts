const showQuickPick = jest.fn();
jest.mock('vscode', () => ({ window: { showQuickPick: (...args) => showQuickPick(...args) } }));
jest.mock('../../host', () => ({ showInformationMessage: jest.fn() }));
jest.mock('../../logger', () => ({ __esModule: true, default: { warn: jest.fn() } }));
jest.mock('../../app', () => ({ __esModule: true, default: { state: { profile: 'staging' } } }));
jest.mock('../abstract/createCommand', () => ({ checkCommand: (option: any) => option }));
let baseEquivalent: string | undefined;
jest.mock('../../modules/serviceManager', () => ({
  getAllFileService: () => [
    {
      getAvailableProfiles: () => ['staging'],
      getBaseEquivalentProfile: () => baseEquivalent,
      getConfig: (profile: string | null) =>
        profile === 'staging'
          ? { host: '203.0.113.10', port: 2223 }
          : { host: '203.0.113.10', port: 2222 },
    },
  ],
}));

import app from '../../app';
import setProfile from '../commandSetProfile';

const run = (...args: any[]) => setProfile.handleCommand.apply({} as any, args);

describe('SFTP: Set Profile', () => {
  beforeEach(() => {
    app.state.profile = 'staging';
    baseEquivalent = undefined;
    showQuickPick.mockReset();
  });

  it('sets a profile passed by name', async () => {
    app.state.profile = null;

    await run('staging');

    expect(app.state.profile).toBe('staging');
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('shows the picker for a non-string argument instead of resetting the profile', async () => {
    showQuickPick.mockResolvedValue(undefined);

    // what a view title button passes
    await run({ some: 'context' });

    expect(showQuickPick).toHaveBeenCalled();
    expect(app.state.profile).toBe('staging');
  });

  it('offers the base config, marked active when no profile is set', async () => {
    showQuickPick.mockResolvedValue(undefined);
    app.state.profile = null;

    await run();

    const items = showQuickPick.mock.calls[0][0];
    expect(items[0]).toMatchObject({
      value: null,
      label: '(base config) (active)',
      description: '203.0.113.10:2222',
    });
    expect(items[1]).toMatchObject({
      value: 'staging',
      label: 'staging',
      description: '203.0.113.10:2223',
    });
  });

  it('applies the profile picked from the list', async () => {
    showQuickPick.mockResolvedValue({ value: null, label: '(base config)' });

    await run();

    expect(app.state.profile).toBeNull();
  });

  it('drops the base config when a profile is identical to it', async () => {
    showQuickPick.mockResolvedValue(undefined);
    app.state.profile = null;
    baseEquivalent = 'staging';

    await run();

    const items = showQuickPick.mock.calls[0][0];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ value: 'staging', label: 'staging (active)' });
  });
});
