import {
  ProgressLocation,
  QuickPickItem,
  QuickPickItemKind,
  Range,
  Selection,
  window,
  workspace,
} from 'vscode';
import { COMMAND_SEARCH_REMOTE } from '../constants';
import { FileService, ServiceConfig, UResource, upath } from '../core';
import { RemoteFileSystem } from '../core/fs';
import { SSHClient } from '../core/remote-client';
import { handleCtxFromUri } from '../fileHandlers';
import { showErrorMessage, showInformationMessage } from '../host';
import logger from '../logger';
import { ExplorerItem } from '../modules/remoteExplorer';
import {
  excludeDirsFrom,
  MAX_RESULTS,
  searchRemote,
  SearchMatch,
  SearchQuery,
  smartCase,
} from '../modules/remoteSearch';
import { checkCommand } from './abstract/createCommand';
import { resolveTargetService } from './shared';

const DEFAULT_TIMEOUT = 60 * 1000;

interface MatchPick extends QuickPickItem {
  match?: SearchMatch;
}

async function resolveTarget(
  item?: ExplorerItem
): Promise<{ fileService: FileService; config: ServiceConfig; dir: string } | undefined> {
  if (item && item.resource) {
    const ctx = handleCtxFromUri(item.resource.uri);
    return { fileService: ctx.fileService, config: ctx.config, dir: ctx.target.remoteFsPath };
  }
  const fileService = await resolveTargetService(undefined, 'Select a config to search');
  if (!fileService) {
    return undefined;
  }
  const config = fileService.getConfig();
  return { fileService, config, dir: config.remotePath };
}

function toPicks(matches: SearchMatch[], dir: string): MatchPick[] {
  const picks: MatchPick[] = [];
  let currentFile: string | undefined;
  for (const match of matches) {
    if (match.fsPath !== currentFile) {
      currentFile = match.fsPath;
      picks.push({ label: upath.relative(dir, match.fsPath), kind: QuickPickItemKind.Separator });
    }
    picks.push({
      label: match.preview || ' ',
      description: `${upath.basename(match.fsPath)}:${match.line}`,
      match,
    });
  }
  return picks;
}

async function openMatch(
  fileService: FileService,
  config: ServiceConfig,
  match: SearchMatch,
  query: SearchQuery
) {
  const uri = UResource.makeResource({
    remote: { host: config.host, port: config.port },
    fsPath: match.fsPath,
    remoteId: fileService.id,
  }).uri;
  const document = await workspace.openTextDocument(uri);
  const line = Math.min(match.line - 1, document.lineCount - 1);
  const text = document.lineAt(line).text;
  const column = query.caseSensitive
    ? text.indexOf(query.text)
    : text.toLowerCase().indexOf(query.text.toLowerCase());
  const range =
    column === -1
      ? new Range(line, 0, line, 0)
      : new Range(line, column, line, column + query.text.length);
  await window.showTextDocument(document, { selection: new Selection(range.start, range.end) });
}

export default checkCommand({
  id: COMMAND_SEARCH_REMOTE,

  async handleCommand(item?: ExplorerItem) {
    let target;
    try {
      target = await resolveTarget(item);
    } catch (error) {
      showErrorMessage(`Search Remote Files: ${error.message}`);
      return;
    }
    if (!target) {
      showErrorMessage('No SFTP config found.');
      return;
    }
    const { fileService, config, dir } = target;
    if (config.protocol !== 'sftp') {
      showErrorMessage('Searching file contents needs SFTP; FTP has no remote shell.');
      return;
    }

    const text = await window.showInputBox({
      title: `Search ${config.host}:${dir}`,
      prompt: 'Text to find in remote files (case-sensitive if it has an uppercase letter)',
      ignoreFocusOut: true,
    });
    if (!text) {
      return;
    }
    const query = smartCase(text);
    const excludeDirs = excludeDirsFrom(
      config.remoteExplorer && config.remoteExplorer.filesExclude
    );
    const timeout =
      typeof config.remoteCommandTimeout === 'number'
        ? config.remoteCommandTimeout
        : DEFAULT_TIMEOUT;

    let result;
    try {
      result = await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: `Searching ${config.host} for "${text}"…`,
        },
        async () => {
          const fs = (await fileService.getRemoteFileSystem(config)) as RemoteFileSystem;
          const client = fs.getClient();
          if (!(client instanceof SSHClient)) {
            throw new Error(`expected an SSH connection to ${config.host}`);
          }
          return searchRemote(client.getRawClient(), dir, query, excludeDirs, timeout);
        }
      );
    } catch (error) {
      logger.error(error, 'search remote');
      showErrorMessage(`Search Remote Files failed on ${config.host}: ${error.message}`);
      return;
    }

    if (result.matches.length === 0) {
      showInformationMessage(`No results for "${text}" in ${dir}.`);
      return;
    }

    const files = new Set(result.matches.map(m => m.fsPath)).size;
    const picked = await window.showQuickPick(toPicks(result.matches, dir), {
      title: result.truncated
        ? `First ${MAX_RESULTS} results for "${text}" — narrow the search to see the rest`
        : `${result.matches.length} results in ${files} files for "${text}"`,
      placeHolder: 'Filter results, then pick one to open it on the server',
      matchOnDescription: true,
    });
    if (!picked || !picked.match) {
      return;
    }

    try {
      await openMatch(fileService, config, picked.match, query);
    } catch (error) {
      showErrorMessage(`Couldn't open ${picked.match.fsPath}: ${error.message}`);
    }
  },
});
