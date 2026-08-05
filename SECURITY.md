# Security Policy

SFTPresso is a VS Code extension that moves files over SFTP (SSH) and FTP/FTPS. It
handles server credentials and writes to remote filesystems, so security reports are
taken seriously. Thanks for helping keep it safe.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report privately through GitHub:

1. Go to <https://github.com/jmwerk/SFTPresso/security/advisories/new>
2. Or open the repository's **Security** tab → **Report a vulnerability**

If GitHub private reporting is unavailable to you, email
**j.m.werkheiser@gmail.com** with `SFTPresso security` in the subject line.

A useful report includes:

- Affected version (shown next to SFTPresso in the Extensions view)
- VS Code version and operating system
- Protocol and configuration involved (`sftp` / `ftp` / FTPS, hopping, profiles) —
  with credentials and hostnames redacted
- Steps to reproduce, and what an attacker gains
- Any relevant output from the **SFTP** output channel (again, redacted)

### What to expect

SFTPresso is maintained by one person, so timelines are best-effort rather than
contractual:

| Stage | Target |
| --- | --- |
| Acknowledgement of your report | within 5 days |
| Initial assessment and severity call | within 14 days |
| Fix released for accepted reports | as soon as practical, severity-dependent |

Fixes ship in a normal release to the [VS Code Marketplace][marketplace] and
[Open VSX][openvsx], accompanied by a [GitHub Security Advisory][advisories] and a
`CHANGELOG.md` entry. You will be credited in the advisory unless you ask otherwise.
Please give the fix a chance to ship before disclosing publicly.

## Supported versions

Only the latest published release receives security fixes. There are no long-term
support branches — updates arrive automatically through the Marketplace or Open VSX,
so staying current is the supported path.

| Version | Supported |
| --- | --- |
| Latest release (1.28.x) | ✅ |
| Any earlier SFTPresso release | ❌ — upgrade |
| `vscode-sftp` from `@Natizyskunk` or `@liximomo` | ❌ — separate projects, report upstream |

## Scope

**In scope**

- Credential handling: password storage, key and passphrase handling, secrets
  reaching logs, the output channel, telemetry, or error messages
- Code execution or file writes outside the configured local/remote paths, including
  path traversal via remote filenames during download or sync
- Weakening of transport security (SSH or TLS) beyond what the user configured
- Vulnerable dependencies that are actually reachable from extension code
- Anything in the release pipeline that could ship a tampered `.vsix`

**Out of scope**

- Vulnerabilities in the remote SFTP/FTP server you connect to
- The throwaway credentials, certificates, and SSH keys under `test/integration/` —
  these are test-only by design and never used outside the Docker compose stack
- Findings that require an attacker who already has code execution or filesystem
  access as your user (they can read `sftp.json` and your SSH keys directly)
- Reports produced solely by automated scanners with no demonstrated impact
- Missing hardening that VS Code itself governs (extension sandboxing, marketplace
  trust model)

## Security model, and what it asks of you

Understanding these boundaries will tell you whether a behavior is a bug or the
documented design:

- **Configuration lives in your workspace.** `.vscode/sftp.json` is a plain file in
  your project. If it contains a `password`, `privateKeyPath`, or `passphrase`,
  anything that can read your workspace — including a commit — can read those.
  Add `.vscode/sftp.json` to `.gitignore` if the file holds secrets.
- **Prefer the OS keychain.** Leave `password` out of `sftp.json` and let SFTPresso
  prompt you; it stores the password in VS Code's `SecretStorage` (backed by the OS
  keychain) under a `protocol://username@host:port` key. `SFTP: Save Password`,
  `SFTP: Clear Password`, and `SFTP: Migrate Plaintext Password` manage those
  entries. Keychain storage is the recommended configuration.
- **Private keys are read from disk by path.** SFTPresso reads the file at
  `privateKeyPath` at connect time; protecting that file's permissions is yours to do.
- **SSH host keys are not pinned or checked against `known_hosts`.** SFTPresso, like
  the upstream project it forks, does not verify the server's host key, so it does
  not detect a machine-in-the-middle on a first or changed connection. This is a
  known limitation of the current design rather than a new finding — reports that
  restate it are welcome as feature requests, and hardening here is planned work.
- **FTP is unencrypted.** Use `"secure": true` for FTPS if the server supports it;
  plain `ftp` sends credentials and file contents in the clear by protocol design.
- **`sftp.json` is executed as configuration, not code.** It is parsed as JSONC.
  Treat an `sftp.json` from an untrusted repository the way you would any untrusted
  workspace file: review it before connecting, since it directs where your files go.

## Ongoing security practices

- [CodeQL][codeql] analysis runs on every push and pull request to `develop`, plus
  weekly on a schedule.
- Dependabot opens weekly update pull requests for npm dependencies and GitHub
  Actions.
- Unit tests run on every push; the FTP/SFTP integration suite runs the real client
  layers against Docker-hosted servers in CI.

[marketplace]: https://marketplace.visualstudio.com/items?itemName=jmwerk.sftpresso
[openvsx]: https://open-vsx.org/extension/jmwerk/sftpresso
[advisories]: https://github.com/jmwerk/SFTPresso/security/advisories
[codeql]: https://github.com/jmwerk/SFTPresso/actions/workflows/codeql-analysis.yml
