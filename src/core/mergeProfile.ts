import { isDeepStrictEqual } from 'util';

const DEEP_MERGE_KEYS = new Set(['watcher', 'syncOption', 'remoteExplorer']);

type ProfileConfig = Record<string, any>;

// Profiles override top-level settings, but these three settings are option
// bags: replacing one to set a single flag must not erase the base flags.
// Deliberately only one level deep. For example, `algorithms` is a complete
// cipher policy and a profile should be able to replace it wholesale.
export default function mergeProfile<T extends ProfileConfig>(target: T, source: ProfileConfig): T {
  const result: ProfileConfig = { ...target };
  delete result.profiles;

  Object.keys(source).forEach(key => {
    const value = source[key];
    if (key === 'profiles') {
      return;
    }
    if (key === 'ignore') {
      result.ignore = [...(result.ignore || []), ...(value || [])];
      return;
    }
    if (DEEP_MERGE_KEYS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = { ...(result[key] || {}), ...value };
      return;
    }
    result[key] = value;
  });

  return result as T;
}

// The inverse of mergeProfile: strips from `profile` whatever the base config already
// supplies, so a profile only records what is different and later base edits still reach it.
export function omitInherited(profile: ProfileConfig, base: ProfileConfig): ProfileConfig {
  const result: ProfileConfig = {};

  Object.keys(profile).forEach(key => {
    const value = profile[key];
    const baseValue = base[key];
    if (key === 'profiles' || isDeepStrictEqual(value, baseValue)) {
      return;
    }
    if (key === 'ignore' && Array.isArray(value)) {
      // merged by appending, so base patterns repeated here would only be duplicates
      const baseIgnore: string[] = Array.isArray(baseValue) ? baseValue : [];
      const extra = value.filter(pattern => !baseIgnore.includes(pattern));
      if (extra.length > 0) {
        result.ignore = extra;
      }
      return;
    }
    if (
      DEEP_MERGE_KEYS.has(key) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      baseValue &&
      typeof baseValue === 'object'
    ) {
      const changed = Object.keys(value).filter(
        subKey => !isDeepStrictEqual(value[subKey], baseValue[subKey])
      );
      if (changed.length > 0) {
        result[key] = changed.reduce((acc, subKey) => ({ ...acc, [subKey]: value[subKey] }), {});
      }
      return;
    }
    result[key] = value;
  });

  return result;
}
