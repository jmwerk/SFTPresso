# Security Policy

SFTPresso moves files over SFTP (SSH) and FTP/FTPS and handles your server credentials
along the way, so I take security reports seriously. Thanks in advance for the help.

## Reporting a vulnerability

**Please don't open a public issue for a security problem.**

Report it privately through GitHub instead:

1. Go to <https://github.com/jmwerk/SFTPresso/security/advisories/new>, or
2. Open the repo's **Security** tab → **Report a vulnerability**.

If private reporting isn't available to you for some reason, email
**j.m.werkheiser+SFTPresso@gmail.com** with `SFTPresso security` in the subject.

It helps a lot if you include:

- The affected version (next to SFTPresso in the Extensions view)
- Your VS Code version and OS
- The protocol/config involved (`sftp` / `ftp` / FTPS, hopping, profiles) — with
  credentials and hostnames redacted
- Steps to reproduce, and what an attacker actually gains from it
- Anything relevant from the **SFTP** output channel (redacted, same as above)

### What to expect

I maintain this project alone, so treat these as best-effort targets, not an SLA:

| Stage | Target |
| --- | --- |
| I acknowledge your report | within 5 days |
| Initial assessment / severity call | within 14 days |
| Fix released, if accepted | as soon as I reasonably can, depending on severity |

Fixes go out as a normal release to the [VS Code Marketplace][marketplace] and
[Open VSX][openvsx], along with a [GitHub Security Advisory][advisories] and a
`CHANGELOG.md` entry. You'll be credited in the advisory unless you'd rather not be.
If you can, please hold off on public disclosure until the fix has shipped.

## Supported versions

Only the current release gets security fixes — there's no long-term-support branch.
Updates arrive automatically through the Marketplace or Open VSX, so staying current
is really the only supported path:

| Version | Supported |
| --- | --- |
| Whatever's currently published | ✅ |
| Any older SFTPresso release | ❌ — please upgrade |
| `vscode-sftp` from `@Natizyskunk` or `@liximomo` | ❌ — different project, report it upstream |

## Scope

**In scope**

- Credential handling — password storage, key/passphrase handling, secrets leaking
  into logs, the output channel, telemetry, or error messages
- Code execution or writes outside the local/remote paths you configured, including
  path traversal via a remote filename during download or sync
- Weakening SSH/TLS transport security below what you actually configured
- A vulnerable dependency that's genuinely reachable from the extension's own code
- Anything in the release pipeline that could ship a tampered `.vsix`

**Out of scope**

- Vulnerabilities in the remote SFTP/FTP server you're connecting to — that's not this
  project
- The throwaway credentials and SSH keys under `test/integration/` — test-only, never
  used outside the Docker compose stack
- Anything that requires an attacker who already has code execution or filesystem
  access as you — at that point they can just read `sftp.json` and your SSH keys
  directly
- Scanner output with no demonstrated impact
- Hardening that's really VS Code's job (extension sandboxing, the marketplace trust
  model)

## How this is designed, and what that asks of you

A few things worth understanding up front, since they explain whether something you've
noticed is a bug or just how this is built:

- **Your config lives in your workspace.** `.vscode/sftp.json` is a plain file in your
  project. If it has a `password`, `privateKeyPath`, or `passphrase` in it, anything
  that can read the workspace — including a commit — can read those too. If the file
  holds secrets, put it in `.gitignore`.
- **The OS keychain is the better option.** Leave `password` out of `sftp.json` and let
  SFTPresso prompt you for it — it'll store the password in VS Code's `SecretStorage`
  (backed by your OS keychain), keyed by `protocol://username@host:port`.
  `SFTP: Save Password`, `SFTP: Clear Password`, and `SFTP: Migrate Plaintext Password`
  manage those entries, and I'd recommend using them over a plaintext password.
- **Private keys are read from disk by path**, at connect time. Keeping that file's
  permissions locked down is on you.
- **SSH host keys are checked.** Every connection is verified against your own
  `~/.ssh/known_hosts` (or SFTPresso's own store, for keys you've only accepted here) —
  see [Host key verification](https://github.com/jmwerk/SFTPresso/wiki#host-key-verification)
  in the wiki for exactly how that works and what `strictHostKeyChecking` changes about
  it.
- **FTP is unencrypted, by protocol.** Set `"secure": true` for FTPS if your server
  supports it — plain `ftp` sends credentials and file contents in the clear no matter
  what this extension does.
- **`sftp.json` is config, not code, but treat it like any other untrusted file.** It's
  parsed as JSONC, not executed — but it does decide where your files go, so review one
  from a repo you don't trust before connecting, the same as you would any other
  workspace file.

## Ongoing practices

- [CodeQL][codeql] runs on every push and PR to `develop`, plus weekly on a schedule.
- Dependabot opens weekly update PRs for npm dependencies and GitHub Actions.
- Unit tests run on every push, and the FTP/SFTP integration suite runs the real
  client code against Docker-hosted servers in CI.

[marketplace]: https://marketplace.visualstudio.com/items?itemName=jmwerk.sftpresso
[openvsx]: https://open-vsx.org/extension/jmwerk/sftpresso
[advisories]: https://github.com/jmwerk/SFTPresso/security/advisories
[codeql]: https://github.com/jmwerk/SFTPresso/actions/workflows/codeql-analysis.yml
