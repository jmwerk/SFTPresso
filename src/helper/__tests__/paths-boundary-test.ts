// isRemotePathAtOrUnder/isLocalPathAtOrUnder are pure -- no vscode
// dependency of their own -- but paths.ts also exports functions that reach
// through ../host into vscode. The default __mocks__/vscode.js stub already
// makes that safe to import for real.
import { isRemotePathAtOrUnder, isLocalPathAtOrUnder } from '../paths';
import * as path from 'path';

describe('isRemotePathAtOrUnder', () => {
  test('the parent itself counts as at-or-under', () => {
    expect(isRemotePathAtOrUnder('/var/www', '/var/www')).toBe(true);
  });

  test('a real descendant is under', () => {
    expect(isRemotePathAtOrUnder('/var/www', '/var/www/sub/file.txt')).toBe(true);
  });

  test('a prefix sibling is not under (no false positive on /var/www-legacy)', () => {
    expect(isRemotePathAtOrUnder('/var/www', '/var/www-legacy')).toBe(false);
    expect(isRemotePathAtOrUnder('/var/www', '/var/www-legacy/file.txt')).toBe(false);
  });

  test('an unrelated path is not under', () => {
    expect(isRemotePathAtOrUnder('/var/www', '/etc/passwd')).toBe(false);
  });

  test('resolves . and .. before comparing', () => {
    expect(isRemotePathAtOrUnder('/var/www', '/var/www/./sub')).toBe(true);
    expect(isRemotePathAtOrUnder('/var/www', '/var/www/sub/../other')).toBe(true);
    expect(isRemotePathAtOrUnder('/var/www', '/var/www/../etc/passwd')).toBe(false);
  });

  test('root contains everything', () => {
    expect(isRemotePathAtOrUnder('/', '/anything/at/all')).toBe(true);
  });

  test('a trailing slash on the parent does not change the result', () => {
    expect(isRemotePathAtOrUnder('/var/www/', '/var/www/sub')).toBe(true);
    expect(isRemotePathAtOrUnder('/var/www/', '/var/www-legacy')).toBe(false);
  });
});

describe('isLocalPathAtOrUnder', () => {
  const j = (...parts: string[]) => path.join(...parts);

  test('the parent itself counts as at-or-under', () => {
    const root = j(path.sep, 'src');
    expect(isLocalPathAtOrUnder(root, root)).toBe(true);
  });

  test('a real descendant is under', () => {
    const root = j(path.sep, 'src');
    expect(isLocalPathAtOrUnder(root, j(root, 'sub', 'file.txt'))).toBe(true);
  });

  test('a prefix sibling is not under (src vs src-legacy, src2)', () => {
    const root = j(path.sep, 'src');
    expect(isLocalPathAtOrUnder(root, j(path.sep, 'src-legacy'))).toBe(false);
    expect(isLocalPathAtOrUnder(root, j(path.sep, 'src2'))).toBe(false);
  });

  test('an ancestor is not under its descendant', () => {
    const root = j(path.sep, 'src', 'sub');
    expect(isLocalPathAtOrUnder(root, path.sep + 'src')).toBe(false);
  });

  test('resolves .. before comparing', () => {
    const root = j(path.sep, 'src');
    expect(isLocalPathAtOrUnder(root, j(root, '..', 'dist'))).toBe(false);
  });
});
