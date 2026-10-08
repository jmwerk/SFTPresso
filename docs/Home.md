<!-- Source of the GitHub wiki page "Home". Published by .github/workflows/sync-wiki.yml; edits made on the wiki are overwritten. -->

> **SFTPresso** — SFTP/FTP sync for Visual Studio Code. Actively maintained fork of `vscode-sftp`.
>
> - **Publisher:** `jmwerk` · **Current version:** 1.38.0 · **License:** MIT
> - **Repository:** https://github.com/jmwerk/SFTPresso
> - **Requires:** VS Code `^1.138.0`
> - **Lineage:** forked from [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp), which continued [liximomo's original SFTP plugin](https://github.com/liximomo/vscode-sftp) after it went unmaintained.

SFTPresso syncs a local folder to a remote server directory over **SFTP (SSH)** or **FTP/FTPS**, so you can edit in a normal local environment and have the changes show up on a web server, staging box, or embedded device — on save, on demand, or continuously. A minimal setup is a handful of lines of JSON; from there the options go as deep as multi-server, multi-profile, bastion-hop setups need.

## Documentation

| Page | What's in it |
| --- | --- |
| [Installation and Setup](Installation-and-Setup.md) | Install, create `sftp.json`, test the connection, store passwords, host keys |
| [Commands](Commands.md) | Every `SFTP:` command with its ID, plus keybindings |
| [Configuration](Configuration.md) | Every `sftp.json` option, with types and defaults |
| [Workflows](Workflows.md) | Worked examples: upload on save, profiles, multiple contexts, bastion hops, watcher sync |
| [Best Practices](Best-Practices.md) | Habits that keep deploys safe and fast |
| [Troubleshooting](Troubleshooting.md) | Debug logs, connection errors, and known issues |
| [FAQ](FAQ.md) | Short answers to common questions |
| [Development](Development.md) | Building, testing, and contributing |

## What people mostly use it for

Most of the time that's deploying while editing locally — same editor, same shortcuts, changes mirrored to the server on save. But the Remote Explorer also works fine as a file manager on its own (browse, edit, create, delete, no separate FTP client needed), the sync commands handle one-shot or continuous two-way sync with real control over deletes/creates/overwrites, and profiles or multiple configs cover running the same workspace against several environments — `dev`/`staging`/`prod`, or a few servers mapped to different subfolders.

## Key features

| Feature | Where to find it | Details |
| --- | --- | --- |
| Remote Explorer | SFTP icon in the Activity Bar | Browse remote files, multi-select download/upload — see [Using the Remote Explorer](Workflows.md#using-the-remote-explorer) |
| Remote Explorer filter | `SFTP: Filter Remote Explorer` / `SFTP: Clear Filter` | Live, debounced substring search across the whole remote tree — including folders you haven't expanded yet — see [Using the Remote Explorer](Workflows.md#using-the-remote-explorer) |
| Transfers view | SFTP sidebar → **Transfers** | Live per-file status (queued / transferring / failed) with byte-level progress, speed, and ETA, per-file cancel, and retry for failed transfers — see [Monitoring and cancelling transfers](Workflows.md#monitoring-and-cancelling-transfers) |
| Status-bar progress | Status bar during bulk transfers | "Transferring X/Y files" counter plus combined transfer speed; click to open the Transfers view |
| Diff local ↔ remote | `SFTP: Diff with Remote` | Opens VS Code's diff view against the remote copy |
| Compare Folders | `SFTP: Compare Folders with Remote` | Recursive local/remote diff with per-file actions — see [Comparing folders](Workflows.md#comparing-folders-with-the-remote) |
| Compare by content | [`compareMode`](Configuration.md#comparemode) | Compare Folders and Sync go by SHA-256 of the contents instead of timestamps, so a touched-but-unchanged file is never re-transferred |
| Test Connection | `SFTP: Test Connection` / CodeLens on `sftp.json` | Verifies the active profile can connect |
| Connection status | Status bar (when enabled) | An icon reflects the live remote connection state — idle, connecting/reconnecting, connected, lost, or error; click it to run `SFTP: Test Connection` |
| Guided config setup | `SFTP: Config` → **Quick setup** | Step-by-step wizard that generates `sftp.json` and tests the connection — see [First-time setup](Installation-and-Setup.md#first-time-setup) |
| Secure password storage | `SFTP: Save Password` / `SFTP: Clear Password` / `SFTP: Migrate Plaintext Password` | Keep passwords in VS Code's secret storage (OS keychain) instead of plaintext `sftp.json` — see [Storing passwords securely](Installation-and-Setup.md#storing-passwords-securely) |
| Upload on save | [`uploadOnSave`](Configuration.md#uploadonsave) | Mirrors every VS Code save to the server |
| Upload conflict check | [`conflictCheck`](Configuration.md#conflictcheck) | Prompts before an upload overwrites a remote file someone else changed |
| File watcher | [`watcher`](Configuration.md#watcher) | Reacts to changes made *outside* VS Code (build tools, git checkout, …) |
| Server-side rename/move | Remote Explorer context menu → **Rename**, drag-and-drop ([`remoteExplorer.enableDragAndDrop`](Configuration.md#remoteexplorer)), or [`watcher.autoRename`](Configuration.md#watcher) | Renames or moves a file/folder with a single remote `rename()` call, regardless of size — no re-upload — see [Renaming and moving files](Workflows.md#renaming-and-moving-files-on-the-remote) |
| Multiple configurations | [Array config](Workflows.md#multiple-contexts-array-config) | Different servers per workspace subfolder |
| Switchable profiles | [`profiles`](Configuration.md#profiles) + `SFTP: Set Profile` | One config, many targets — the status bar and Remote Explorer show the active profile; click either to switch |
| Temp-file / atomic uploads | [`useTempFile`](Configuration.md#usetempfile), [`openSsh`](Configuration.md#openssh) | Avoid serving half-written files |
| Connection hopping | [`hop`](Workflows.md#connection-hopping-ssh-proxy--bastion) | Reach a target server through one or more SSH bastions |
| Upload to all profiles | `SFTP: Upload … To All Profiles` | Push one file/folder/project to every profile at once |
| Run Remote Command | `SFTP: Run Remote Command` | Run a shell command on the server over the existing SSH connection — no re-authentication. Pick a saved command from [`remoteCommands`](Configuration.md#remotecommands) or type one; output streams to the SFTPresso output channel and the exit code is reported. SFTP only. |
| Legacy extension detection | Automatic, on startup | Warns if an older `@liximomo`/`@Natizyskunk` `sftp` extension is also enabled — see [Legacy extension detection](Installation-and-Setup.md#legacy-extension-detection) |

## Credits

This project builds on the work of [@Natizyskunk](https://github.com/Natizyskunk) and [@liximomo](https://github.com/liximomo). If their earlier work helped you, their original donation links are in the [upstream README](https://github.com/Natizyskunk/vscode-sftp#donation).
