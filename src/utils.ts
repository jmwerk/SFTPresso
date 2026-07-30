export function flatten(items) {
  const accumulater = (result, item) => result.concat(item);
  return items.reduce(accumulater, []);
}

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * A counting semaphore for remote operations.
 *
 * The directory walk recurses with `Promise.all`, which on a large tree issues
 * one listing per directory all at once against a single connection. Wrapping
 * the individual remote calls — rather than the recursive calls, which would
 * deadlock waiting on children that need a slot — caps how many requests are in
 * flight without changing the shape of the walk.
 */
export function createLimiter(limit: number): Limiter {
  const width = Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 1);
  const waiting: (() => void)[] = [];
  let active = 0;

  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) {
      next();
    }
  };

  return function run<T>(fn: () => Promise<T>): Promise<T> {
    const acquire = new Promise<void>(resolve => {
      const take = () => {
        active += 1;
        resolve();
      };

      if (active < width) {
        take();
      } else {
        waiting.push(take);
      }
    });

    return acquire.then(() =>
      fn().then(
        value => {
          release();
          return value;
        },
        error => {
          release();
          throw error;
        }
      )
    );
  };
}

export function formatBytes(bytes: number): string {
  if (!isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // whole bytes, otherwise one decimal place
  const formatted = unit === 0 ? String(value) : value.toFixed(1);
  return `${formatted} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  const safeSeconds = !isFinite(seconds) || seconds < 0 ? 0 : seconds;
  const totalSeconds = Math.round(safeSeconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(secs)}`;
  }
  return `${pad(minutes)}:${pad(secs)}`;
}

export function interpolate(str: string, props: { [x: string]: string }) {
  return str.replace(/\${([^{}]*)}/g, (match, expr) => {
    const value = props[expr];
    return typeof value === 'string' || typeof value === 'number' ? value : match;
  });
}
