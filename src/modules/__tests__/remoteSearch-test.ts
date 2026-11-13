jest.mock('../../core/remote-client/exec', () => ({ execCommand: jest.fn() }));

import { execCommand } from '../../core/remote-client/exec';
import {
  buildSearchCommand,
  escapeExtendedRegExp,
  excludeDirsFrom,
  MAX_RESULTS,
  parseSearchOutput,
  searchRemote,
  smartCase,
} from '../remoteSearch';

const execMock = execCommand as jest.Mock;
const ok = (stdout: string, stderr = '') => ({ code: 0, signal: null, stdout, stderr, timedOut: false });

describe('query building', () => {
  test('smart case: an uppercase letter makes it case-sensitive', () => {
    expect(smartCase('define').caseSensitive).toBe(false);
    expect(smartCase('DB_NAME').caseSensitive).toBe(true);
  });

  test('escapes every ERE metacharacter so the text matches literally', () => {
    const text = 'a.b*c+d?e(f)g[h]i{j}k|l^m$n\\o';
    const re = new RegExp(escapeExtendedRegExp(text));
    expect(re.test(text)).toBe(true);
    expect(re.test('aXb*c+d?e(f)g[h]i{j}k|l^m$n\\o')).toBe(false);
  });

  test('excludes the defaults plus bare-name filesExclude entries', () => {
    expect(excludeDirsFrom(['vendor/', 'wp-content/cache', '!keep', '*.log', '.git'])).toEqual([
      '.git',
      '.svn',
      '.hg',
      'CVS',
      'node_modules',
      'vendor',
      '*.log',
    ]);
  });

  test('quotes the directory, the excludes, and the pattern', () => {
    const command = buildSearchCommand("/www/it's", smartCase("it's"), ['a b']);
    expect(command).toBe(
      "cd '/www/it'\\''s' && grep -rnoIsEi --null --exclude-dir='a b' " +
        "-e '.{0,60}it'\\''s.{0,60}' . | head -n 2001"
    );
    expect(buildSearchCommand('/w', smartCase('X'), [])).toBe(
      "cd '/w' && grep -rnoIsE --null -e '.{0,60}X.{0,60}' . | head -n 2001"
    );
  });

  test('find mode prunes excluded folders and greps each file with a path prefix', () => {
    expect(buildSearchCommand('/w', smartCase('x'), ['.git', 'a b'], 'find')).toBe(
      "cd '/w' && find . \\( -type d \\( -name '.git' -o -name 'a b' \\) \\) -prune -o " +
        "-type f -exec grep -HnoIsEi -e '.{0,60}x.{0,60}' {} + 2>/dev/null | head -n 2001"
    );
    expect(buildSearchCommand('/w', smartCase('x'), [], 'find')).toContain('find . -type f -exec');
  });
});

describe('parseSearchOutput', () => {
  test('null-separated: paths with colons survive, one result per line', () => {
    const out = './a:b.php\x0012:  define(\n./a:b.php\x0012:again\n./wp/c.php\x003:x:y\n';
    expect(parseSearchOutput(out, '/www').matches).toEqual([
      { fsPath: '/www/a:b.php', line: 12, preview: 'define(' },
      { fsPath: '/www/wp/c.php', line: 3, preview: 'x:y' },
    ]);
  });

  test('colon-separated fallback', () => {
    expect(parseSearchOutput('./wp/c.php:3:x:y\n', '/www', false).matches).toEqual([
      { fsPath: '/www/wp/c.php', line: 3, preview: 'x:y' },
    ]);
  });

  test('flags truncation past MAX_RESULTS', () => {
    const out = Array.from({ length: MAX_RESULTS + 1 }, (_, i) => `./f\x00${i + 1}:x`).join('\n');
    const result = parseSearchOutput(out, '/www');
    expect(result.truncated).toBe(true);
    expect(result.matches).toHaveLength(MAX_RESULTS);
  });
});

describe('searchRemote', () => {
  beforeEach(() => execMock.mockReset());

  test('falls back to find when grep has no --null (BusyBox)', async () => {
    execMock
      .mockResolvedValueOnce(ok('', 'grep: unrecognized option: null'))
      .mockResolvedValueOnce(ok('./a.php:1:hit\x00\x01\n'));
    const result = await searchRemote({} as any, '/www', smartCase('hit'), [], 1000);

    expect(execMock.mock.calls[1][1]).toContain('find . -type f');
    expect(result.matches).toEqual([{ fsPath: '/www/a.php', line: 1, preview: 'hit' }]);
  });

  test('no output plus stderr is an error, e.g. a missing directory', async () => {
    execMock.mockResolvedValueOnce(ok('', "sh: cd: can't cd to /nope\n"));
    await expect(searchRemote({} as any, '/nope', smartCase('x'), [], 1000)).rejects.toThrow(
      "can't cd to /nope"
    );
  });

  test('no output and no stderr is simply no results', async () => {
    execMock.mockResolvedValueOnce(ok(''));
    expect((await searchRemote({} as any, '/www', smartCase('x'), [], 1000)).matches).toEqual([]);
  });

  test('a timeout is reported', async () => {
    execMock.mockResolvedValueOnce({ ...ok(''), timedOut: true });
    await expect(searchRemote({} as any, '/www', smartCase('x'), [], 5)).rejects.toThrow(/timed out/);
  });
});
