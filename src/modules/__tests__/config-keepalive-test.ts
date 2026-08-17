import { validateConfig, defaultConfig } from '../config';

const base = { host: 'h', username: 'u', remotePath: '/r' };

describe('validateConfig — keepaliveInterval', () => {
  it('accepts the option', () => {
    expect(validateConfig({ ...base, keepaliveInterval: 45 * 1000 })).toBeUndefined();
    // 0 is the documented way to disable keepalive
    expect(validateConfig({ ...base, keepaliveInterval: 0 })).toBeUndefined();
  });

  it('accepts a config that omits it', () => {
    expect(validateConfig(base)).toBeUndefined();
  });

  it('rejects non-numeric, negative or fractional values', () => {
    expect(validateConfig({ ...base, keepaliveInterval: '45s' })).toBeDefined();
    expect(validateConfig({ ...base, keepaliveInterval: -1 })).toBeDefined();
    expect(validateConfig({ ...base, keepaliveInterval: 1.5 })).toBeDefined();
  });

  it('is not defaulted at config-read time, so ~/.ssh/config gets a chance first', () => {
    expect(defaultConfig.hasOwnProperty('keepaliveInterval')).toBe(false);
  });
});

describe('validateConfig — keepaliveCountMax', () => {
  it('accepts the option', () => {
    expect(validateConfig({ ...base, keepaliveCountMax: 6 })).toBeUndefined();
    expect(validateConfig({ ...base, keepaliveCountMax: 0 })).toBeUndefined();
  });

  it('accepts a config that omits it', () => {
    expect(validateConfig(base)).toBeUndefined();
  });

  it('rejects non-numeric, negative or fractional values', () => {
    expect(validateConfig({ ...base, keepaliveCountMax: '6' })).toBeDefined();
    expect(validateConfig({ ...base, keepaliveCountMax: -1 })).toBeDefined();
    expect(validateConfig({ ...base, keepaliveCountMax: 1.5 })).toBeDefined();
  });

  it('is not defaulted at config-read time', () => {
    expect(defaultConfig.hasOwnProperty('keepaliveCountMax')).toBe(false);
  });
});
