import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface AgentCandidate {
  label: string;
  description: string;
  value: string;
}

function isSocket(candidatePath: string): boolean {
  try {
    return fs.statSync(candidatePath).isSocket();
  } catch {
    return false;
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function findMatching(dir: string, pattern: RegExp): string[] {
  return listDir(dir)
    .filter(name => pattern.test(name))
    .map(name => path.join(dir, name));
}

// The directories a per-boot launchd agent socket can land in -- this has
// moved across macOS versions (/private/var/run currently, /private/tmp on
// older releases). Overridable so tests can point it at a real temp
// directory instead of the real, version-dependent system paths.
const DARWIN_LAUNCHD_ROOTS = ['/private/var/run', '/private/tmp'];

// Every well-known SSH agent socket this can find without shelling out or
// adding a native dependency. GUI apps on macOS/Linux frequently don't
// inherit $SSH_AUTH_SOCK from the user's shell session -- which is the whole
// reason a user setting up a config from inside VS Code can't just read it
// off their own environment.
export async function detectAgentCandidates(
  darwinLaunchdRoots: string[] = DARWIN_LAUNCHD_ROOTS
): Promise<AgentCandidate[]> {
  if (process.platform === 'win32') {
    return detectWindowsAgents();
  }

  const candidates: AgentCandidate[] = [];
  const seen = new Set<string>();
  const add = (value: string, label: string, description: string) => {
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    candidates.push({ label, description, value });
  };

  const envSock = process.env.SSH_AUTH_SOCK;
  if (envSock && isSocket(envSock)) {
    add(envSock, '$SSH_AUTH_SOCK', envSock);
  }

  const home = os.homedir();
  const wellKnown: Array<[string, string, string]> = [
    [
      path.join(home, 'Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock'),
      '1Password',
      'macOS 1Password SSH agent',
    ],
    [path.join(home, '.1password/agent.sock'), '1Password', 'Linux 1Password SSH agent'],
    [path.join(home, '.gnupg/S.gpg-agent.ssh'), 'GPG Agent', 'gpg-agent with SSH support enabled'],
  ];
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined) {
    wellKnown.push([`/run/user/${uid}/keyring/ssh`, 'GNOME Keyring', 'gnome-keyring SSH agent']);
  }
  for (const [candidatePath, label, description] of wellKnown) {
    if (isSocket(candidatePath)) {
      add(candidatePath, label, description);
    }
  }

  // Per-session sockets created by ssh-agent(1) itself, e.g. /tmp/ssh-XXXX/agent.NNNN
  for (const sessionDir of findMatching('/tmp', /^ssh-/)) {
    for (const sockPath of findMatching(sessionDir, /^agent\./)) {
      if (isSocket(sockPath)) {
        add(sockPath, 'ssh-agent', sockPath);
      }
    }
  }

  // macOS's own agent, reached through a per-boot launchd socket rather than a
  // fixed path -- this is the one most users have without knowing it, since
  // $SSH_AUTH_SOCK is only set for shells launchd starts, not for apps
  // launched from the Dock/Finder such as VS Code itself.
  if (process.platform === 'darwin') {
    for (const parentDir of darwinLaunchdRoots) {
      for (const launchdDir of findMatching(parentDir, /^com\.apple\.launchd\./)) {
        const listener = path.join(launchdDir, 'Listeners');
        if (isSocket(listener)) {
          add(listener, 'macOS SSH Agent', listener);
        }
      }
    }
  }

  return candidates;
}

// Named pipes, not filesystem sockets -- there's nothing to `stat`, so this
// offers the two well-known pipe names either way and marks whichever are
// actually listed under \\.\pipe\ right now.
function detectWindowsAgents(): AgentCandidate[] {
  const livePipes = new Set(listDir('\\\\.\\pipe\\'));
  const marker = (name: string) => (livePipes.has(name) ? ' (detected)' : '');
  return [
    {
      label: `OpenSSH Agent${marker('openssh-ssh-agent')}`,
      description: 'Windows OpenSSH agent service (also used by 1Password)',
      value: '\\\\.\\pipe\\openssh-ssh-agent',
    },
    {
      label: `Pageant${marker('pageant')}`,
      description: "PuTTY's agent",
      value: 'pageant',
    },
  ];
}
