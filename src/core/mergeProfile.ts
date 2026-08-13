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
