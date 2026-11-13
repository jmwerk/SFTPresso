import { InputBoxValidationSeverity, l10n, ProgressLocation, window } from 'vscode';
import app from '../app';
import { COMMAND_SET_PERMISSIONS_REMOTE } from '../constants';
import { FileType, upath } from '../core';
import {
  FileHandlerContext,
  formatMode,
  handleCtxFromUri,
  parseMode,
  setRemotePermissions,
  SetPermissionsResult,
} from '../fileHandlers';
import { showErrorMessage, showInformationMessage } from '../host';
import { show as showOutput } from '../ui/output';
import { checkCommand } from './abstract/createCommand';
import { uriFromExplorerContextOrEditorContext } from './shared';

const DEFAULT_FILE_MODE = '644';

interface Target {
  ctx: FileHandlerContext;
  isDirectory: boolean;
  mode: number;
}

async function statTargets(ctxs: FileHandlerContext[]): Promise<Target[]> {
  return Promise.all(
    ctxs.map(async ctx => {
      const remoteFs = await ctx.fileService.getRemoteFileSystem(ctx.config);
      const stat = await remoteFs.lstat(ctx.target.remoteFsPath);
      return { ctx, isDirectory: stat.type === FileType.Directory, mode: stat.mode };
    })
  );
}

function validator(hasFolder: boolean) {
  return (value: string) => {
    const mode = parseMode(value);
    if (mode === undefined) {
      return l10n.t('Enter 3 or 4 octal digits, e.g. 644 or 755.');
    }
    if (hasFolder && !(mode & 0o100)) {
      return {
        message: l10n.t("Without the owner execute bit (e.g. 755) you can't open the folder."),
        severity: InputBoxValidationSeverity.Warning,
      };
    }
    return undefined;
  };
}

export default checkCommand({
  id: COMMAND_SET_PERMISSIONS_REMOTE,
  async handleCommand(item, items) {
    const picked = uriFromExplorerContextOrEditorContext(item, items);
    if (!picked) {
      return;
    }
    const uris = Array.isArray(picked) ? picked : [picked];

    let targets: Target[];
    try {
      targets = await statTargets(uris.map(handleCtxFromUri));
    } catch (error) {
      showErrorMessage(l10n.t('Set Permissions: {0}', error.message));
      return;
    }

    const name =
      targets.length === 1
        ? `'${upath.basename(targets[0].ctx.target.remoteFsPath)}'`
        : l10n.t('{0} items', targets.length);
    const sameMode = targets.every(t => (t.mode & 0o7777) === (targets[0].mode & 0o7777));
    const hasFolder = targets.some(t => t.isDirectory);

    const modeInput = await window.showInputBox({
      title: l10n.t('Set Permissions: {0}', name),
      prompt: hasFolder
        ? l10n.t('Octal mode for the folder, e.g. 755')
        : l10n.t('Octal mode, e.g. 644'),
      value: sameMode ? formatMode(targets[0].mode) : '',
      validateInput: validator(hasFolder),
    });
    const mode = modeInput === undefined ? undefined : parseMode(modeInput);
    if (mode === undefined) {
      return;
    }

    let fileMode: number | undefined;
    if (hasFolder) {
      const scope = await window.showQuickPick(
        [
          { label: l10n.t('Selected items only'), recursive: false },
          {
            label: l10n.t('Include contents'),
            description: l10n.t('folders {0}, files set next', formatMode(mode)),
            recursive: true,
          },
        ],
        { title: l10n.t('Set Permissions: {0}', name), placeHolder: l10n.t('Apply to…') }
      );
      if (!scope) {
        return;
      }
      if (scope.recursive) {
        const filePerm = targets[0].ctx.config.filePerm;
        const fileInput = await window.showInputBox({
          title: l10n.t('Set Permissions: {0}', name),
          prompt: l10n.t('Octal mode for files inside, e.g. 644'),
          value:
            filePerm && parseMode(String(filePerm)) !== undefined
              ? String(filePerm)
              : DEFAULT_FILE_MODE,
          validateInput: validator(false),
        });
        fileMode = fileInput === undefined ? undefined : parseMode(fileInput);
        if (fileMode === undefined) {
          return;
        }
      }
    }

    const result: SetPermissionsResult = { changed: 0, failed: [], cancelled: false };
    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: l10n.t('Setting permissions on {0}', name),
        cancellable: fileMode !== undefined,
      },
      async (progress, token) => {
        for (const { ctx } of targets) {
          if (token.isCancellationRequested) {
            result.cancelled = true;
            break;
          }
          try {
            await setRemotePermissions(ctx, {
              mode,
              fileMode,
              token,
              result,
              onProgress: changed => progress.report({ message: l10n.t('{0} changed', changed) }),
            });
          } catch (error) {
            result.failed.push({ fsPath: ctx.target.remoteFsPath, error });
          }
        }
      }
    );

    const summary = result.changed === 1 ? l10n.t('1 item') : l10n.t('{0} items', result.changed);
    if (result.failed.length > 0) {
      const first = result.failed[0];
      const showOutputLabel = l10n.t('Show Output');
      const choice = await showErrorMessage(
        l10n.t(
          'Set Permissions: {0} failed, {1} changed. {2}: {3}',
          result.failed.length,
          summary,
          first.fsPath,
          first.error.message
        ),
        showOutputLabel
      );
      if (choice === showOutputLabel) {
        showOutput();
      }
    } else if (result.cancelled) {
      showInformationMessage(l10n.t('Set Permissions cancelled after {0}.', summary));
    } else {
      app.sftpBarItem.showMsg(
        `$(check) ${formatMode(mode)}`,
        l10n.t('Permissions set on {0}', summary),
        4000
      );
    }
  },
});
