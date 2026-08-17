import {
  DEFAULT_KEEPALIVE_COUNT_MAX,
  DEFAULT_KEEPALIVE_INTERVAL,
  resolveKeepaliveCountMax,
  resolveKeepaliveInterval,
} from '../sshClient';

describe('resolveKeepaliveInterval', () => {
  it('falls back to the default when unset', () => {
    expect(resolveKeepaliveInterval(undefined)).toBe(DEFAULT_KEEPALIVE_INTERVAL);
  });

  it('an explicit value wins over the default', () => {
    expect(resolveKeepaliveInterval(45000)).toBe(45000);
  });

  it('0 disables keepalive rather than falling back to the default', () => {
    expect(resolveKeepaliveInterval(0)).toBe(0);
  });
});

describe('resolveKeepaliveCountMax', () => {
  it('falls back to the default when unset', () => {
    expect(resolveKeepaliveCountMax(undefined)).toBe(DEFAULT_KEEPALIVE_COUNT_MAX);
  });

  it('an explicit value wins over the default', () => {
    expect(resolveKeepaliveCountMax(6)).toBe(6);
  });

  it('0 is honored as an explicit value', () => {
    expect(resolveKeepaliveCountMax(0)).toBe(0);
  });
});
