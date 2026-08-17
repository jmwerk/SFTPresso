import { isLocalPathAtOrUnder } from '../helper';

// A server-side rename still causes the local file(s) to move on disk, which
// fires the normal FileSystemWatcher delete+create events for the whole
// subtree. This registry lets the rename flow claim a path (and everything
// under it) for a short window so those events get dropped instead of
// re-triggering an upload/delete through the usual watcher queues.
//
// Time-based rather than consume-on-first-use: a single rename can produce
// more than one raw watcher event for the same path.
export const SUPPRESSION_TTL = 10_000;

const suppressed = new Map<string, number>();

function sweep() {
  const now = Date.now();
  for (const [fsPath, expiry] of suppressed) {
    if (expiry <= now) {
      suppressed.delete(fsPath);
    }
  }
}

export function suppressWatcherFor(fsPath: string, ttl: number = SUPPRESSION_TTL) {
  suppressed.set(fsPath, Date.now() + ttl);
}

export function releaseWatcherSuppression(fsPath: string) {
  suppressed.delete(fsPath);
}

// Keep a claim alive while an extension-initiated local write is in flight.
// A transfer can outlast the TTL, so renewal makes the timeout a crash
// backstop rather than a deadline that lets a long download echo via autoUpload.
export function claimWatcherSuppression(fsPath: string): () => void {
  suppressWatcherFor(fsPath);
  const renewal = setInterval(() => suppressWatcherFor(fsPath), SUPPRESSION_TTL / 2);
  return () => {
    clearInterval(renewal);
    releaseWatcherSuppression(fsPath);
  };
}

export function isWatcherSuppressed(fsPath: string): boolean {
  sweep();
  for (const root of suppressed.keys()) {
    if (isLocalPathAtOrUnder(root, fsPath)) {
      return true;
    }
  }
  return false;
}

// test-only seam
export function _reset() {
  suppressed.clear();
}
