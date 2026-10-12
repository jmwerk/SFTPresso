jest.mock('fs');

import app from '../../../app';
import { createFileService, disposeFileService } from '..';

const config = {
  name: 'test',
  host: 'h',
  username: 'u',
  remotePath: '/r',
  context: '/workspace',
  profiles: { ssh: {}, ftp: { protocol: 'ftp' } },
  defaultProfile: 'ssh',
};

afterEach(() => {
  app.state.profile = null;
});

describe('createFileService — defaultProfile', () => {
  it('applies defaultProfile when no profile is active', () => {
    const service = createFileService({ ...config }, '/workspace');
    expect(app.state.profile).toBe('ssh');
    disposeFileService(service);
  });

  it('keeps the profile the user switched to across a config reload', () => {
    app.state.profile = 'ftp';
    const service = createFileService({ ...config }, '/workspace');
    expect(app.state.profile).toBe('ftp');
    disposeFileService(service);
  });

  it('falls back to defaultProfile when the active one no longer exists', () => {
    app.state.profile = 'removed';
    const service = createFileService({ ...config }, '/workspace');
    expect(app.state.profile).toBe('ssh');
    disposeFileService(service);
  });
});

describe('createFileService — profile identical to the base config', () => {
  const liveMatchesBase = {
    name: 'test',
    host: 'h',
    port: 62909,
    username: 'u',
    remotePath: '/r',
    context: '/workspace',
    profiles: { Live: { port: 62909 }, Staging: { port: 15526 } },
  };

  it('starts on that profile', () => {
    const service = createFileService({ ...liveMatchesBase }, '/workspace');
    expect(app.state.profile).toBe('Live');
    disposeFileService(service);
  });

  it('still lets defaultProfile win', () => {
    const service = createFileService({ ...liveMatchesBase, defaultProfile: 'Staging' }, '/workspace');
    expect(app.state.profile).toBe('Staging');
    disposeFileService(service);
  });
});
