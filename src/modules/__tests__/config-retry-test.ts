import { validateConfig } from '../config';

const base = { host: 'h', username: 'u', remotePath: '/r' };

describe('validateConfig — retry', () => {
  it('accepts the option', () => {
    expect(validateConfig({ ...base, retry: { attempts: 2, delay: 1000 } })).toBeUndefined();
    expect(validateConfig({ ...base, retry: { attempts: 0, delay: 0 } })).toBeUndefined();
    expect(validateConfig({ ...base, retry: { attempts: 5 } })).toBeUndefined();
  });

  it('accepts a config that omits it', () => {
    expect(validateConfig(base)).toBeUndefined();
  });

  it('rejects non-numeric or negative values', () => {
    expect(validateConfig({ ...base, retry: { attempts: 'many' } })).toBeDefined();
    expect(validateConfig({ ...base, retry: { attempts: -1 } })).toBeDefined();
    expect(validateConfig({ ...base, retry: { delay: -1000 } })).toBeDefined();
  });
});
