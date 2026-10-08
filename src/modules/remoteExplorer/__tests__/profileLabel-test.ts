import { addressList, configProfile, hostAddress, rootTooltip } from '../profileLabel';

describe('hostAddress', () => {
  it('omits the default SSH port', () => {
    expect(hostAddress({ host: 'example.com', port: 22 })).toBe('example.com');
    expect(hostAddress({ host: 'example.com' })).toBe('example.com');
  });

  it('shows any other port', () => {
    expect(hostAddress({ host: '203.0.113.10', port: 2223 })).toBe('203.0.113.10:2223');
  });
});

describe('addressList', () => {
  it('lists each distinct address once', () => {
    expect(addressList(['a.com', 'b.com:2222', 'a.com'])).toBe('a.com, b.com:2222');
  });

  it('is undefined without addresses', () => {
    expect(addressList([])).toBeUndefined();
  });
});

describe('rootTooltip', () => {
  const config = { host: 'example.com', port: 2222, remotePath: '/www/site/public' };

  it('lists profile, address and remote path', () => {
    expect(rootTooltip('prod', ['prod'], config)).toBe(
      'Profile: prod\nHost: example.com:2222\nRemote path: /www/site/public'
    );
  });

  it('omits the profile line for a config without profiles', () => {
    expect(rootTooltip('prod', [], config)).toBe(
      'Host: example.com:2222\nRemote path: /www/site/public'
    );
  });
});

describe('configProfile', () => {
  it('is the active profile when this config defines it', () => {
    expect(configProfile('staging', ['staging'])).toBe('staging');
  });

  it('is (base config) when this config has profiles but not the active one', () => {
    expect(configProfile('dev', ['staging'])).toBe('(base config)');
    expect(configProfile(null, ['staging'])).toBe('(base config)');
  });

  it('is undefined for a config without profiles', () => {
    expect(configProfile('staging', [])).toBeUndefined();
  });
});
