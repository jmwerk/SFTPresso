import { validateConfig } from '../config';

const base = { host: 'h', username: 'u', remotePath: '/r' };

describe('validateConfig — idleTimeout', () => {
  it('accepts the option', () => {
    expect(validateConfig({ ...base, idleTimeout: 5 * 60 * 1000 })).toBeUndefined();
    // 0 is the documented way to turn the check off
    expect(validateConfig({ ...base, idleTimeout: 0 })).toBeUndefined();
  });

  it('accepts a config that omits it', () => {
    expect(validateConfig(base)).toBeUndefined();
  });

  it('rejects non-numeric, negative or fractional values', () => {
    expect(validateConfig({ ...base, idleTimeout: '5m' })).toBeDefined();
    expect(validateConfig({ ...base, idleTimeout: -1 })).toBeDefined();
    expect(validateConfig({ ...base, idleTimeout: 1.5 })).toBeDefined();
  });
});
