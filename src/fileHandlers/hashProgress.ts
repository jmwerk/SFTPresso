import { l10n } from 'vscode';
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
  const size = formatBytes(stats.bytes);
  const files = stats.files.toLocaleString();
  if (stats.serverSide > 0) {
    const server = stats.serverSide.toLocaleString();
    return stats.files === 1
      ? l10n.t('hashed 1 file ({0}, {1} on the server)', size, server)
      : l10n.t('hashed {0} files ({1}, {2} on the server)', files, size, server);
  }
  return stats.files === 1
    ? l10n.t('hashed 1 file ({0})', size)
    : l10n.t('hashed {0} files ({1})', files, size);
}
