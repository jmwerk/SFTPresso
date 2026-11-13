import { validateConfig } from '../config';

const base = { host: 'h', username: 'u', remotePath: '/r' };

describe('validateConfig — backup', () => {
  it('accepts true, false, null, or { dir, keep }', () => {
    expect(validateConfig({ ...base, backup: true })).toBeUndefined();
    expect(validateConfig({ ...base, backup: false })).toBeUndefined();
    expect(validateConfig({ ...base, backup: null })).toBeUndefined();
    expect(validateConfig({ ...base, backup: { dir: '.bak', keep: 0 } })).toBeUndefined();
    expect(validateConfig({ ...base, backup: {} })).toBeUndefined();
  });

  it('rejects an empty dir, a negative keep, or another type', () => {
    expect(validateConfig({ ...base, backup: { dir: '' } })).toBeDefined();
    expect(validateConfig({ ...base, backup: { keep: -1 } })).toBeDefined();
    expect(validateConfig({ ...base, backup: { keep: 1.5 } })).toBeDefined();
    expect(validateConfig({ ...base, backup: '.bak' })).toBeDefined();
  });
});
