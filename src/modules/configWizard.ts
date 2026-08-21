import * as vscode from 'vscode';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import app from '../app';
import { FileService, ServiceConfig } from '../core';
import { replaceHomePath, reportError } from '../helper';
import { showErrorMessage, showInformationMessage, showTextDocument } from '../host';
import { getConfigPath, readConfigsFromFile, setConfigValueAtPath, validateConfig } from './config';
import { testConnection } from './connectionTest';
import { ConnectIdentity, storePassphrase } from '../credentialStore';
import {
  createFileService,
  disposeFileService,
  findAllFileService,
  reconcileActiveProfile,
} from './serviceManager';
import { InputStep, MultiStepInput } from './multiStepInput';

const AUTH_PASSWORD = 'Password';
const AUTH_PRIVATE_KEY = 'Private Key';
const AUTH_AGENT = 'SSH Agent';

// Remembers the last answers to a few high-friction questions across runs of
// the wizard (not host/username -- those are per-server, not worth reusing).
const WIZARD_DEFAULTS_KEY = 'sftp.configWizard.lastDefaults';

interface WizardDefaults {
  protocol?: 'sftp' | 'ftp';
  authMethod?: string;
}

function getWizardDefaults(): WizardDefaults {
  return app.vscodeContext
    ? app.vscodeContext.globalState.get<WizardDefaults>(WIZARD_DEFAULTS_KEY, {})
    : {};
}

function saveWizardDefaults(defaults: WizardDefaults) {
  if (app.vscodeContext) {
    app.vscodeContext.globalState.update(WIZARD_DEFAULTS_KEY, defaults);
  }
}

function defaultUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

// -- wizard state --------------------------------------------------------

interface HostAuthState {
  host?: string;
  port?: number;
  username?: string;
  authMethod?: string;
  privateKeyPath?: string;
  agent?: string;
  passphraseChoice?: 'none' | 'prompt' | 'enter';
  passphraseValue?: string;
}

interface SyncOptionState {
  delete: boolean;
  skipCreate: boolean;
  ignoreExisting: boolean;
  update: boolean;
}

interface WizardState {
  basePath: string;
  protocol?: 'sftp' | 'ftp';
  connection: HostAuthState;
  name?: string;
  remotePath?: string;
  uploadOnSave?: boolean;
  advancedOptions?: boolean;
  strictHostKeyChecking?: boolean | 'ask' | 'accept-new';
  ignore?: string[];
  syncOption?: SyncOptionState;
  transferMode?: 'auto' | 'parallel' | 'stream';
  concurrency?: number;
  hopEnabled?: boolean;
  hop: HostAuthState;
}

// A single field-collecting step (host/port/username/auth) is shared between
// the primary connection and an optional jump host -- this target says which
// HostAuthState a shared step should read/write and how to label it.
interface HostAuthTarget {
  state: HostAuthState;
  titlePrefix: string;
  defaultPort: number;
  usernameDefault: string;
  basePath: string;
}

function mainTarget(wizard: WizardState): HostAuthTarget {
  return {
    state: wizard.connection,
    titlePrefix: '',
    defaultPort: wizard.protocol === 'ftp' ? 21 : 22,
    usernameDefault: defaultUsername(),
    basePath: wizard.basePath,
  };
}

function hopTarget(wizard: WizardState): HostAuthTarget {
  return {
    state: wizard.hop,
    titlePrefix: 'Jump Host — ',
    defaultPort: 22,
    usernameDefault: '',
    basePath: wizard.basePath,
  };
}

// Every step this wizard run will show, in order, given the answers so far --
// the single source of truth for each step's "Step X of Y" display. Steps
// inside a branch that hasn't been reached yet (e.g. the jump host questions,
// before the user has said yes to a jump host) simply aren't in the list, so
// the total changes live as the user answers gating questions -- same as the
// upstream VS Code multi-step-input sample.
function computeStepPlan(wizard: WizardState): string[] {
  const plan: string[] = ['protocol', 'host', 'port', 'username'];

  if (wizard.protocol === 'sftp') {
    plan.push('authMethod');
    if (wizard.connection.authMethod === AUTH_PRIVATE_KEY) {
      plan.push('privateKeyPath', 'passphrase');
    } else if (wizard.connection.authMethod === AUTH_AGENT) {
      plan.push('agent');
    }
  }

  plan.push('remotePath', 'uploadOnSave', 'advancedGate');

  if (wizard.advancedOptions) {
    plan.push('ignore', 'syncOption', 'transferMode');
    if (wizard.transferMode && wizard.transferMode !== 'auto') {
      plan.push('concurrency');
    }
    if (wizard.protocol === 'sftp') {
      plan.push('strictHostKeyChecking', 'hopGate');
      if (wizard.hopEnabled) {
        plan.push('hopHost', 'hopPort', 'hopUsername', 'hopAuthMethod');
        if (wizard.hop.authMethod === AUTH_PRIVATE_KEY) {
          plan.push('hopPrivateKeyPath', 'hopPassphrase');
        } else if (wizard.hop.authMethod === AUTH_AGENT) {
          plan.push('hopAgent');
        }
      }
    }
  }

  plan.push('name', 'review');
  return plan;
}

function stepInfo(wizard: WizardState, key: string): { step: number; totalSteps: number } {
  const plan = computeStepPlan(wizard);
  const index = plan.indexOf(key);
  return { step: index >= 0 ? index + 1 : plan.length, totalSteps: plan.length };
}

// -- shared host/port/username/auth steps (used for both the primary
// connection and an optional jump host) ---------------------------------

function stepHost(
  wizard: WizardState,
  target: HostAuthTarget,
  planKey: string,
  next: () => InputStep
): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, planKey);
    const value = await input.showInputBox({
      title: `${target.titlePrefix}Host`,
      step,
      totalSteps,
      value: target.state.host || '',
      prompt: 'Host',
      placeholder: 'example.com',
      validate: v => (v.trim() ? undefined : 'Host is required.'),
    });
    target.state.host = value.trim();
    return next();
  };
}

function stepPort(
  wizard: WizardState,
  target: HostAuthTarget,
  planKey: string,
  next: () => InputStep
): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, planKey);
    const value = await input.showInputBox({
      title: `${target.titlePrefix}Port`,
      step,
      totalSteps,
      value: String(target.state.port ?? target.defaultPort),
      prompt: 'Port',
      validate: v => {
        const num = Number(v.trim());
        return Number.isInteger(num) && num >= 1 && num <= 65535
          ? undefined
          : 'Port must be an integer between 1 and 65535.';
      },
    });
    target.state.port = Number(value.trim());
    return next();
  };
}

function stepUsername(
  wizard: WizardState,
  target: HostAuthTarget,
  planKey: string,
  next: () => InputStep
): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, planKey);
    const value = await input.showInputBox({
      title: `${target.titlePrefix}Username`,
      step,
      totalSteps,
      value: target.state.username ?? target.usernameDefault,
      prompt: 'Username',
      validate: v => (v.trim() ? undefined : 'Username is required.'),
    });
    target.state.username = value.trim();
    return next();
  };
}

function stepAuthMethod(
  wizard: WizardState,
  target: HostAuthTarget,
  planKey: string,
  next: () => InputStep
): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, planKey);
    const defaults = getWizardDefaults();
    const items = [
      { label: AUTH_PASSWORD, description: 'Prompt for the password when connecting' },
      { label: AUTH_PRIVATE_KEY, description: 'Authenticate with a private key file' },
      { label: AUTH_AGENT, description: 'Authenticate through a running ssh-agent' },
    ];
    const active =
      items.find(i => i.label === (target.state.authMethod || defaults.authMethod)) || items[0];
    const picked = await input.showQuickPick({
      title: `${target.titlePrefix}Authentication Method`,
      step,
      totalSteps,
      items,
      activeItem: active,
      placeholder: 'Select an authentication method',
    });
    target.state.authMethod = picked.label;
    return next();
  };
}

function stepPrivateKeyPath(
  wizard: WizardState,
  target: HostAuthTarget,
  planKey: string,
  next: () => InputStep
): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, planKey);
    const value = await input.showInputBox({
      title: `${target.titlePrefix}Private Key Path`,
      step,
      totalSteps,
      value: target.state.privateKeyPath || '~/.ssh/id_rsa',
      prompt: 'Private key path ("~" points to your home folder)',
      validate: v => {
        if (!v.trim()) {
          return 'Private key path is required.';
        }
        const keyPath = path.resolve(target.basePath, replaceHomePath(v.trim()));
        return fse.existsSync(keyPath) ? undefined : `No file found at ${keyPath}.`;
      },
    });
    target.state.privateKeyPath = value.trim();
    return next();
  };
}

function stepAgent(
  wizard: WizardState,
  target: HostAuthTarget,
  planKey: string,
  next: () => InputStep
): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, planKey);
    const value = await input.showInputBox({
      title: `${target.titlePrefix}SSH Agent`,
      step,
      totalSteps,
      value: target.state.agent || (process.platform === 'win32' ? 'pageant' : '$SSH_AUTH_SOCK'),
      prompt: 'SSH agent socket ("$VARNAME" reads from an environment variable)',
      validate: v => (v.trim() ? undefined : 'Agent is required.'),
    });
    target.state.agent = value.trim();
    return next();
  };
}

function stepPassphrase(
  wizard: WizardState,
  target: HostAuthTarget,
  planKey: string,
  next: () => InputStep
): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, planKey);
    const items: (vscode.QuickPickItem & { value: 'none' | 'prompt' | 'enter' })[] = [
      { label: 'No passphrase', value: 'none' },
      { label: 'Prompt each time I connect', value: 'prompt' },
      { label: 'Enter now (saved to secret storage, never written to sftp.json)', value: 'enter' },
    ];
    const active = items.find(i => i.value === (target.state.passphraseChoice || 'none'));
    const picked = await input.showQuickPick({
      title: `${target.titlePrefix}Key Passphrase`,
      step,
      totalSteps,
      items,
      activeItem: active,
      placeholder: 'Does this key have a passphrase?',
    });
    target.state.passphraseChoice = picked.value;

    if (picked.value !== 'enter') {
      target.state.passphraseValue = undefined;
      return next();
    }
    // a separate step, so Back from the passphrase box returns here rather
    // than skipping past this choice entirely
    return stepPassphraseValue(wizard, target, planKey, next);
  };
}

function stepPassphraseValue(
  wizard: WizardState,
  target: HostAuthTarget,
  planKey: string,
  next: () => InputStep
): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, planKey);
    target.state.passphraseValue = await input.showInputBox({
      title: `${target.titlePrefix}Passphrase`,
      step,
      totalSteps,
      value: '',
      prompt: 'Passphrase',
      password: true,
      validate: v => (v ? undefined : 'Passphrase is required, or go back and pick a different option.'),
    });
    return next();
  };
}

// -- primary connection chain ---------------------------------------------

function stepProtocol(wizard: WizardState): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, 'protocol');
    const defaults = getWizardDefaults();
    const items = [
      { label: 'sftp', description: 'SSH File Transfer Protocol (default port 22)' },
      { label: 'ftp', description: 'File Transfer Protocol (default port 21)' },
    ];
    const active = items.find(i => i.label === (wizard.protocol || defaults.protocol)) || items[0];
    const picked = await input.showQuickPick({
      title: 'New SFTP/FTP Connection',
      step,
      totalSteps,
      items,
      activeItem: active,
      placeholder: 'Select the transfer protocol',
    });
    wizard.protocol = picked.label as 'sftp' | 'ftp';
    return stepHost(wizard, mainTarget(wizard), 'host', () => afterHost(wizard));
  };
}

function afterHost(wizard: WizardState): InputStep {
  return stepPort(wizard, mainTarget(wizard), 'port', () => afterPort(wizard));
}

function afterPort(wizard: WizardState): InputStep {
  return stepUsername(wizard, mainTarget(wizard), 'username', () => afterUsername(wizard));
}

function afterUsername(wizard: WizardState): InputStep {
  if (wizard.protocol === 'sftp') {
    return stepAuthMethod(wizard, mainTarget(wizard), 'authMethod', () => afterAuthMethod(wizard));
  }
  return stepRemotePath(wizard);
}

function afterAuthMethod(wizard: WizardState): InputStep {
  const method = wizard.connection.authMethod;
  if (method === AUTH_PRIVATE_KEY) {
    return stepPrivateKeyPath(wizard, mainTarget(wizard), 'privateKeyPath', () =>
      stepPassphrase(wizard, mainTarget(wizard), 'passphrase', () => stepRemotePath(wizard))
    );
  }
  if (method === AUTH_AGENT) {
    return stepAgent(wizard, mainTarget(wizard), 'agent', () => stepRemotePath(wizard));
  }
  return stepRemotePath(wizard);
}

function stepRemotePath(wizard: WizardState): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, 'remotePath');
    const value = await input.showInputBox({
      title: 'Remote Path',
      step,
      totalSteps,
      value: wizard.remotePath ?? '/',
      prompt: 'Remote path to sync with this folder',
      validate: v => (v.trim() ? undefined : 'Remote path is required.'),
    });
    wizard.remotePath = value.trim();
    return stepUploadOnSave(wizard);
  };
}

function stepUploadOnSave(wizard: WizardState): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, 'uploadOnSave');
    const items = [
      { label: 'No', description: 'Upload files manually', value: false },
      { label: 'Yes', description: 'Upload a file every time it is saved', value: true },
    ];
    const active = items.find(i => i.value === (wizard.uploadOnSave ?? false));
    const picked = await input.showQuickPick({
      title: 'Upload on Save',
      step,
      totalSteps,
      items,
      activeItem: active,
      placeholder: 'Upload files automatically on save?',
    });
    wizard.uploadOnSave = picked.value;
    return stepAdvancedGate(wizard);
  };
}

function stepAdvancedGate(wizard: WizardState): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, 'advancedGate');
    const items = [
      { label: 'No', description: 'Use the defaults', value: false },
      {
        label: 'Yes',
        description: 'Ignore patterns, sync behavior, transfer tuning, host key policy, jump host',
        value: true,
      },
    ];
    const active = items.find(i => i.value === (wizard.advancedOptions ?? false));
    const picked = await input.showQuickPick({
      title: 'Advanced Options',
      step,
      totalSteps,
      items,
      activeItem: active,
      placeholder: 'Configure advanced options?',
    });
    wizard.advancedOptions = picked.value;
    return picked.value ? stepIgnore(wizard) : stepName(wizard);
  };
}

function stepIgnore(wizard: WizardState): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, 'ignore');
    const value = await input.showInputBox({
      title: 'Ignore Patterns',
      step,
      totalSteps,
      value: (wizard.ignore || []).join(', '),
      prompt: 'Comma-separated patterns to skip during transfers (optional)',
      placeholder: 'node_modules, .git, dist',
      validate: () => undefined,
    });
    wizard.ignore = value
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    return stepSyncOption(wizard);
  };
}

function stepSyncOption(wizard: WizardState): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, 'syncOption');
    const items: (vscode.QuickPickItem & { key: keyof SyncOptionState })[] = [
      {
        label: 'delete',
        description: 'Delete remote files that no longer exist locally during sync',
        key: 'delete',
      },
      {
        label: 'skipCreate',
        description: 'Never create new files/folders on the target, only update existing ones',
        key: 'skipCreate',
      },
      {
        label: 'ignoreExisting',
        description: 'Skip files that already exist on the target',
        key: 'ignoreExisting',
      },
      {
        label: 'update',
        description: 'Only overwrite files older than the source',
        key: 'update',
      },
    ];
    const selectedItems = items.filter(i => wizard.syncOption && wizard.syncOption[i.key]);
    const picked = await input.showQuickPickMany({
      title: 'Sync Options',
      step,
      totalSteps,
      items,
      selectedItems,
      placeholder: 'Select sync behaviors to enable (used by the SFTP: Sync commands)',
    });
    const chosen = new Set(picked.map(i => i.key));
    wizard.syncOption = {
      delete: chosen.has('delete'),
      skipCreate: chosen.has('skipCreate'),
      ignoreExisting: chosen.has('ignoreExisting'),
      update: chosen.has('update'),
    };
    return stepTransferMode(wizard);
  };
}

function stepTransferMode(wizard: WizardState): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, 'transferMode');
    const items: (vscode.QuickPickItem & { value: 'auto' | 'parallel' | 'stream' })[] = [
      {
        label: 'auto',
        description: 'Use parallel-chunk transfer for large files automatically (recommended)',
        value: 'auto',
      },
      { label: 'stream', description: 'Always use the classic single-pipe transfer', value: 'stream' },
      {
        label: 'parallel',
        description: 'Force chunked parallel transfer regardless of file size (SFTP only)',
        value: 'parallel',
      },
    ];
    const active = items.find(i => i.value === (wizard.transferMode || 'auto'));
    const picked = await input.showQuickPick({
      title: 'Transfer Mode',
      step,
      totalSteps,
      items,
      activeItem: active,
      placeholder: 'How should file transfers be handled?',
    });
    wizard.transferMode = picked.value;
    if (picked.value === 'auto') {
      wizard.concurrency = undefined;
      return afterAdvancedTransfer(wizard);
    }
    return stepConcurrency(wizard);
  };
}

function stepConcurrency(wizard: WizardState): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, 'concurrency');
    const value = await input.showInputBox({
      title: 'Concurrency',
      step,
      totalSteps,
      value: String(wizard.concurrency ?? 4),
      prompt: 'Number of files to transfer in parallel',
      validate: v => {
        const num = Number(v.trim());
        return Number.isInteger(num) && num >= 1 ? undefined : 'Concurrency must be a positive integer.';
      },
    });
    wizard.concurrency = Number(value.trim());
    return afterAdvancedTransfer(wizard);
  };
}

function afterAdvancedTransfer(wizard: WizardState): InputStep {
  return wizard.protocol === 'sftp' ? stepStrictHostKeyChecking(wizard) : stepName(wizard);
}

function stepStrictHostKeyChecking(wizard: WizardState): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, 'strictHostKeyChecking');
    const items: (vscode.QuickPickItem & { value: boolean | 'ask' | 'accept-new' })[] = [
      {
        label: 'ask',
        description: 'Prompt with the fingerprint the first time a host is seen',
        value: 'ask',
      },
      {
        label: 'accept-new',
        description: "Accept an unknown host automatically, refuse a key that changed (this extension's overall default)",
        value: 'accept-new',
      },
      {
        label: 'true (strict)',
        description: 'Refuse any host not already in a known_hosts file',
        value: true,
      },
      {
        label: 'false (skip — not recommended)',
        description: 'Never verify the host key',
        value: false,
      },
    ];
    const active = items.find(i => i.value === (wizard.strictHostKeyChecking ?? 'ask'));
    const picked = await input.showQuickPick({
      title: 'Host Key Checking',
      step,
      totalSteps,
      items,
      activeItem: active,
      placeholder: 'How should an unknown or changed SSH host key be handled?',
    });
    wizard.strictHostKeyChecking = picked.value;
    return stepHopGate(wizard);
  };
}

function stepHopGate(wizard: WizardState): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, 'hopGate');
    const items = [
      { label: 'No', description: 'Connect directly', value: false },
      { label: 'Yes', description: 'Connect through an intermediate SSH host (bastion)', value: true },
    ];
    const active = items.find(i => i.value === (wizard.hopEnabled ?? false));
    const picked = await input.showQuickPick({
      title: 'Jump Host',
      step,
      totalSteps,
      items,
      activeItem: active,
      placeholder: 'Connect through a jump host (bastion)?',
    });
    wizard.hopEnabled = picked.value;
    if (!picked.value) {
      return stepName(wizard);
    }
    return stepHost(wizard, hopTarget(wizard), 'hopHost', () => afterHopHost(wizard));
  };
}

function afterHopHost(wizard: WizardState): InputStep {
  return stepPort(wizard, hopTarget(wizard), 'hopPort', () => afterHopPort(wizard));
}

function afterHopPort(wizard: WizardState): InputStep {
  return stepUsername(wizard, hopTarget(wizard), 'hopUsername', () => afterHopUsername(wizard));
}

function afterHopUsername(wizard: WizardState): InputStep {
  return stepAuthMethod(wizard, hopTarget(wizard), 'hopAuthMethod', () => afterHopAuthMethod(wizard));
}

function afterHopAuthMethod(wizard: WizardState): InputStep {
  const method = wizard.hop.authMethod;
  if (method === AUTH_PRIVATE_KEY) {
    return stepPrivateKeyPath(wizard, hopTarget(wizard), 'hopPrivateKeyPath', () =>
      stepPassphrase(wizard, hopTarget(wizard), 'hopPassphrase', () => stepName(wizard))
    );
  }
  if (method === AUTH_AGENT) {
    return stepAgent(wizard, hopTarget(wizard), 'hopAgent', () => stepName(wizard));
  }
  return stepName(wizard);
}

function stepName(wizard: WizardState): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, 'name');
    const value = await input.showInputBox({
      title: 'Connection Name',
      step,
      totalSteps,
      value: wizard.name || wizard.connection.host || 'My Server',
      prompt: 'A friendly name shown in the Remote Explorer and status bar',
      validate: v => (v.trim() ? undefined : 'Name is required.'),
    });
    wizard.name = value.trim();
    return stepReview(wizard);
  };
}

function summarizeConnection(auth: HostAuthState, protocol?: string): string {
  let authSummary = '';
  if (protocol === 'sftp') {
    if (auth.authMethod === AUTH_PRIVATE_KEY) {
      authSummary = `key: ${auth.privateKeyPath}`;
    } else if (auth.authMethod === AUTH_AGENT) {
      authSummary = `agent: ${auth.agent}`;
    } else {
      authSummary = 'password (prompted)';
    }
  }
  return `${auth.username}@${auth.host}:${auth.port}${authSummary ? ` (${authSummary})` : ''}`;
}

// Selecting a field here jumps back into that step; the chain then continues
// forward through every step after it (each pre-filled with the answer
// already given, so confirming them again is just pressing Enter) until
// review is reached again.
function stepReview(wizard: WizardState): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, 'review');
    type ReviewItem = vscode.QuickPickItem & { jump?: () => InputStep };

    const items: ReviewItem[] = [
      { label: '$(check) Looks good, create the connection', description: '' },
      {
        label: 'Connection',
        description: summarizeConnection(wizard.connection, wizard.protocol),
        jump: () => stepHost(wizard, mainTarget(wizard), 'host', () => afterHost(wizard)),
      },
      { label: 'Remote Path', description: wizard.remotePath, jump: () => stepRemotePath(wizard) },
      {
        label: 'Upload on Save',
        description: wizard.uploadOnSave ? 'Yes' : 'No',
        jump: () => stepUploadOnSave(wizard),
      },
      {
        label: 'Advanced Options',
        description: wizard.advancedOptions ? 'Configured' : 'Defaults',
        jump: () => stepAdvancedGate(wizard),
      },
    ];
    if (wizard.advancedOptions && wizard.hopEnabled) {
      items.push({
        label: 'Jump Host',
        description: summarizeConnection(wizard.hop, 'sftp'),
        jump: () => stepHost(wizard, hopTarget(wizard), 'hopHost', () => afterHopHost(wizard)),
      });
    }
    items.push({ label: 'Name', description: wizard.name, jump: () => stepName(wizard) });

    const picked = await input.showQuickPick({
      title: 'Review',
      step,
      totalSteps,
      items,
      placeholder: 'Review the connection, or select a field to edit it',
    });

    if (picked.jump) {
      return picked.jump();
    }
    // finished -- no next step
  };
}

// -- turning wizard state into an sftp.json config ------------------------

function buildHostAuthConfig(auth: HostAuthState, basePath: string): any {
  const out: any = {
    host: auth.host,
    port: auth.port,
    username: auth.username,
  };
  if (auth.authMethod === AUTH_PRIVATE_KEY) {
    out.privateKeyPath = path.resolve(basePath, replaceHomePath(auth.privateKeyPath!));
    // "enter now" is stored to secret storage by the caller and still uses
    // the prompt sentinel on disk, so a literal passphrase never lands in
    // sftp.json either way.
    if (auth.passphraseChoice === 'prompt' || auth.passphraseChoice === 'enter') {
      out.passphrase = true;
    }
  } else if (auth.authMethod === AUTH_AGENT) {
    out.agent = auth.agent;
  }
  return out;
}

function buildConfigFromState(wizard: WizardState): any {
  const config: any = {
    name: wizard.name,
    protocol: wizard.protocol,
    ...buildHostAuthConfig(wizard.connection, wizard.basePath),
    remotePath: wizard.remotePath,
    uploadOnSave: wizard.uploadOnSave,
  };

  if (wizard.protocol === 'sftp') {
    // Written explicitly rather than left to the default so a config created
    // today gets the stricter behaviour, and so the option is visible in the
    // file the user is about to read. "ask" rather than true: true refuses
    // any host not already in a known_hosts file, which a config the user has
    // just created for a host they have never connected to could never
    // satisfy.
    config.strictHostKeyChecking = wizard.strictHostKeyChecking ?? 'ask';
  }

  if (wizard.advancedOptions) {
    if (wizard.ignore && wizard.ignore.length > 0) {
      config.ignore = wizard.ignore;
    }
    if (wizard.syncOption) {
      config.syncOption = wizard.syncOption;
    }
    if (wizard.transferMode) {
      config.transferMode = wizard.transferMode;
    }
    if (wizard.concurrency !== undefined) {
      config.concurrency = wizard.concurrency;
    }
    if (wizard.protocol === 'sftp' && wizard.hopEnabled) {
      config.hop = buildHostAuthConfig(wizard.hop, wizard.basePath);
    }
  }

  return config;
}

interface PendingSecret {
  identity: ConnectIdentity;
  value: string;
}

function collectPendingSecrets(wizard: WizardState, config: any): PendingSecret[] {
  const secrets: PendingSecret[] = [];
  if (
    wizard.connection.authMethod === AUTH_PRIVATE_KEY &&
    wizard.connection.passphraseChoice === 'enter' &&
    wizard.connection.passphraseValue
  ) {
    secrets.push({
      identity: { protocol: wizard.protocol, host: config.host, port: config.port, username: config.username },
      value: wizard.connection.passphraseValue,
    });
  }
  if (
    wizard.advancedOptions &&
    wizard.hopEnabled &&
    wizard.hop.authMethod === AUTH_PRIVATE_KEY &&
    wizard.hop.passphraseChoice === 'enter' &&
    wizard.hop.passphraseValue
  ) {
    secrets.push({
      identity: { protocol: 'sftp', host: config.hop.host, port: config.hop.port, username: config.hop.username },
      value: wizard.hop.passphraseValue,
    });
  }
  return secrets;
}

// The file services are normally (re)created when sftp.json is saved from the
// editor. The wizard writes the file directly, so recreate them here to make
// the config usable (and testable) right away.
async function reloadFileServices(basePath: string, configPath: string): Promise<FileService[]> {
  findAllFileService(service => service.workspace === basePath).forEach(disposeFileService);

  const configs = await readConfigsFromFile(configPath);
  const services = configs.map(config => createFileService(config, basePath));
  reconcileActiveProfile();

  if (app.remoteExplorer) {
    app.remoteExplorer.refresh();
  }

  return services;
}

// Runs the connection test against a just-(re)created service and, on
// failure, offers to jump back into the review screen to fix whatever's
// wrong rather than leaving a config nobody has confirmed actually connects.
async function presentTestResult(
  service: FileService | undefined,
  serviceConfig: ServiceConfig | undefined,
  configPath: string,
  describeTarget: string
): Promise<'retry' | 'done'> {
  if (!service || !serviceConfig) {
    await showTextDocument(vscode.Uri.file(configPath));
    return 'done';
  }

  const result = await testConnection(service, serviceConfig);
  if (result.ok) {
    showInformationMessage(
      `${describeTarget} saved and connected successfully to ${serviceConfig.host}:${serviceConfig.port}.`
    );
    await showTextDocument(vscode.Uri.file(configPath));
    return 'done';
  }

  const choice = await showErrorMessage(
    `${describeTarget} saved, but couldn't connect to ${serviceConfig.host}:${serviceConfig.port}: ${result.error.message}`,
    'Retry Wizard',
    'Edit JSON',
    'Keep As Is'
  );
  if (choice === 'Retry Wizard') {
    return 'retry';
  }
  if (choice === 'Edit JSON') {
    await showTextDocument(vscode.Uri.file(configPath));
  }
  return 'done';
}

export async function quickSetupConfig(basePath: string) {
  try {
    const wizard: WizardState = { basePath, connection: {}, hop: {} };
    let entry: InputStep = stepProtocol(wizard);

    for (;;) {
      const completed = await MultiStepInput.run(entry);
      if (!completed) {
        return;
      }

      const config = buildConfigFromState(wizard);
      const validationError = validateConfig(config);
      if (validationError) {
        showErrorMessage(`Config is invalid: ${validationError.message}`);
        entry = stepReview(wizard);
        continue;
      }

      saveWizardDefaults({ protocol: wizard.protocol, authMethod: wizard.connection.authMethod });

      const configPath = getConfigPath(basePath);
      await fse.outputJson(configPath, config, { spaces: 4 });
      const services = await reloadFileServices(basePath, configPath);

      for (const secret of collectPendingSecrets(wizard, config)) {
        await storePassphrase(secret.identity, secret.value);
      }

      const service = services[0];
      let serviceConfig: ServiceConfig | undefined;
      try {
        serviceConfig = service && service.getConfig();
      } catch (error) {
        serviceConfig = undefined;
      }

      const outcome = await presentTestResult(service, serviceConfig, configPath, 'Config');
      if (outcome === 'retry') {
        entry = stepReview(wizard);
        continue;
      }
      return;
    }
  } catch (error) {
    reportError(error);
  }
}

export async function addProfileConfig(basePath: string) {
  try {
    const configPath = getConfigPath(basePath);
    // read as JSONC (comments/trailing commas allowed), same as every other
    // reader of sftp.json -- a plain JSON.parse would throw on a config that
    // uses either
    const [rootConfig] = await readConfigsFromFile(configPath);
    const existingProfiles = new Set(Object.keys(rootConfig.profiles || {}));

    const profileName = await vscode.window.showInputBox({
      prompt: 'Profile name',
      placeHolder: 'staging',
      ignoreFocusOut: true,
      validateInput: value => {
        const trimmed = value.trim();
        if (!trimmed) return 'Profile name is required.';
        if (existingProfiles.has(trimmed)) return `Profile "${trimmed}" already exists.`;
        return undefined;
      },
    });
    if (profileName === undefined) {
      return;
    }
    const name = profileName.trim();

    const wizard: WizardState = { basePath, connection: {}, hop: {} };
    let entry: InputStep = stepProtocol(wizard);

    for (;;) {
      const completed = await MultiStepInput.run(entry);
      if (!completed) {
        return;
      }

      const config = buildConfigFromState(wizard);
      const validationError = validateConfig(config);
      if (validationError) {
        showErrorMessage(`Config is invalid: ${validationError.message}`);
        entry = stepReview(wizard);
        continue;
      }

      // edits just the new profile's span, leaving the rest of the file --
      // including any comments -- untouched
      await setConfigValueAtPath(configPath, ['profiles', name], config);
      const services = await reloadFileServices(basePath, configPath);

      for (const secret of collectPendingSecrets(wizard, config)) {
        await storePassphrase(secret.identity, secret.value);
      }

      const service = services[0];
      let serviceConfig: ServiceConfig | undefined;
      try {
        serviceConfig = service && service.getConfig(name);
      } catch (error) {
        serviceConfig = undefined;
      }

      if (service && serviceConfig) {
        showInformationMessage(`Profile "${name}" added. Switch to it with "SFTP: Set Profile".`);
      }

      const outcome = await presentTestResult(service, serviceConfig, configPath, `Profile "${name}"`);
      if (outcome === 'retry') {
        entry = stepReview(wizard);
        continue;
      }
      return;
    }
  } catch (error) {
    reportError(error);
  }
}
