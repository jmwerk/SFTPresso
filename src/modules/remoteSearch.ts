import { Client } from 'ssh2';
import { upath } from '../core';
import { execCommand } from '../core/remote-client/exec';
import { shellQuote } from '../core/remote-client/shell';

// Never searched: VCS internals and the usual dependency folders.
export const DEFAULT_EXCLUDE_DIRS = ['.git', '.svn', '.hg', 'CVS', 'node_modules'];
export const MAX_RESULTS = 2000;
// Characters of context kept on each side of a match, so a minified file can't flood the output.
const CONTEXT = 60;

export interface SearchQuery {
  text: string;
  caseSensitive: boolean;
}

export interface SearchMatch {
  // absolute remote path
  fsPath: string;
  line: number;
  preview: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  // more than MAX_RESULTS lines came back
  truncated: boolean;
}

// Like VS Code's search: an uppercase letter makes it case-sensitive.
export function smartCase(text: string): SearchQuery {
  return { text, caseSensitive: text !== text.toLowerCase() };
}

export function escapeExtendedRegExp(text: string): string {
  return text.replace(/[\\.[\](){}*+?|^$]/g, '\\$&');
}

// filesExclude entries grep can apply as --exclude-dir: bare names or globs, no paths.
export function excludeDirsFrom(filesExclude: string[] = []): string[] {
  const names = filesExclude
    .map(pattern => pattern.replace(/\/+$/, ''))
    .filter(pattern => pattern && !pattern.includes('/') && !pattern.startsWith('!'));
  return Array.from(new Set([...DEFAULT_EXCLUDE_DIRS, ...names]));
}

// 'grep' needs GNU/BSD grep (--null, --exclude-dir); 'find' is the portable fallback for
// BusyBox, whose output has no NUL after the path and which ignores -I.
export type SearchMode = 'grep' | 'find';

export function buildSearchCommand(
  dir: string,
  query: SearchQuery,
  excludeDirs: string[],
  mode: SearchMode = 'grep'
): string {
  // -o with bounded context instead of whole lines; -I skips binaries, -s unreadable files
  const flags = `-noIsE${query.caseSensitive ? '' : 'i'}`;
  const pattern = `-e ${shellQuote(`.{0,${CONTEXT}}${escapeExtendedRegExp(query.text)}.{0,${CONTEXT}}`)}`;

  let search: string;
  if (mode === 'grep') {
    const excludes = excludeDirs.map(name => `--exclude-dir=${shellQuote(name)}`);
    search = ['grep', `-r${flags.slice(1)}`, '--null', ...excludes, pattern, '.'].join(' ');
  } else {
    const names = excludeDirs.map(name => `-name ${shellQuote(name)}`).join(' -o ');
    const prune = names ? `\\( -type d \\( ${names} \\) \\) -prune -o ` : '';
    // find's own permission errors would read as a failed search
    search = `find . ${prune}-type f -exec grep -H${flags.slice(1)} ${pattern} {} + 2>/dev/null`;
  }
  return `cd ${shellQuote(dir)} && ${search} | head -n ${MAX_RESULTS + 1}`;
}

// GNU/BSD output with --null is `./path\0line:text`; without it, `./path:line:text`.
export function parseSearchOutput(stdout: string, dir: string, nullSeparated = true): SearchResult {
  const lines = stdout.split('\n').filter(line => line !== '');
  const truncated = lines.length > MAX_RESULTS;
  const seen = new Set<string>();
  const matches: SearchMatch[] = [];

  for (const raw of lines.slice(0, MAX_RESULTS)) {
    let relative: string;
    let rest: string;
    if (nullSeparated) {
      const nul = raw.indexOf('\0');
      if (nul === -1) {
        continue;
      }
      relative = raw.slice(0, nul);
      rest = raw.slice(nul + 1);
    } else {
      const m = /^(.*?):(?=\d+:)/.exec(raw);
      if (!m) {
        continue;
      }
      relative = m[1];
      rest = raw.slice(m[0].length);
    }

    const m = /^(\d+):([\s\S]*)$/.exec(rest);
    if (!m) {
      continue;
    }
    const fsPath = upath.join(dir, relative);
    const line = Number(m[1]);
    // -o prints one row per match; keep the first per line
    const key = `${fsPath}\n${line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    // control characters from a binary BusyBox didn't skip
    matches.push({ fsPath, line, preview: m[2].replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim() });
  }

  return { matches, truncated };
}

export class RemoteSearchError extends Error {}

export async function searchRemote(
  client: Client,
  dir: string,
  query: SearchQuery,
  excludeDirs: string[],
  timeout: number
): Promise<SearchResult> {
  const run = async (mode: SearchMode) => {
    const result = await execCommand(client, buildSearchCommand(dir, query, excludeDirs, mode), {
      timeout,
      closeStdin: true,
    });
    if (result.timedOut) {
      throw new RemoteSearchError(`search timed out after ${timeout}ms`);
    }
    return result;
  };

  let result = await run('grep');
  if (!result.stdout && /unrecognized option|invalid option|unknown option/i.test(result.stderr)) {
    result = await run('find');
    return parseSearchOutput(result.stdout, dir, false);
  }
  // `head` owns the exit code, so a failed cd or a missing grep only shows on stderr
  if (!result.stdout && result.stderr.trim()) {
    throw new RemoteSearchError(result.stderr.trim().split('\n')[0]);
  }
  return parseSearchOutput(result.stdout, dir, true);
}
