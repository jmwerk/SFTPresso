import { HashStats } from '../core/contentHash';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

// Progress notification text for a content compare, e.g.
// "hashed 1,204 files (312.5 MB, 1,180 on the server)".
export function describeHashProgress(stats: HashStats): string {
  const files = `${stats.files.toLocaleString()} ${stats.files === 1 ? 'file' : 'files'}`;
  const server = stats.serverSide > 0 ? `, ${stats.serverSide.toLocaleString()} on the server` : '';
  return `hashed ${files} (${formatBytes(stats.bytes)}${server})`;
}
