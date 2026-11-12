import { createHash } from 'crypto';
import app from '../app';
import { FileService, ServiceConfig } from '../core';
import { RemoteFileSystem } from '../core/fs';
import { SSHClient } from '../core/remote-client';
import { execCommand } from '../core/remote-client/exec';
import { shellQuote } from '../core/remote-client/shell';
import { isWorkspaceTrusted, showErrorMessage, showWarningMessage } from '../host';
import logger from '../logger';
import StatusBarItem from '../ui/statusBarItem';
import { show as showOutput, print } from '../ui/output';

export const DEFAULT_DELAY = 1000;
const DEFAULT_TIMEOUT = 60 * 1000;
const APPROVED_KEY = 'sftpresso.afterUpload.approved';

export interface AfterUploadOption {
  commands: string[];
  onSave: boolean;
  delay: number;
}

export interface UploadBatchOutcome {
  // files uploaded plus remote entries a sync deleted
  changed: number;
  failed: number;
  // upload on save or the file watcher, as opposed to a command the user ran
  automatic: boolean;
}

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  failed: number;
}

const pending = new Map<string, Pending>();

export function resolveAfterUpload(config: ServiceConfig): AfterUploadOption | undefined {
  const value = (config as any).afterUpload;
  if (!value) {
    return undefined;
  }

  const raw = typeof value === 'string' || Array.isArray(value) ? { command: value } : value;
  const commands = (Array.isArray(raw.command) ? raw.command : [raw.command]).filter(
    c => typeof c === 'string' && c.trim() !== ''
  );
  if (commands.length === 0) {
    return undefined;
  }

  return {
    commands,
    onSave: raw.onSave === true,
    delay: typeof raw.delay === 'number' ? raw.delay : DEFAULT_DELAY,
  };
}

function targetLabel(config: ServiceConfig): string {
  return config.port && config.port !== 22 ? `${config.host}:${config.port}` : config.host;
}

// Identifies "these commands on this server", so a change to either asks again.
function approvalId(config: ServiceConfig, option: AfterUploadOption): string {
  return createHash('sha256')
    .update([config.username, config.host, config.port, config.remotePath, ...option.commands].join('\n'))
    .digest('hex');
}

function isApproved(id: string): boolean {
  return (app.vscodeContext.workspaceState.get<string[]>(APPROVED_KEY) || []).includes(id);
}

function rememberApproval(id: string) {
  const approved = app.vscodeContext.workspaceState.get<string[]>(APPROVED_KEY) || [];
  app.vscodeContext.workspaceState.update(APPROVED_KEY, [...approved, id]);
}

// sftp.json comes from the workspace, so a cloned repo must not be able to run
// commands on a server just because a file was uploaded: ask once per command set.
async function confirmRun(config: ServiceConfig, option: AfterUploadOption): Promise<boolean> {
  const id = approvalId(config, option);
  if (isApproved(id)) {
    return true;
  }

  const choice = await showWarningMessage(
    `Run afterUpload on ${targetLabel(config)}? ${option.commands.join(' && ')}`,
    'Run',
    'Always Run',
    'Skip'
  );
  if (choice === 'Always Run') {
    rememberApproval(id);
  }
  return choice === 'Run' || choice === 'Always Run';
}

export function buildRemoteCommand(remotePath: string, command: string): string {
  return `cd ${shellQuote(remotePath)} && ${command}`;
}

async function runCommands(fileService: FileService, config: ServiceConfig, option: AfterUploadOption) {
  const label = targetLabel(config);
  if (config.protocol !== 'sftp') {
    logger.warn(`afterUpload skipped on ${label}: remote commands need SFTP, not ${config.protocol}`);
    return;
  }
  if (!isWorkspaceTrusted()) {
    logger.info(`afterUpload skipped on ${label}: workspace is not trusted`);
    app.sftpBarItem.updateStatus(StatusBarItem.Status.warn);
    return;
  }
  if (!(await confirmRun(config, option))) {
    logger.info(`afterUpload skipped on ${label}: not confirmed`);
    return;
  }

  let client;
  try {
    const fs = (await fileService.getRemoteFileSystem(config)) as RemoteFileSystem;
    client = fs.getClient();
  } catch (error) {
    showErrorMessage(`afterUpload: failed to connect to ${label}: ${error.message}`);
    return;
  }
  if (!(client instanceof SSHClient)) {
    return;
  }

  const timeout =
    typeof config.remoteCommandTimeout === 'number' ? config.remoteCommandTimeout : DEFAULT_TIMEOUT;
  const printChunk = (chunk: Buffer) => print(chunk.toString().replace(/\r?\n$/, ''));

  for (const command of option.commands) {
    print(`$ ${command}  (afterUpload, ${label})`);
    logger.info(`afterUpload on ${label}: ${command}`);
    let result;
    try {
      result = await execCommand(client.getRawClient(), buildRemoteCommand(config.remotePath, command), {
        timeout,
        closeStdin: true,
        onStdout: printChunk,
        onStderr: printChunk,
      });
    } catch (error) {
      logger.error(error, 'afterUpload');
      showErrorMessage(`afterUpload failed on ${label}: ${error.message}`);
      return;
    }

    if (result.timedOut || result.code !== 0) {
      const reason = result.timedOut ? `timed out after ${timeout}ms` : `exited with code ${result.code}`;
      print(`[${reason}]`);
      logger.warn(`afterUpload on ${label} ${reason}: ${command}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
      const choice = await showErrorMessage(`afterUpload on ${label} ${reason}: ${command}`, 'Show Output');
      if (choice === 'Show Output') {
        showOutput();
      }
      return;
    }
    print('[exit 0]');
  }

  app.sftpBarItem.showMsg('$(check) afterUpload', `afterUpload finished on ${label}`, 2000 * 2);
}

// Called after every upload batch. Bursts (a multi-file upload, Upload Changed
// Files, Save All) are coalesced into one run once uploads go quiet for `delay`.
export function reportUploadBatch(
  fileService: FileService,
  config: ServiceConfig,
  outcome: UploadBatchOutcome
) {
  const option = resolveAfterUpload(config);
  if (!option || (outcome.automatic && !option.onSave)) {
    return;
  }
  if (outcome.changed === 0 && outcome.failed === 0) {
    return;
  }

  const key = `${fileService.id}\n${approvalId(config, option)}`;
  const entry = pending.get(key);
  const failed = (entry ? entry.failed : 0) + outcome.failed;
  if (entry) {
    clearTimeout(entry.timer);
  }

  const timer = setTimeout(() => {
    pending.delete(key);
    if (failed > 0) {
      const files = failed === 1 ? 'upload' : 'uploads';
      logger.warn(`afterUpload skipped on ${targetLabel(config)}: ${failed} ${files} failed`);
      showWarningMessage(`afterUpload skipped on ${targetLabel(config)}: ${failed} ${files} failed.`);
      return;
    }
    runCommands(fileService, config, option).catch(error => logger.error(error, 'afterUpload'));
  }, option.delay);
  pending.set(key, { timer, failed });
}

// For tests and deactivation: drop runs that haven't started.
export function cancelPendingAfterUpload() {
  pending.forEach(entry => clearTimeout(entry.timer));
  pending.clear();
}
