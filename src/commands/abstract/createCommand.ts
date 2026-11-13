import { l10n, Uri, window } from 'vscode';
import logger from '../../logger';
import { reportError } from '../../helper';
import { handleCtxFromUri, allHandleCtxFromUri, FileHandlerContext } from '../../fileHandlers';
import Command from './command';
import {
  COMMAND_UPLOAD_FILE_TO_ALL_PROFILES,
  COMMAND_UPLOAD_FOLDER_TO_ALL_PROFILES,
} from '../../constants';

interface BaseCommandOption {
  id: string;
  name?: string;
}

interface CommandOption extends BaseCommandOption {
  handleCommand: (this: Command, ...args: any[]) => unknown | Promise<unknown>;
}

interface FileCommandOption extends BaseCommandOption {
  handleFile: (ctx: FileHandlerContext) => Promise<unknown>;
  getFileTarget: (...args: any[]) => undefined | Uri | Uri[] | Promise<undefined | Uri | Uri[]>;
}

async function confirmUploadToAllProfiles() {
  const yes = l10n.t('Yes');
  const answer = await window.showInformationMessage(
    l10n.t('Are you sure you want to upload to all profiles?'),
    yes,
    l10n.t('No')
  );
  return answer === yes;
}

function checkType<T>() {
  return (a: T) => a;
}

export const checkCommand = checkType<CommandOption>();
export const checkFileCommand = checkType<FileCommandOption>();

export function createCommand(commandOption: CommandOption & { name: string }) {
  return class NormalCommand extends Command {
    constructor() {
      super();
      this.id = commandOption.id;
      this.name = commandOption.name;
    }

    doCommandRun(...args) {
      commandOption.handleCommand.apply(this, args);
    }
  };
}

export function createFileCommand(commandOption: FileCommandOption & { name: string }) {
  return class FileCommand extends Command {
    constructor() {
      super();
      this.id = commandOption.id;
      this.name = commandOption.name;
    }

    protected async doCommandRun(...args) {
      if (
        (this.id === COMMAND_UPLOAD_FILE_TO_ALL_PROFILES ||
          this.id === COMMAND_UPLOAD_FOLDER_TO_ALL_PROFILES) &&
        !(await confirmUploadToAllProfiles())
      ) {
        return;
      }

      const target = await commandOption.getFileTarget(...args);
      if (!target) {
        logger.warn(`The "${this.name}" command get canceled because of missing targets.`);
        return;
      }

      const targetList: Uri[] = Array.isArray(target) ? target : [target];
      const pendingTasks = targetList.map(async uri => {
        try {
          await commandOption.handleFile(handleCtxFromUri(uri));
        } catch (error) {
          reportError(error);
        }
      });

      await Promise.all(pendingTasks);
    }
  };
}

export function createFileMultiCommand(commandOption: FileCommandOption & { name: string }) {
  return class FileCommand extends Command {
    constructor() {
      super();
      this.id = commandOption.id;
      this.name = commandOption.name;
    }

    protected async doCommandRun(...args) {
      if (
        (this.id === COMMAND_UPLOAD_FILE_TO_ALL_PROFILES ||
          this.id === COMMAND_UPLOAD_FOLDER_TO_ALL_PROFILES) &&
        !(await confirmUploadToAllProfiles())
      ) {
        return;
      }

      const target = await commandOption.getFileTarget(...args);
      if (!target) {
        logger.warn(`The "${this.name}" command get canceled because of missing targets.`);
        return;
      }

      const targetList: Uri[] = Array.isArray(target) ? target : [target];
      const pendingTasks = targetList.map(async uri => {
        try {
          await Promise.all(allHandleCtxFromUri(uri).map(commandOption.handleFile));
        } catch (error) {
          reportError(error);
        }
      });

      await Promise.all(pendingTasks);
    }
  };
}
