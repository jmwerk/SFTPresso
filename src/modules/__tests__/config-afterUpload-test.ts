import { validateConfig } from '../config';

const base = { host: 'h', username: 'u', remotePath: '/r' };

describe('validateConfig — afterUpload', () => {
  it('accepts a string, an array, or an object', () => {
    expect(validateConfig({ ...base, afterUpload: 'wp cache flush' })).toBeUndefined();
    expect(validateConfig({ ...base, afterUpload: ['a', 'b'] })).toBeUndefined();
    expect(
      validateConfig({ ...base, afterUpload: { command: ['a'], onSave: true, delay: 0 } })
    ).toBeUndefined();
    expect(validateConfig({ ...base, afterUpload: null })).toBeUndefined();
  });

  it('rejects empty commands and bad options', () => {
    expect(validateConfig({ ...base, afterUpload: '' })).toBeDefined();
    expect(validateConfig({ ...base, afterUpload: [] })).toBeDefined();
    expect(validateConfig({ ...base, afterUpload: { onSave: true } })).toBeDefined();
    expect(validateConfig({ ...base, afterUpload: { command: 'a', delay: -1 } })).toBeDefined();
    expect(validateConfig({ ...base, afterUpload: 5 })).toBeDefined();
  });
});
