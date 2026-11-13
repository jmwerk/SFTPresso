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
import { detectAgentCandidates } from './sshAgentDetect';
import { ConnectIdentity, storePassphrase } from '../credentialStore';
import {
  createFileService,
  disposeFileService,
  findAllFileService,
  reconcileActiveProfile,
} from './serviceManager';
import { InputStep, MultiStepInput } from './multiStepInput';
import { omitInherited } from '../core/mergeProfile';

const AUTH_PASSWORD = 'Password';
const AUTH_PRIVATE_KEY = 'Private Key';
const AUTH_AGENT = 'SSH Agent';

function authLabel(method: string | undefined): string {
  if (method === AUTH_PRIVATE_KEY) return vscode.l10n.t('Private Key');
  if (method === AUTH_AGENT) return vscode.l10n.t('SSH Agent');
  return vscode.l10n.t('Password');
}

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
  // Add Profile: the profile name is asked up front and the site name is inherited
  isProfile?: boolean;
}

// A single field-collecting step (host/port/username/auth) is shared between
// the primary connection and an optional jump host -- this target says which
// HostAuthState a shared step should read/write and how to label it.
interface HostAuthTarget {
  state: HostAuthState;
  title: (text: string) => string;
  defaultPort: number;
  usernameDefault: string;
  basePath: string;
}

function mainTarget(wizard: WizardState): HostAuthTarget {
  return {
    state: wizard.connection,
    title: text => text,
    defaultPort: wizard.protocol === 'ftp' ? 21 : 22,
    usernameDefault: defaultUsername(),
    basePath: wizard.basePath,
  };
}

function hopTarget(wizard: WizardState): HostAuthTarget {
  return {
    state: wizard.hop,
    title: text => vscode.l10n.t('Jump Host — {0}', text),
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

  if (!wizard.isProfile) {
    plan.push('name');
  }
  plan.push('review');
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
      title: target.title(vscode.l10n.t('Host')),
      step,
      totalSteps,
      value: target.state.host || '',
      prompt: vscode.l10n.t('Host'),
      placeholder: 'example.com',
      validate: v => (v.trim() ? undefined : vscode.l10n.t('Host is required.')),
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
      title: target.title(vscode.l10n.t('Port')),
      step,
      totalSteps,
      value: String(target.state.port ?? target.defaultPort),
      prompt: vscode.l10n.t('Port'),
      validate: v => {
        const num = Number(v.trim());
        return Number.isInteger(num) && num >= 1 && num <= 65535
          ? undefined
          : vscode.l10n.t('Port must be an integer between 1 and 65535.');
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
      title: target.title(vscode.l10n.t('Username')),
      step,
      totalSteps,
      value: target.state.username ?? target.usernameDefault,
      prompt: vscode.l10n.t('Username'),
      validate: v => (v.trim() ? undefined : vscode.l10n.t('Username is required.')),
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
      {
        label: authLabel(AUTH_PASSWORD),
        description: vscode.l10n.t('Prompt for the password when connecting'),
        value: AUTH_PASSWORD,
      },
      {
        label: authLabel(AUTH_PRIVATE_KEY),
        description: vscode.l10n.t('Authenticate with a private key file'),
        value: AUTH_PRIVATE_KEY,
      },
      {
        label: authLabel(AUTH_AGENT),
        description: vscode.l10n.t('Authenticate through a running ssh-agent'),
        value: AUTH_AGENT,
      },
    ];
    const active =
      items.find(i => i.value === (target.state.authMethod || defaults.authMethod)) || items[0];
    const picked = await input.showQuickPick({
      title: target.title(vscode.l10n.t('Authentication Method')),
      step,
      totalSteps,
      items,
      activeItem: active,
      placeholder: vscode.l10n.t('Select an authentication method'),
    });
    target.state.authMethod = picked.value;
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
      title: target.title(vscode.l10n.t('Private Key Path')),
      step,
      totalSteps,
      value: target.state.privateKeyPath || '~/.ssh/id_rsa',
      prompt: vscode.l10n.t('Private key path ("~" points to your home folder)'),
      validate: v => {
        if (!v.trim()) {
          return vscode.l10n.t('Private key path is required.');
        }
        const keyPath = path.resolve(target.basePath, replaceHomePath(v.trim()));
        return fse.existsSync(keyPath)
          ? undefined
          : vscode.l10n.t('No file found at {0}.', keyPath);
      },
    });
    target.state.privateKeyPath = value.trim();
    return next();
  };
}

async function promptAgentManually(
  input: MultiStepInput,
  wizard: WizardState,
  target: HostAuthTarget,
  planKey: string
): Promise<string> {
  const { step, totalSteps } = stepInfo(wizard, planKey);
  const value = await input.showInputBox({
    title: target.title(vscode.l10n.t('SSH Agent')),
    step,
    totalSteps,
    value: target.state.agent || (process.platform === 'win32' ? 'pageant' : '$SSH_AUTH_SOCK'),
    prompt: vscode.l10n.t('SSH agent socket ("$VARNAME" reads from an environment variable)'),
    validate: v => (v.trim() ? undefined : vscode.l10n.t('Agent is required.')),
  });
  return value.trim();
}

function stepAgentManual(
  wizard: WizardState,
  target: HostAuthTarget,
  planKey: string,
  next: () => InputStep
): InputStep {
  return async input => {
    target.state.agent = await promptAgentManually(input, wizard, target, planKey);
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
    const candidates = await detectAgentCandidates();
    if (candidates.length === 0) {
      target.state.agent = await promptAgentManually(input, wizard, target, planKey);
      return next();
    }

    const { step, totalSteps } = stepInfo(wizard, planKey);
    const items: (vscode.QuickPickItem & { value?: string })[] = [
      ...candidates.map(c => ({ label: c.label, description: c.description, value: c.value })),
      { label: vscode.l10n.t('$(edit) Enter manually...'), description: '' },
    ];
    const activeItem = items.find(i => i.value === target.state.agent) || items[0];
    const picked = await input.showQuickPick({
      title: target.title(vscode.l10n.t('SSH Agent')),
      step,
      totalSteps,
      items,
      activeItem,
      placeholder: vscode.l10n.t('Select a detected SSH agent, or enter one manually'),
    });

    if (picked.value !== undefined) {
      target.state.agent = picked.value;
      return next();
    }
    // a separate step, so Back from the manual box returns here rather than
    // skipping past the dropdown entirely
    return stepAgentManual(wizard, target, planKey, next);
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
      { label: vscode.l10n.t('No passphrase'), value: 'none' },
      { label: vscode.l10n.t('Prompt each time I connect'), value: 'prompt' },
      {
        label: vscode.l10n.t('Enter now (saved to secret storage, never written to sftp.json)'),
        value: 'enter',
      },
    ];
    const active = items.find(i => i.value === (target.state.passphraseChoice || 'none'));
    const picked = await input.showQuickPick({
      title: target.title(vscode.l10n.t('Key Passphrase')),
      step,
      totalSteps,
      items,
      activeItem: active,
      placeholder: vscode.l10n.t('Does this key have a passphrase?'),
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
      title: target.title(vscode.l10n.t('Passphrase')),
      step,
      totalSteps,
      value: '',
      prompt: vscode.l10n.t('Passphrase'),
      password: true,
      validate: v =>
        v
          ? undefined
          : vscode.l10n.t('Passphrase is required, or go back and pick a different option.'),
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
      { label: 'sftp', description: vscode.l10n.t('SSH File Transfer Protocol (default port 22)') },
      { label: 'ftp', description: vscode.l10n.t('File Transfer Protocol (default port 21)') },
    ];
    const active = items.find(i => i.label === (wizard.protocol || defaults.protocol)) || items[0];
    const picked = await input.showQuickPick({
      title: wizard.isProfile
        ? vscode.l10n.t('New Profile')
        : vscode.l10n.t('New SFTP/FTP Connection'),
      step,
      totalSteps,
      items,
      activeItem: active,
      placeholder: vscode.l10n.t('Select the transfer protocol'),
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
      title: vscode.l10n.t('Remote Path'),
      step,
      totalSteps,
      value: wizard.remotePath ?? '/',
      prompt: vscode.l10n.t('Remote path to sync with this folder'),
      validate: v => (v.trim() ? undefined : vscode.l10n.t('Remote path is required.')),
    });
    wizard.remotePath = value.trim();
    return stepUploadOnSave(wizard);
  };
}

function stepUploadOnSave(wizard: WizardState): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, 'uploadOnSave');
    const items = [
      {
        label: vscode.l10n.t('No'),
        description: vscode.l10n.t('Upload files manually'),
        value: false,
      },
      {
        label: vscode.l10n.t('Yes'),
        description: vscode.l10n.t('Upload a file every time it is saved'),
        value: true,
      },
    ];
    const active = items.find(i => i.value === (wizard.uploadOnSave ?? false));
    const picked = await input.showQuickPick({
      title: vscode.l10n.t('Upload on Save'),
      step,
      totalSteps,
      items,
      activeItem: active,
      placeholder: vscode.l10n.t('Upload files automatically on save?'),
    });
    wizard.uploadOnSave = picked.value;
    return stepAdvancedGate(wizard);
  };
}

function stepAdvancedGate(wizard: WizardState): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, 'advancedGate');
    const items = [
      { label: vscode.l10n.t('No'), description: vscode.l10n.t('Use the defaults'), value: false },
      {
        label: vscode.l10n.t('Yes'),
        description: vscode.l10n.t(
          'Ignore patterns, sync behavior, transfer tuning, host key policy, jump host'
        ),
        value: true,
      },
    ];
    const active = items.find(i => i.value === (wizard.advancedOptions ?? false));
    const picked = await input.showQuickPick({
      title: vscode.l10n.t('Advanced Options'),
      step,
      totalSteps,
      items,
      activeItem: active,
      placeholder: vscode.l10n.t('Configure advanced options?'),
    });
    wizard.advancedOptions = picked.value;
    return picked.value ? stepIgnore(wizard) : stepName(wizard);
  };
}

function stepIgnore(wizard: WizardState): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, 'ignore');
    const value = await input.showInputBox({
      title: vscode.l10n.t('Ignore Patterns'),
      step,
      totalSteps,
      value: (wizard.ignore || []).join(', '),
      prompt: vscode.l10n.t('Comma-separated patterns to skip during transfers (optional)'),
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
        description: vscode.l10n.t('Delete remote files that no longer exist locally during sync'),
        key: 'delete',
      },
      {
        label: 'skipCreate',
        description: vscode.l10n.t(
          'Never create new files/folders on the target, only update existing ones'
        ),
        key: 'skipCreate',
      },
      {
        label: 'ignoreExisting',
        description: vscode.l10n.t('Skip files that already exist on the target'),
        key: 'ignoreExisting',
      },
      {
        label: 'update',
        description: vscode.l10n.t('Only overwrite files older than the source'),
        key: 'update',
      },
    ];
    const selectedItems = items.filter(i => wizard.syncOption && wizard.syncOption[i.key]);
    const picked = await input.showQuickPickMany({
      title: vscode.l10n.t('Sync Options'),
      step,
      totalSteps,
      items,
      selectedItems,
      placeholder: vscode.l10n.t(
        'Select sync behaviors to enable (used by the SFTP: Sync commands)'
      ),
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
        description: vscode.l10n.t(
          'Use parallel-chunk transfer for large files automatically (recommended)'
        ),
        value: 'auto',
      },
      {
        label: 'stream',
        description: vscode.l10n.t('Always use the classic single-pipe transfer'),
        value: 'stream',
      },
      {
        label: 'parallel',
        description: vscode.l10n.t(
          'Force chunked parallel transfer regardless of file size (SFTP only)'
        ),
        value: 'parallel',
      },
    ];
    const active = items.find(i => i.value === (wizard.transferMode || 'auto'));
    const picked = await input.showQuickPick({
      title: vscode.l10n.t('Transfer Mode'),
      step,
      totalSteps,
      items,
      activeItem: active,
      placeholder: vscode.l10n.t('How should file transfers be handled?'),
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
      title: vscode.l10n.t('Concurrency'),
      step,
      totalSteps,
      value: String(wizard.concurrency ?? 4),
      prompt: vscode.l10n.t('Number of files to transfer in parallel'),
      validate: v => {
        const num = Number(v.trim());
        return Number.isInteger(num) && num >= 1
          ? undefined
          : vscode.l10n.t('Concurrency must be a positive integer.');
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
        description: vscode.l10n.t('Prompt with the fingerprint the first time a host is seen'),
        value: 'ask',
      },
      {
        label: 'accept-new',
        description: vscode.l10n.t(
          "Accept an unknown host automatically, refuse a key that changed (this extension's overall default)"
        ),
        value: 'accept-new',
      },
      {
        label: vscode.l10n.t('true (strict)'),
        description: vscode.l10n.t('Refuse any host not already in a known_hosts file'),
        value: true,
      },
      {
        label: vscode.l10n.t('false (skip — not recommended)'),
        description: vscode.l10n.t('Never verify the host key'),
        value: false,
      },
    ];
    const active = items.find(i => i.value === (wizard.strictHostKeyChecking ?? 'ask'));
    const picked = await input.showQuickPick({
      title: vscode.l10n.t('Host Key Checking'),
      step,
      totalSteps,
      items,
      activeItem: active,
      placeholder: vscode.l10n.t('How should an unknown or changed SSH host key be handled?'),
    });
    wizard.strictHostKeyChecking = picked.value;
    return stepHopGate(wizard);
  };
}

function stepHopGate(wizard: WizardState): InputStep {
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, 'hopGate');
    const items = [
      { label: vscode.l10n.t('No'), description: vscode.l10n.t('Connect directly'), value: false },
      {
        label: vscode.l10n.t('Yes'),
        description: vscode.l10n.t('Connect through an intermediate SSH host (bastion)'),
        value: true,
      },
    ];
    const active = items.find(i => i.value === (wizard.hopEnabled ?? false));
    const picked = await input.showQuickPick({
      title: vscode.l10n.t('Jump Host'),
      step,
      totalSteps,
      items,
      activeItem: active,
      placeholder: vscode.l10n.t('Connect through a jump host (bastion)?'),
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
  return stepAuthMethod(wizard, hopTarget(wizard), 'hopAuthMethod', () =>
    afterHopAuthMethod(wizard)
  );
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
  if (wizard.isProfile) {
    return stepReview(wizard);
  }
  return async input => {
    const { step, totalSteps } = stepInfo(wizard, 'name');
    const value = await input.showInputBox({
      title: vscode.l10n.t('Connection Name'),
      step,
      totalSteps,
      value: wizard.name || wizard.connection.host || vscode.l10n.t('My Server'),
      prompt: vscode.l10n.t('A friendly name shown in the Remote Explorer and status bar'),
      validate: v => (v.trim() ? undefined : vscode.l10n.t('Name is required.')),
    });
    wizard.name = value.trim();
    return stepReview(wizard);
  };
}

function summarizeConnection(auth: HostAuthState, protocol?: string): string {
  let authSummary = '';
  if (protocol === 'sftp') {
    if (auth.authMethod === AUTH_PRIVATE_KEY) {
      authSummary = vscode.l10n.t('key: {0}', String(auth.privateKeyPath));
    } else if (auth.authMethod === AUTH_AGENT) {
      authSummary = vscode.l10n.t('agent: {0}', String(auth.agent));
    } else {
      authSummary = vscode.l10n.t('password (prompted)');
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
      {
        label: wizard.isProfile
          ? vscode.l10n.t('$(check) Looks good, create the profile')
          : vscode.l10n.t('$(check) Looks good, create the connection'),
        description: '',
      },
      {
        label: vscode.l10n.t('Connection'),
        description: summarizeConnection(wizard.connection, wizard.protocol),
        jump: () => stepHost(wizard, mainTarget(wizard), 'host', () => afterHost(wizard)),
      },
      {
        label: vscode.l10n.t('Remote Path'),
        description: wizard.remotePath,
        jump: () => stepRemotePath(wizard),
      },
      {
        label: vscode.l10n.t('Upload on Save'),
        description: wizard.uploadOnSave ? vscode.l10n.t('Yes') : vscode.l10n.t('No'),
        jump: () => stepUploadOnSave(wizard),
      },
      {
        label: vscode.l10n.t('Advanced Options'),
        description: wizard.advancedOptions
          ? vscode.l10n.t('Configured')
          : vscode.l10n.t('Defaults'),
        jump: () => stepAdvancedGate(wizard),
      },
    ];
    if (wizard.advancedOptions && wizard.hopEnabled) {
      items.push({
        label: vscode.l10n.t('Jump Host'),
        description: summarizeConnection(wizard.hop, 'sftp'),
        jump: () => stepHost(wizard, hopTarget(wizard), 'hopHost', () => afterHopHost(wizard)),
      });
    }
    if (!wizard.isProfile) {
      items.push({
        label: vscode.l10n.t('Name'),
        description: wizard.name,
        jump: () => stepName(wizard),
      });
    }

    const picked = await input.showQuickPick({
      title: vscode.l10n.t('Review'),
      step,
      totalSteps,
      items,
      placeholder: vscode.l10n.t('Review the connection, or select a field to edit it'),
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

function hostAuthStateFromConfig(config: any): HostAuthState {
  let authMethod: string | undefined;
  if (config.privateKeyPath) {
    authMethod = AUTH_PRIVATE_KEY;
  } else if (config.agent) {
    authMethod = AUTH_AGENT;
  } else if (config.host) {
    authMethod = AUTH_PASSWORD;
  }
  return {
    host: config.host,
    port: config.port,
    username: config.username,
    authMethod,
    privateKeyPath: config.privateKeyPath,
    agent: config.agent,
    // a literal passphrase in sftp.json is left alone: the profile inherits it
    passphraseChoice: config.passphrase === true ? 'prompt' : undefined,
  };
}

// Starts a new profile from the base config's answers, so only what differs needs typing.
// Advanced options aren't prefilled: left at "No", the profile simply inherits them.
function wizardStateFromBase(basePath: string, base: any): WizardState {
  return {
    basePath,
    protocol: base.protocol,
    connection: hostAuthStateFromConfig(base),
    name: base.name,
    remotePath: base.remotePath,
    uploadOnSave: base.uploadOnSave,
    strictHostKeyChecking: base.strictHostKeyChecking,
    hop: {},
    isProfile: true,
  };
}

function buildConfigFromState(wizard: WizardState): any {
  const config: any = {
    name: wizard.name,
    protocol: wizard.protocol,
    ...buildHostAuthConfig(wizard.connection, wizard.basePath),
    remotePath: wizard.remotePath,
    uploadOnSave: wizard.uploadOnSave,
  };

  // A profile left unset inherits the base config's policy instead of being made stricter.
  if (
    wizard.protocol === 'sftp' &&
    !(wizard.isProfile && wizard.strictHostKeyChecking === undefined)
  ) {
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
      identity: {
        protocol: wizard.protocol,
        host: config.host,
        port: config.port,
        username: config.username,
      },
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
      identity: {
        protocol: 'sftp',
        host: config.hop.host,
        port: config.hop.port,
        username: config.hop.username,
      },
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
      vscode.l10n.t(
        '{0} saved and connected successfully to {1}:{2}.',
        describeTarget,
        serviceConfig.host,
        String(serviceConfig.port)
      )
    );
    await showTextDocument(vscode.Uri.file(configPath));
    return 'done';
  }

  const retry = vscode.l10n.t('Retry Wizard');
  const editJson = vscode.l10n.t('Edit JSON');
  const choice = await showErrorMessage(
    vscode.l10n.t(
      "{0} saved, but couldn't connect to {1}:{2}: {3}",
      describeTarget,
      serviceConfig.host,
      String(serviceConfig.port),
      result.error.message
    ),
    retry,
    editJson,
    vscode.l10n.t('Keep As Is')
  );
  if (choice === retry) {
    return 'retry';
  }
  if (choice === editJson) {
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
        showErrorMessage(vscode.l10n.t('Config is invalid: {0}', validationError.message));
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

      const outcome = await presentTestResult(
        service,
        serviceConfig,
        configPath,
        vscode.l10n.t('Config')
      );
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

// What a new profile writes: only what differs from the base config. The wizard stores key
// paths resolved, so a base "~/.ssh/id_rsa" pointing at the same file still counts as equal.
function profileConfig(config: any, base: any, basePath: string): any {
  const comparable = { ...config };
  if (
    base.privateKeyPath &&
    comparable.privateKeyPath === path.resolve(basePath, replaceHomePath(base.privateKeyPath))
  ) {
    comparable.privateKeyPath = base.privateKeyPath;
  }
  return omitInherited(comparable, base);
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
      prompt: vscode.l10n.t('Profile name'),
      placeHolder: 'staging',
      ignoreFocusOut: true,
      validateInput: value => {
        const trimmed = value.trim();
        if (!trimmed) return vscode.l10n.t('Profile name is required.');
        if (existingProfiles.has(trimmed)) {
          return vscode.l10n.t('Profile "{0}" already exists.', trimmed);
        }
        return undefined;
      },
    });
    if (profileName === undefined) {
      return;
    }
    const name = profileName.trim();

    const wizard = wizardStateFromBase(basePath, rootConfig);
    let entry: InputStep = stepProtocol(wizard);

    for (;;) {
      const completed = await MultiStepInput.run(entry);
      if (!completed) {
        return;
      }

      const config = buildConfigFromState(wizard);
      const validationError = validateConfig(config);
      if (validationError) {
        showErrorMessage(vscode.l10n.t('Config is invalid: {0}', validationError.message));
        entry = stepReview(wizard);
        continue;
      }

      // edits just the new profile's span, leaving the rest of the file --
      // including any comments -- untouched. Only what differs from the base
      // config is written; the rest is inherited.
      await setConfigValueAtPath(
        configPath,
        ['profiles', name],
        profileConfig(config, rootConfig, basePath)
      );
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
        showInformationMessage(
          vscode.l10n.t('Profile "{0}" added. Switch to it with "SFTP: Set Profile".', name)
        );
      }

      const outcome = await presentTestResult(
        service,
        serviceConfig,
        configPath,
        vscode.l10n.t('Profile "{0}"', name)
      );
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
