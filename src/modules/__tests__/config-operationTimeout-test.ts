import { validateConfig, defaultConfig } from '../config';

const base = { host: 'h', username: 'u', remotePath: '/r' };

describe('validateConfig — operationTimeout', () => {
  it('accepts the option', () => {
    expect(validateConfig({ ...base, operationTimeout: 30 * 1000 })).toBeUndefined();
    // 0 is the documented way to wait indefinitely
    expect(validateConfig({ ...base, operationTimeout: 0 })).toBeUndefined();
  });

  it('accepts a config that omits it', () => {
    expect(validateConfig(base)).toBeUndefined();
  });

  it('rejects non-numeric, negative or fractional values', () => {
    expect(validateConfig({ ...base, operationTimeout: '30s' })).toBeDefined();
    expect(validateConfig({ ...base, operationTimeout: -1 })).toBeDefined();
    expect(validateConfig({ ...base, operationTimeout: 2.5 })).toBeDefined();
  });

  it('defaults on', () => {
    // the point of the option: a hang has to end on its own, without the
    // user having first known to opt in
    expect(defaultConfig.operationTimeout).toBe(60 * 1000);
  });
});
