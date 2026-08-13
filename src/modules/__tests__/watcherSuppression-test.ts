import {
  claimWatcherSuppression,
  suppressWatcherFor,
  releaseWatcherSuppression,
  isWatcherSuppressed,
  _reset,
} from '../watcherSuppression';

beforeEach(() => {
  _reset();
});

describe('watcherSuppression', () => {
  test('nothing is suppressed by default', () => {
    expect(isWatcherSuppressed('/ws/a.txt')).toBe(false);
  });

  test('an exact suppressed path is suppressed', () => {
    suppressWatcherFor('/ws/a.txt');
    expect(isWatcherSuppressed('/ws/a.txt')).toBe(true);
  });

  test('suppressing a directory covers its descendants', () => {
    suppressWatcherFor('/ws/dir');
    expect(isWatcherSuppressed('/ws/dir/nested/file.txt')).toBe(true);
  });

  test('a prefix sibling is not covered (src vs src-legacy)', () => {
    suppressWatcherFor('/ws/src');
    expect(isWatcherSuppressed('/ws/src-legacy/file.txt')).toBe(false);
  });

  test('an unrelated path is not covered', () => {
    suppressWatcherFor('/ws/dir');
    expect(isWatcherSuppressed('/ws/other/file.txt')).toBe(false);
  });

  test('release hands the path back to the watcher immediately', () => {
    suppressWatcherFor('/ws/a.txt');
    releaseWatcherSuppression('/ws/a.txt');
    expect(isWatcherSuppressed('/ws/a.txt')).toBe(false);
  });

  test('releasing one path leaves other suppressions intact', () => {
    suppressWatcherFor('/ws/a.txt');
    suppressWatcherFor('/ws/b.txt');
    releaseWatcherSuppression('/ws/a.txt');
    expect(isWatcherSuppressed('/ws/a.txt')).toBe(false);
    expect(isWatcherSuppressed('/ws/b.txt')).toBe(true);
  });

  test('a suppression expires after its TTL', () => {
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1000);
    suppressWatcherFor('/ws/a.txt', 500);

    now.mockReturnValue(1499);
    expect(isWatcherSuppressed('/ws/a.txt')).toBe(true);

    now.mockReturnValue(1501);
    expect(isWatcherSuppressed('/ws/a.txt')).toBe(false);

    now.mockRestore();
  });

  test('re-suppressing extends the window', () => {
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1000);
    suppressWatcherFor('/ws/a.txt', 500);

    now.mockReturnValue(1400);
    suppressWatcherFor('/ws/a.txt', 500);

    now.mockReturnValue(1600);
    expect(isWatcherSuppressed('/ws/a.txt')).toBe(true);

    now.mockRestore();
  });

  test('renews a claim until it is explicitly released', () => {
    jest.useFakeTimers();
    const release = claimWatcherSuppression('/ws/download');

    jest.advanceTimersByTime(10_001);
    expect(isWatcherSuppressed('/ws/download/file.txt')).toBe(true);

    release();
    expect(isWatcherSuppressed('/ws/download/file.txt')).toBe(false);
    jest.useRealTimers();
  });
});
