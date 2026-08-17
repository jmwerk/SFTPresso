import { validateConfig, defaultConfig } from '../config';

const base = { host: 'h', username: 'u', remotePath: '/r' };

describe('validateConfig — stallTimeout', () => {
  it('accepts the option', () => {
    expect(validateConfig({ ...base, stallTimeout: 30 * 1000 })).toBeUndefined();
    // 0 is the documented way to wait indefinitely
    expect(validateConfig({ ...base, stallTimeout: 0 })).toBeUndefined();
  });

  it('defaults on', () => {
    expect(defaultConfig.stallTimeout).toBe(120 * 1000);
  });

  it('accepts a config that omits it', () => {
    expect(validateConfig(base)).toBeUndefined();
  });

  it('rejects non-numeric, negative or fractional values', () => {
    expect(validateConfig({ ...base, stallTimeout: '30s' })).toBeDefined();
    expect(validateConfig({ ...base, stallTimeout: -1 })).toBeDefined();
    expect(validateConfig({ ...base, stallTimeout: 2.5 })).toBeDefined();
  });
});
