// Profiles exist but none applies: the config runs on its top-level settings, which are a real
// target (often the live site), so this must not read as "nothing selected".
export const BASE_CONFIG = '(base config)';

const DEFAULT_SSH_PORT = 22;

// Live and staging often share a host and differ only by port (Kinsta), so a non-default
// port is shown or the two would look identical.
export function hostAddress(config: { host: string; port?: number }): string {
  return config.port && config.port !== DEFAULT_SSH_PORT
    ? `${config.host}:${config.port}`
    : config.host;
}

// The profile a config is actually using: the active one only if this config defines it.
// undefined for a config without profiles.
export function configProfile(activeProfile: string | null, configProfiles: string[]): string | undefined {
  if (configProfiles.length <= 0) {
    return undefined;
  }
  return activeProfile && configProfiles.includes(activeProfile) ? activeProfile : BASE_CONFIG;
}

// Where the configs that use profiles point, e.g. "203.0.113.10:2223", each address once.
export function addressList(addresses: string[]): string | undefined {
  const unique = Array.from(new Set(addresses));
  return unique.length > 0 ? unique.join(', ') : undefined;
}

export function rootTooltip(
  activeProfile: string | null,
  configProfiles: string[],
  config: { host: string; port?: number; remotePath: string }
): string {
  const profile = configProfile(activeProfile, configProfiles);
  const lines = [`Host: ${hostAddress(config)}`, `Remote path: ${config.remotePath}`];
  return (profile ? [`Profile: ${profile}`, ...lines] : lines).join('\n');
}
