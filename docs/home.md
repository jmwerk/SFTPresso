<!-- Source of the GitHub wiki Home page. Published automatically by .github/workflows/sync-wiki.yml on every push to develop that touches this file. -->

# SFTPresso — Complete Wiki

> **SFTPresso** — SFTP/FTP sync for Visual Studio Code. Actively maintained fork of `vscode-sftp`.
>
> - **Publisher:** `jmwerk` · **Current version:** 1.31.1 · **License:** MIT
> - **Repository:** https://github.com/jmwerk/SFTPresso
> - **Requires:** VS Code `^1.64.2`
> - **Lineage:** forked from [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp), which continued [liximomo's original SFTP plugin](https://github.com/liximomo/vscode-sftp) after it went unmaintained.

---

## Table of Contents

1. [Overview](#1-overview)
   - [What people mostly use it for](#what-people-mostly-use-it-for)
   - [Key features](#key-features)
2. [Installation and Setup](#2-installation-and-setup)
   - [Installing the extension](#installing-the-extension)
   - [First-time setup](#first-time-setup)
   - [Verifying your connection](#verifying-your-connection)
   - [Storing passwords securely](#storing-passwords-securely)
   - [Host key verification](#host-key-verification)
3. [Command Reference](#3-command-reference)
   - [Configuration and connection commands](#configuration-and-connection-commands)
   - [Upload commands](#upload-commands)
   - [Download commands](#download-commands)
   - [Sync commands](#sync-commands)
   - [Diff and compare commands](#diff-and-compare-commands)
   - [Remote Explorer and file commands](#remote-explorer-and-file-commands)
   - [Transfer management commands](#transfer-management-commands)
   - [Force (Alt) commands](#force-alt-commands)
   - [Commands with keybinding arguments](#commands-with-keybinding-arguments)
   - [Default keybindings](#default-keybindings)
4. [Configuration Reference (`sftp.json`)](#4-configuration-reference-sftpjson)
   - [Common options](#common-options)
   - [SFTP-only options](#sftp-only-options)
   - [FTP(S)-only options](#ftps-only-options)
   - [VS Code extension settings](#vs-code-extension-settings)
5. [Usage Examples and Common Workflows](#5-usage-examples-and-common-workflows)
   - [Simple single-server setup](#simple-single-server-setup)
   - [Start from a remote project](#start-from-a-remote-project)
   - [Upload on save](#upload-on-save)
   - [Profiles (dev / prod)](#profiles-dev--prod)
   - [Multiple contexts (array config)](#multiple-contexts-array-config)
   - [Connection hopping (SSH proxy / bastion)](#connection-hopping-ssh-proxy--bastion)
   - [Two-way automatic sync with the watcher](#two-way-automatic-sync-with-the-watcher)
   - [Renaming and moving files on the remote](#renaming-and-moving-files-on-the-remote)
   - [Uploading a folder's contents without the folder itself](#uploading-a-folders-contents-without-the-folder-itself)
   - [Configuration in User Settings (remote-fs)](#configuration-in-user-settings-remote-fs)
   - [Using the Remote Explorer](#using-the-remote-explorer)
   - [Monitoring and cancelling transfers](#monitoring-and-cancelling-transfers)
   - [Comparing folders with the remote](#comparing-folders-with-the-remote)
6. [Best Practices](#6-best-practices)
7. [Troubleshooting and Known Issues](#7-troubleshooting-and-known-issues)
   - [Enabling debug logs](#enabling-debug-logs)
   - [SSH connection error messages](#ssh-connection-error-messages)
   - [Error: Failure](#error-failure)
   - [Error: Connection closed](#error-connection-closed)
   - [ENFILE: file table overflow (macOS)](#enfile-file-table-overflow-macos)
   - [Upload Changed Files does nothing](#upload-changed-files-does-nothing)
   - [Remote Explorer not refreshing after delete](#remote-explorer-not-refreshing-after-delete)
   - [Known issues fixed in this fork](#known-issues-fixed-in-this-fork)
8. [Frequently Asked Questions](#8-frequently-asked-questions)
9. [Development and Contributing](#9-development-and-contributing)
10. [Credits](#10-credits)

---

## 1. Overview

SFTPresso syncs a local folder to a remote server directory over **SFTP (SSH)** or **FTP/FTPS**, so you can edit in a normal local environment and have the changes show up on a web server, staging box, or embedded device — on save, on demand, or continuously. A minimal setup is a handful of lines of JSON; from there the options go as deep as multi-server, multi-profile, bastion-hop setups need.

### What people mostly use it for

Most of the time that's deploying while editing locally — same editor, same shortcuts, changes mirrored to the server on save. But the Remote Explorer also works fine as a file manager on its own (browse, edit, create, delete, no separate FTP client needed), the sync commands handle one-shot or continuous two-way sync with real control over deletes/creates/overwrites, and profiles or multiple configs cover running the same workspace against several environments — `dev`/`staging`/`prod`, or a few servers mapped to different subfolders.

### Key features

| Feature | Where to find it | Details |
| --- | --- | --- |
| Remote Explorer | SFTP icon in the Activity Bar | Browse remote files, multi-select download/upload — see [Using the Remote Explorer](#using-the-remote-explorer) |
| Remote Explorer filter | `SFTP: Filter Remote Explorer` / `SFTP: Clear Filter` | Live, debounced substring search across the whole remote tree — including folders you haven't expanded yet — see [Using the Remote Explorer](#using-the-remote-explorer) |
| Transfers view | SFTP sidebar → **Transfers** | Live per-file status (queued / transferring / failed) with byte-level progress, speed, and ETA, per-file cancel, and retry for failed transfers — see [Monitoring and cancelling transfers](#monitoring-and-cancelling-transfers) |
| Status-bar progress | Status bar during bulk transfers | "Transferring X/Y files" counter plus combined transfer speed; click to cancel all |
| Diff local ↔ remote | `SFTP: Diff with Remote` | Opens VS Code's diff view against the remote copy |
| Compare Folders | `SFTP: Compare Folders with Remote` | Recursive local/remote diff with per-file actions — see [Comparing folders](#comparing-folders-with-the-remote) |
| Test Connection | `SFTP: Test Connection` / CodeLens on `sftp.json` | Verifies the active profile can connect |
| Connection status | Status bar (when enabled) | An icon reflects the live remote connection state — idle, connecting/reconnecting, connected, or error; click it to run `SFTP: Test Connection` |
| Guided config setup | `SFTP: Config` → **Quick setup** | Step-by-step wizard that generates `sftp.json` and tests the connection — see [First-time setup](#first-time-setup) |
| Secure password storage | `SFTP: Save Password` / `SFTP: Clear Password` / `SFTP: Migrate Plaintext Password` | Keep passwords in VS Code's secret storage (OS keychain) instead of plaintext `sftp.json` — see [Storing passwords securely](#storing-passwords-securely) |
| Upload on save | [`uploadOnSave`](#uploadonsave) | Mirrors every VS Code save to the server |
| Upload conflict check | [`conflictCheck`](#conflictcheck) | Prompts before an upload overwrites a remote file someone else changed |
| File watcher | [`watcher`](#watcher) | Reacts to changes made *outside* VS Code (build tools, git checkout, …) |
| Server-side rename/move | Remote Explorer context menu → **Rename**, drag-and-drop ([`remoteExplorer.enableDragAndDrop`](#remoteexplorer)), or [`watcher.autoRename`](#watcher) | Renames or moves a file/folder with a single remote `rename()` call, regardless of size — no re-upload — see [Renaming and moving files](#renaming-and-moving-files-on-the-remote) |
| Multiple configurations | [Array config](#multiple-contexts-array-config) | Different servers per workspace subfolder |
| Switchable profiles | [`profiles`](#profiles) + `SFTP: Set Profile` | One config, many targets — the status bar shows the active profile; click it to switch |
| Temp-file / atomic uploads | [`useTempFile`](#usetempfile), [`openSsh`](#openssh) | Avoid serving half-written files |
| Connection hopping | [`hop`](#connection-hopping-ssh-proxy--bastion) | Reach a target server through one or more SSH bastions |
| Upload to all profiles | `SFTP: Upload … To All Profiles` | Push one file/folder/project to every profile at once |
| Run Remote Command | `SFTP: Run Remote Command` | Run a shell command on the server over the existing SSH connection — no re-authentication. Pick a saved command from [`remoteCommands`](#remotecommands) or type one; output streams to the SFTP output channel and the exit code is reported. SFTP only. |
| Legacy extension detection | Automatic, on startup | Warns if an older `@liximomo`/`@Natizyskunk` `sftp` extension is also enabled — see [Legacy extension detection](#legacy-extension-detection) |

---

## 2. Installation and Setup

### Installing the extension

As of **v1.20.2**, every tagged release is published automatically to both the **VS Code Marketplace** and **Open VSX** by [`.github/workflows/publish.yml`](https://github.com/jmwerk/SFTPresso/blob/develop/.github/workflows/publish.yml), so you can install it straight from your editor:

1. Open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **SFTPresso** and install it — or run `ext install jmwerk.sftpresso` from the Command Palette.
3. If you still have an older `sftp` extension installed (from `@liximomo` or `@Natizyskunk`), SFTPresso detects it on startup and prompts you to disable it — see [Legacy extension detection](#legacy-extension-detection).

Listings: [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jmwerk.sftpresso) · [Open VSX](https://open-vsx.org/extension/jmwerk/sftpresso) (for VSCodium, Gitpod, Eclipse Theia, and other editors that use Open VSX).

To sideload a specific build instead, install from a VSIX package:

1. Grab a `.vsix` from [GitHub Releases](https://github.com/jmwerk/SFTPresso/releases) — or build one from source (see [Development and Contributing](#9-development-and-contributing)).
2. In VS Code, open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
3. Open the **⋯ (More Actions)** menu at the top of the Extensions view and choose **Install from VSIX…**.
4. Locate the `.vsix` file and select it.
5. Reload VS Code. If you still have an older `sftp` extension installed (from `@liximomo` or `@Natizyskunk`), SFTPresso detects it on startup and prompts you to disable it — see [Legacy extension detection](#legacy-extension-detection).

To build the VSIX yourself:

```sh
git clone https://github.com/jmwerk/SFTPresso.git
cd SFTPresso
npm install          # also applies bundled patches via patch-package
npm run package      # produces sftpresso-<version>.vsix via vsce
```

### Legacy extension detection

SFTPresso is a fork, and the two projects it descends from — `sftp` (`@liximomo`) and `vscode-sftp` (`@Natizyskunk`) — happen to register commands under that same `sftp.*` namespace. Enable one of them alongside SFTPresso and VS Code has to pick one to actually run `SFTP: Upload`; which one it picks isn't something you control, and the resulting bugs are a nightmare to reproduce since half the time it isn't even this extension's code that ran.

So on startup, SFTPresso checks whether either older extension is installed *and enabled* (disabled doesn't count) and, if so, shows one notification: **Disable the Other**, **Show Me** (just reveals it in the Extensions view first), or **Don't Show Again** for this workspace. Nothing gets disabled without you clicking something — and the dismissal only applies to that one workspace, in case you've genuinely got a reason to run both somewhere.

### First-time setup

> **Guided walkthrough:** Run **`Welcome: Open Walkthrough…`** from the Command Palette and choose **Get started with SFTPresso** for a native, checklist-style version of these steps — Create your config, Test the connection, Download the project, and Enable upload on save — each with a one-click button that runs the matching command.

1. Open the local folder you want to sync (`File → Open Folder…`).
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **`SFTP: Config`**.
3. When no `sftp.json` exists yet, pick how to create it:
   - **Quick setup** — a guided wizard that asks for the protocol (sftp/ftp), host, port (pre-filled 22 or 21 per protocol), username, authentication method, remote path, and whether to upload on save. For SFTP the auth choices are a password prompt at connect time (with an offer to remember it in secret storage), a private key file (`~` is expanded and the file is checked to exist), or a running ssh-agent. Answers are validated against the config schema, `sftp.json` is written, and **`SFTP: Test Connection`** runs immediately to confirm the connection works.
   - **Edit JSON** — the extension creates `.vscode/sftp.json` with a starter template. Edit it with your server details:

```json
{
    "name": "My Server",
    "host": "server.example.com",
    "protocol": "sftp",
    "port": 22,
    "username": "user1",
    "remotePath": "/var/www/project",
    "uploadOnSave": false
}
```

4. Save and close `sftp.json`. The extension activates automatically whenever a workspace contains `.vscode/sftp.json`.
5. Type `SFTP` in the Command Palette to see all available commands (see the [Command Reference](#3-command-reference)). Many are also available from the file explorer and editor context menus.

Notes:

- `password` is optional — if omitted you'll be prompted when a connection is made, and offered to have the password remembered in VS Code's secret storage (see [Storing passwords securely](#storing-passwords-securely)). If you do store it in `sftp.json`, be aware it is **plain text** (see [Best Practices](#6-best-practices)).
- Backslashes and other special characters in JSON values must be escaped with a backslash.
- `sftp.json` gets schema-validated in the editor, so you get completions and warnings for unknown or mistyped option names.

### Verifying your connection

Run **`SFTP: Test Connection`** from the Command Palette, or click the **Test Connection** CodeLens shown at the top of `sftp.json`. It connects using the active profile's settings and reports success or failure with an actionable message (see [SSH connection error messages](#ssh-connection-error-messages)).

There's also a **connection-status indicator** in the status bar — a plug icon when idle, a spinner while (re)connecting, an active-VM icon when connected, and a highlighted error icon when it fails. Connections reconnect lazily on the next operation, so without this you'd never actually see a reconnect fail; click the icon to run `SFTP: Test Connection`.

### Storing passwords securely

Instead of writing `password` into `sftp.json` (which is plain text), you can keep it in VS Code's secret storage, which is backed by the operating system keychain:

- Run **`SFTP: Save Password`**, pick the remote, and enter the password. Future connections use it automatically — no prompt, nothing in `sftp.json`.
- Or just connect: when you're prompted for a password and the connection succeeds, the extension offers to **remember** it.
- Already have a plaintext `password` in `sftp.json`? Run **`SFTP: Migrate Plaintext Password`** (or click **Migrate Password** on the warning) to move it into secret storage and strip the `password` key from the file in one step — comments and formatting are preserved, and you're asked to confirm first.
- Run **`SFTP: Clear Password`** to delete a saved password (for example after it changed on the server).

Saved passwords are keyed by `protocol://username@host:port` — so any config or profile pointing at the same server/user shares one, and it's only used when nothing else in the config already provides auth (`password`, `privateKeyPath`, `agent`, `interactiveAuth` all still work exactly as before). Still got a plaintext `password` sitting in `sftp.json`? You'll get a one-time reminder in the output channel with a Migrate Password button.

### Host key verification

SFTPresso checks the server's SSH host key before handing over your credentials — same as `ssh` or `scp` would. Without that, anything answering on the right IP gets trusted by default, which is exactly the gap a man-in-the-middle needs.

It looks in your own `~/.ssh/known_hosts` first (plus `known_hosts2` and `/etc/ssh/ssh_known_hosts`), so a host you've already accepted with plain `ssh` is trusted here too, no extra prompt — hashed entries, wildcards, `!` negations, `@revoked`, `[host]:port`, all of it works the way you'd expect. Keys you accept from inside SFTPresso itself go into a `known_hosts` file of its own (same format, in the extension's global storage) rather than touching yours — your real `known_hosts` stays something only your ssh client writes to.

What happens on connect depends on [`strictHostKeyChecking`](#stricthostkeychecking) (default `"accept-new"`):

- **First time seeing a host** — trusted and remembered silently by default. Set `"ask"` if you'd rather see a modal first, with the fingerprint in the same `SHA256:…` form `ssh-keygen -lf` prints, and a choice of Connect Once / Connect and Remember / cancel.
- **Key matches what's stored** — connects, no fuss.
- **Key changed** — connection refused, flat out, with both fingerprints shown and where the old one came from. There's deliberately no "connect anyway" button here — a changed key means either the server got rebuilt or something worse is happening, and those two shouldn't be one click apart. If you're sure it's legitimate, run **`SFTP: Forget Host Key`** and connect again.

**`SFTP: Show Host Key Fingerprint`** shows what's stored for a host and where it came from; **`SFTP: Forget Host Key`** clears it (asking first, with the file and line, if it'd mean touching a file your own ssh client maintains).

> ⚠️ **Coming from 1.29.0 or earlier?** Host keys weren't checked at all before this, so SFTPresso's store starts empty regardless of what you've already connected to. With the default `"accept-new"` nothing changes for existing configs — the first connection after upgrading just learns the key — but a key that *changes* after that now stops the connection instead of sailing through. One snag: if `~/.ssh/known_hosts` already has a stale entry you've been ignoring, that connection will start failing here too. Run `SFTP: Forget Host Key` or `ssh-keygen -R` to clear it.

---

## 3. Command Reference

All commands live under the **SFTP** category in the Command Palette. Most are also exposed via context menus (file explorer, editor, editor title, SCM view, Remote Explorer). Commands are only available when the extension is active (workspace contains `.vscode/sftp.json`).

### Configuration and connection commands

| Command | ID | Description |
| --- | --- | --- |
| `SFTP: Config` | `sftp.config` | Create a new `sftp.json` for the workspace — via a guided quick-setup wizard or a starter template — or open the existing one. See [First-time setup](#first-time-setup). |
| `SFTP: Set Profile` | `sftp.setProfile` | Switch the active [profile](#profiles-dev--prod). |
| `SFTP: Test Connection` | `sftp.testConnection` | Connect to the active profile's remote and report success/failure. Also available as a CodeLens on `sftp.json`. |
| `SFTP: Disconnect` | `sftp.disconnect` | Drop every pooled connection (all configs/profiles, not just the active one) so the next command reconnects fresh. Manual escape hatch for a stuck connection — [`operationTimeout`](#operationtimeout) usually catches that on its own, but this is faster than reloading the window when it doesn't. |
| `SFTP: Toggle Upload on Save` | `sftp.toggleUploadOnSave` | Flip the active config's [`uploadOnSave`](#uploadonsave) and write it back to `sftp.json` (comments and formatting preserved). The status bar shows a `$(cloud-upload)` indicator while it's on. |
| Add to Ignore | `sftp.addToIgnore` | File-explorer context menu command. Appends the right-clicked file or folder's workspace-relative path to the active config's [`ignore`](#ignore) array in `sftp.json` (folders as `path/**`), preserving comments and formatting; a no-op if the entry is already listed. |
| `SFTP: Open SSH in Terminal` | `sftp.openConnectInTerminal` | Open a VS Code terminal auto-logged-in to the server. Extra CLI flags can be added via [`sshCustomParams`](#sshcustomparams). |
| `SFTP: Save Password` | `sftp.savePassword` | Store a password for a remote in VS Code's secret storage (OS keychain). See [Storing passwords securely](#storing-passwords-securely). |
| `SFTP: Migrate Plaintext Password` | `sftp.migratePassword` | Move a plaintext `password` out of `sftp.json` into secret storage and strip the key (comments/formatting preserved, confirms first). Same thing the **Migrate Password** button on the plaintext warning does. See [Storing passwords securely](#storing-passwords-securely). |
| `SFTP: Clear Password` | `sftp.clearPassword` | Remove a saved password from secret storage. |
| `SFTP: Show Host Key Fingerprint` | `sftp.showHostKey` | Show the stored host key(s) for a remote — fingerprint, type, source file — with a copy button. See [Host key verification](#host-key-verification). |
| `SFTP: Forget Host Key` | `sftp.forgetHostKey` | Clear the stored host key(s) for a remote, so the next connection is treated as new. What you run when a connection's refused because the server's key changed. Removing an entry from your own `~/.ssh/known_hosts` asks for confirmation first, naming the file and line. |
| `SFTP: Run Remote Command` | `sftp.runRemoteCommand` | Run a command on the remote over the existing SSH connection, no re-auth. Pick from [`remoteCommands`](#remotecommands) or type one — either way you confirm the resolved command and host before it runs, since it executes on whatever server the active config points at. Output streams to the SFTP output channel; a command past [`remoteCommandTimeout`](#remotecommandtimeout) gets killed and reported as timed out. FTP configs just get an error instead. |

### Upload commands

Uploads overwrite the remote copy unconditionally. Enable [`conflictCheck`](#conflictcheck) to be warned first when the remote file changed since you last downloaded or uploaded it.

| Command | ID | Description |
| --- | --- | --- |
| `SFTP: Upload Active File` | `sftp.upload.activeFile` | Upload the file currently open in the editor. |
| `SFTP: Upload Active Folder` | `sftp.upload.activeFolder` | Upload the folder containing the current file. |
| `SFTP: Upload Project` | `sftp.upload.project` | Upload the whole project (respecting [`ignore`](#ignore) rules). |
| `SFTP: Upload Changed Files` | `sftp.upload.changedFiles` | Upload all files changed or created since the last Git commit (including deletions). Default keybinding `Ctrl+Alt+U`; also shown in the Source Control view. |
| Upload File / Upload Folder | `sftp.upload.file` / `sftp.upload.folder` | Context-menu variants that act on the right-clicked explorer item. |
| `SFTP: Upload … To All Profiles` | `sftp.upload.activeFile.to.allProfiles`, `sftp.upload.activeFolder.to.allProfiles`, `sftp.upload.project.to.allProfiles`, `sftp.upload.file.to.allProfiles`, `sftp.upload.folder.to.allProfiles` | Same as above but pushes to **every** profile defined in the config, not just the active one. |

### Download commands

| Command | ID | Description |
| --- | --- | --- |
| `SFTP: Download Active File` | `sftp.download.activeFile` | Download the remote version of the current file, overwriting the local copy. |
| `SFTP: Download Active Folder` | `sftp.download.activeFolder` | Download the folder containing the current file. |
| `SFTP: Download Project` | `sftp.download.project` | Download everything under [`remotePath`](#remotepath) into the workspace. |
| Download File / Download Folder | `sftp.download.file` / `sftp.download.folder` | Context-menu variants (explorer and Remote Explorer). |

### Sync commands

Sync compares timestamps and transfers only what differs; behavior is tuned with [`syncOption`](#syncoption). Enable [`syncConfirm`](#syncconfirm) to preview and confirm exactly what a sync will upload, overwrite, and delete before it runs.

| Command | ID | Description |
| --- | --- | --- |
| `SFTP: Sync Local -> Remote` | `sftp.sync.localToRemote` | Copies files that differ by timestamp, plus files that exist only locally. |
| `SFTP: Sync Remote -> Local` | `sftp.sync.remoteToLocal` | Same, in the opposite direction. |
| `SFTP: Sync Both Directions` | `sftp.sync.bothDirections` | Compares modification times and always keeps the **newest** version on both sides. Only `syncOption.skipCreate` and `syncOption.ignoreExisting` apply to this command. |

> If local and remote clocks disagree (server in another timezone, clock drift), set [`remoteTimeOffsetInHours`](#remotetimeoffsetinhours) so timestamp comparison stays accurate.

### Diff and compare commands

| Command | ID | Description |
| --- | --- | --- |
| `SFTP: Diff Active File with Remote` | `sftp.diff.activeFile` | Open VS Code's diff view: current file vs. its remote counterpart. |
| Diff with Remote | `sftp.diff` | Context-menu variant for any explorer file. |
| `SFTP: Compare Folders with Remote` | `sftp.compareFolders` | Recursively diffs a local folder against its remote counterpart; results (new-local / new-remote / modified) are listed in a QuickPick with per-file actions to open a diff, upload, or download. |

### Remote Explorer and file commands

| Command | ID | Description |
| --- | --- | --- |
| `SFTP: List` / `SFTP: List Active Folder` / `SFTP: List All` | `sftp.list` / `sftp.listActiveFolder` / `sftp.listAll` | List remote directory contents in a QuickPick. `List All` includes ignored files. |
| Rename | `sftp.rename.remote` | Rename or move the selected file/folder **on the remote** (Remote Explorer context menu) — a single `rename()` call regardless of size, no re-upload. A name containing `/` moves the item. Refuses to overwrite an existing destination or move the item outside `remotePath` or into itself. See [Renaming and moving files](#renaming-and-moving-files-on-the-remote). |
| Delete | `sftp.delete.remote` | Delete the selected file/folder **on the remote** (Remote Explorer context menu). |
| Create Folder / Create File | `sftp.create.folder` / `sftp.create.file` | Create a remote folder or file from the Remote Explorer. |
| Edit in Local | `sftp.remoteExplorer.editInLocal` | Download the remote file into the workspace so it can be edited (Remote Explorer opens files read-only by default). |
| View Content | `sftp.viewContent` | Open a read-only view of a remote file. |
| Reveal in Explorer | `sftp.revealInExplorer` | Jump from a remote file to its local counterpart in the file explorer. |
| Reveal in Remote Explorer | `sftp.revealInRemoteExplorer` | Jump from a local file to its remote counterpart in the Remote Explorer. |
| Refresh | `sftp.remoteExplorer.refresh` | Refresh the Remote Explorer tree. |
| Refresh Active Remote File | `sftp.remoteExplorer.refreshActiveFile` | Re-fetch the remote file open in the editor. |
| `SFTP: Filter Remote Explorer` | `sftp.remoteExplorer.filter` | Open a live, debounced quick pick that narrows the Remote Explorer to entries whose name contains the typed substring, plus their ancestor folders — including folders not yet expanded. See [Using the Remote Explorer](#using-the-remote-explorer). |
| `SFTP: Clear Filter` | `sftp.remoteExplorer.clearFilter` | Clear an active Remote Explorer filter and restore the full listing. |

### Transfer management commands

| Command | ID | Description |
| --- | --- | --- |
| `SFTP: Cancel All Transfers` | `sftp.cancelAllTransfer` | Stop every in-flight upload/download. Also triggered by clicking the status-bar progress counter, and from the Transfers view title bar. |
| Cancel Transfer | `sftp.cancelTransfer` | Cancel a single in-flight file — the inline ✕ button on items in the [Transfers view](#monitoring-and-cancelling-transfers). |
| Retry Transfer | `sftp.retryTransfer` | Re-queue a single failed file — the inline ↻ button on failed items in the [Transfers view](#monitoring-and-cancelling-transfers). |

### Force (Alt) commands

Hold **Alt** while a context menu is open to reveal the force variants, which **disregard [`ignore`](#ignore) rules**:

| Command | ID | Description |
| --- | --- | --- |
| Force Upload | `sftp.forceUpload` | Upload even files matched by ignore rules. |
| Force Download | `sftp.forceDownload` | Download even files matched by ignore rules. |
| Force Upload To All Profiles | `sftp.forceUpload.to.allProfiles` | Force-upload to every profile. |

### Commands with keybinding arguments

These accept arguments when bound in `keybindings.json` or invoked from `tasks.json`:

| Command | Signature |
| --- | --- |
| `sftp.setProfile` | `func(profileName: string)` |
| `sftp.upload` | `func(fspaths: string[])` — upload the given files/folders |
| `sftp.download` | `func(fspaths: string[])` — download the given files/folders |

Example — a keybinding that switches straight to the `prod` profile:

```json
{
  "key": "ctrl+alt+p",
  "command": "sftp.setProfile",
  "args": "prod"
}
```

### Default keybindings

| Keys | Command | When |
| --- | --- | --- |
| `Ctrl+Alt+U` | `SFTP: Upload Changed Files` | Extension active |

---

## 4. Configuration Reference (`sftp.json`)

Configuration lives in `<workspace>/.vscode/sftp.json` — either a single object, or an **array of objects** for [multiple contexts](#multiple-contexts-array-config). Open it any time via `SFTP: Config`.

The file is read as **JSONC**: `// line comments`, `/* block comments */`, and trailing commas are all allowed, so you can annotate a config or comment out options without breaking it. Parse errors are reported with their line and column.

### Common options

Apply to both SFTP and FTP unless noted.

#### name
A string to identify your configuration. Shown in pickers when multiple configs exist. **Required when using an array (multi-context) config.**

| Key | Type | Default |
| --- | --- | --- |
| `name` | string | — |

```json
{ "name": "My Server" }
```

#### context
A path relative to the workspace root. Use it to map a **subfolder** (rather than the whole workspace) to `remotePath`. Only available at the root level of a config (not inside profiles).

| Key | Type | Default |
| --- | --- | --- |
| `context` | string | workspace root |

```json
{ "context": "./build" }
```

#### protocol
Transfer protocol.

| Key | Type | Default |
| --- | --- | --- |
| `protocol` | `"sftp"` \| `"ftp"` | `"sftp"` |

#### host
Hostname or IP address of the server.

| Key | Type |
| --- | --- |
| `host` | string |

#### port
Server port. Typically `22` for SFTP, `21` for FTP, `990` for implicit FTPS.

| Key | Type |
| --- | --- |
| `port` | integer |

#### username
Username for authentication.

| Key | Type |
| --- | --- |
| `username` | string |

#### password
Password for password-based authentication. **Optional** — omit it to use a password saved via `SFTP: Save Password`, or to be prompted at connect time (see [Storing passwords securely](#storing-passwords-securely)).

> ⚠️ **Warning:** passwords in `sftp.json` are stored as **plain text**. Prefer [`privateKeyPath`](#privatekeypath) or [`agent`](#agent) — or keep the password in [secret storage](#storing-passwords-securely) — and keep `sftp.json` out of version control. See [Best Practices](#6-best-practices).

| Key | Type |
| --- | --- |
| `password` | string |

#### remotePath
The absolute path on the remote host that maps to your local [`context`](#context). This is what `SFTP: Download Project` downloads.

| Key | Type | Default |
| --- | --- | --- |
| `remotePath` | string | `/` |

#### filePerm
Octal permissions applied to newly created remote files.

| Key | Type | Default |
| --- | --- | --- |
| `filePerm` | number | unset |

```json
{ "filePerm": 644 }
```

#### dirPerm
Octal permissions applied to newly created remote directories.

| Key | Type | Default |
| --- | --- | --- |
| `dirPerm` | number | unset |

```json
{ "dirPerm": 750 }
```

#### uploadOnSave
Upload the file on every VS Code save. See the [Upload on save](#upload-on-save) workflow. You can flip this without editing JSON via **`SFTP: Toggle Upload on Save`**; the status bar shows a `$(cloud-upload)` indicator while it's on.

| Key | Type | Default |
| --- | --- | --- |
| `uploadOnSave` | boolean | `false` |

#### useTempFile
Upload to a temporary file first, then move it into place — avoids serving a half-written file to visitors while the upload is in progress.

| Key | Type | Default |
| --- | --- | --- |
| `useTempFile` | boolean | `false` |

#### openSsh
Enable **atomic** file uploads (rename-into-place). Only supported by OpenSSH servers.

> 💡 If `openSsh` is `true`, [`useTempFile`](#usetempfile) must also be `true`.

| Key | Type | Default |
| --- | --- | --- |
| `openSsh` | boolean | `false` |

```json
{ "openSsh": true, "useTempFile": true }
```

#### downloadOnOpen
Download the remote version of a file whenever it is opened locally.

| Key | Type | Default |
| --- | --- | --- |
| `downloadOnOpen` | boolean | `false` |

#### syncOption
Tunes the [Sync commands](#sync-commands).

| Key | Type | Default |
| --- | --- | --- |
| `syncOption` | object | `{}` |

| Sub-option | Type | Default | Effect |
| --- | --- | --- | --- |
| `syncOption.delete` | boolean | `false` | Delete extraneous files from the destination. |
| `syncOption.skipCreate` | boolean | `false` | Don't create files that are new to the destination. |
| `syncOption.ignoreExisting` | boolean | `false` | Don't update files that already exist on the destination. |
| `syncOption.update` | boolean | `false` | Only overwrite the destination if the source copy is newer. |

All four are off unless set explicitly — an omitted key has never done anything at runtime, though the JSON schema incorrectly advertised `true` as the default before this was corrected.

```json
{
  "syncOption": {
    "delete": true,
    "skipCreate": false,
    "ignoreExisting": false,
    "update": true
  }
}
```

> `Sync Both Directions` honors only `skipCreate` and `ignoreExisting`.

#### syncConfirm
Get a dry-run preview before a [Sync command](#sync-commands) actually runs — something like *"Sync Local → Remote: 3 uploads, 1 overwrite, 2 deletions. Proceed?"*, with the files listed, and Cancel/Proceed to decide. Nothing happens until you click Proceed; if there's nothing to sync, you just get a quick "nothing to do" message instead.

| Key | Type | Default |
| --- | --- | --- |
| `syncConfirm` | boolean | `true` when [`syncOption.delete`](#syncoption) is enabled, otherwise `false` |

Default's conservative on purpose — a sync that can delete things asks first, one that can't doesn't bother you. Set it explicitly if you want the opposite either way.

One caveat: if a directory can't be read while building the preview, it shows up as `! could not read:` and the summary says so up front — the rest of the preview is only as complete as what it could actually see.

```json
{
  "syncConfirm": true
}
```

#### conflictCheck
Guard against uploads that would silently overwrite someone else's work. Before a file upload replaces an existing remote file, the extension checks whether the remote copy changed since you last downloaded or uploaded it. If it did, a modal shows both timestamps and offers **Overwrite**, **Open Diff**, or **Cancel** — **Open Diff** opens the local/remote [diff](#diff-and-compare-commands) and leaves the remote untouched.

| Key | Type | Default |
| --- | --- | --- |
| `conflictCheck` | boolean | `false` |

```json
{
  "uploadOnSave": true,
  "conflictCheck": true
}
```

It's smarter than a plain timestamp check, which matters because your local copy is always "newest" the moment you edit it — a naive check would wave through an upload even if a teammate changed the remote five minutes ago. So instead, after every transfer SFTPresso remembers what the remote looked like at that moment, and compares against *that* baseline rather than just "is remote newer than local right now." No baseline yet (nothing transferred this workspace) falls back to just checking whether the remote is newer than local.

A few things to know: it only covers single-file uploads (including `uploadOnSave`) — folder uploads and [Sync](#sync-commands) skip it, since prompting mid-batch doesn't really work; use [`syncConfirm`](#syncconfirm) there instead. It costs one extra round-trip per upload, which is part of why it's off by default. Baselines are per-workspace, so uploading from a second machine can trigger one stale-baseline prompt — just choose Overwrite and it's back in sync. And on FTP servers without `MFMT` support, the remote's mtime is just "whenever it was uploaded," which makes conflicts get flagged more often than they should — see [`remoteTimeOffsetInHours`](#remotetimeoffsetinhours) if that's biting you.

#### ignore
Files/folders excluded from transfers and sync. Gitignore-style patterns (wildcards with `*`), relative to the config's [`context`](#context). Bypass with the [Force commands](#force-alt-commands).

| Key | Type | Default |
| --- | --- | --- |
| `ignore` | string[] | `[]` |

```json
{
  "ignore": [
    "/.vscode",
    "/.git",
    ".DS_Store",
    "*.log"
  ]
}
```

#### ignoreFile
Path to an ignore file (e.g. `.gitignore`-style list) — absolute, or relative to the workspace root.

| Key | Type |
| --- | --- |
| `ignoreFile` | string |

```json
{ "ignoreFile": ".gitignore" }
```

#### maxFileSize
Caps file size (MB) for a **batch** transfer — folder upload/download or [Sync](#sync-commands). Anything over the limit just gets skipped, with a summary afterward naming the count and the largest offender (full list in the output channel). This exists because someone's project has a stray database dump or video file in it, and nobody wants to find that out an hour into a folder upload. Doesn't apply if you explicitly right-click one file and upload/download it — that always goes through regardless of size. `0` or unset means no cap.

| Key | Type | Default |
| --- | --- | --- |
| `maxFileSize` | number | `0` (disabled) |

```json
{ "maxFileSize": 100 }
```

#### watcher
Watches for changes made outside VS Code itself — build output, `git checkout`, some other tool writing to disk — and reacts automatically. See [Two-way automatic sync](#two-way-automatic-sync-with-the-watcher) for a full example.

A [profile](#profiles) can override this — even turn it off entirely with `"files": false` — just for that profile. Switching profiles rebuilds the watcher, and the profile's own [`ignore`](#ignore) rules apply to it too.

| Key | Type | Default |
| --- | --- | --- |
| `watcher` | object | `{}` |

| Sub-option | Type | Effect |
| --- | --- | --- |
| `watcher.files` | string (glob) | Which files to watch (required). |
| `watcher.autoUpload` | boolean | Upload when a watched file changes. |
| `watcher.autoDelete` | boolean | Delete on the remote when a watched file is removed locally. |
| `watcher.autoRename` | boolean | Server-side rename/move on the remote when a watched file or folder is renamed locally, instead of deleting and re-uploading it. See [Renaming and moving files](#renaming-and-moving-files-on-the-remote). Default `false`. |

> 💡 Set [`uploadOnSave`](#uploadonsave) to `false` when watching everything (`"**/*"`) — otherwise every save triggers both mechanisms.

```json
{
  "watcher": {
    "files": "dist/*.{js,css}",
    "autoUpload": true,
    "autoDelete": false,
    "autoRename": true
  },
  "profiles": {
    "dev": {},
    "prod": {
      "watcher": { "files": false }
    }
  }
}
```

#### remoteTimeOffsetInHours
Hours of clock difference between the remote server and your machine (**remote minus local**). Needed for accurate timestamp-based [sync](#sync-commands) when the server is in another timezone or its clock drifts.

> **FTP note:** servers that support the `MLSD` command (e.g. pure-ftpd, ProFTPD) report exact UTC timestamps, so this option should normally stay `0` for them. It's mainly needed for FTP servers limited to `LIST` (e.g. vsftpd), whose listings carry only server-local, minute-precision dates, and for SFTP servers with a skewed clock.

| Key | Type | Default |
| --- | --- | --- |
| `remoteTimeOffsetInHours` | number | `0` |

#### remoteExplorer
Tunes the [Remote Explorer](#using-the-remote-explorer) view.

| Key | Type | Default |
| --- | --- | --- |
| `remoteExplorer` | object | `{}` |

| Sub-option | Type | Effect |
| --- | --- | --- |
| `remoteExplorer.filesExclude` | string[] | Patterns for files/folders to hide in the Remote Explorer. |
| `remoteExplorer.order` | number | Sort position of this config among Remote Explorer roots (default `0`). |
| `remoteExplorer.enableDragAndDrop` | boolean | Allow dragging an item onto a folder in the Remote Explorer to move it there with a single server-side rename. Default `false`. See [Renaming and moving files](#renaming-and-moving-files-on-the-remote). |

```json
{
  "remoteExplorer": {
    "filesExclude": ["**/node_modules"],
    "order": 1,
    "enableDragAndDrop": true
  }
}
```

#### concurrency
Maximum simultaneous transfers. It also bounds how many directory listings the scan of a folder transfer or sync issues at once, so a large tree can't flood a single connection with requests. Lower it if your server limits concurrent connections/operations. FTP always uses `1`.

| Key | Type | Default |
| --- | --- | --- |
| `concurrency` | number | `4` |

#### connectTimeout
Maximum time (ms) to wait when establishing a connection.

| Key | Type | Default |
| --- | --- | --- |
| `connectTimeout` | number | `10000` |

Resolved in that order: this option if you set it, otherwise `ConnectTimeout` from your [ssh config](#sshconfigpath) (which states it in seconds), otherwise `10000`.

#### limitOpenFilesOnRemote
Cap the number of file descriptors opened on the remote server. Set `true` for the default limit (222), or a number for a custom limit (values below 127 are raised to 127). Use it if transfers fail with the generic [`Error: Failure`](#error-failure) because the server runs out of descriptors.

> 💡 **Do not set this unless you have to.**

> ℹ️ Broken between the `ssh2` 1.x upgrade and **1.26.3** — setting it threw `Cannot read properties of undefined (reading 'open')` and no connection could be established. Update to 1.26.3 or later if you need it.

| Key | Type | Default |
| --- | --- | --- |
| `limitOpenFilesOnRemote` | boolean \| number | `false` |

#### profiles
A collection of named profiles keyed by profile name. Each profile is merged over the top-level config; switch with `SFTP: Set Profile`. See [Profiles (dev / prod)](#profiles-dev--prod).

| Key | Type |
| --- | --- |
| `profiles` | object |
| `defaultProfile` | string — profile activated by default |

#### remote
Reference a connection defined in User Settings under `remotefs.remote` instead of repeating host details per project. See [Configuration in User Settings](#configuration-in-user-settings-remote-fs).

| Key | Type |
| --- | --- |
| `remote` | string |

#### retry
Re-runs a transfer automatically when it fails for a transient reason — dropped/reset connection, timeout, closed SSH channel, FTP 4xx. Things that'll just fail the same way again (permission denied, file not found, FTP 5xx) don't get retried — no point.

Backoff doubles each attempt (`delay × 2ⁿ`, capped at 15s) — so the defaults give you 2s, then 4s. `attempts: 0` turns it off entirely.

| Key | Type | Default |
| --- | --- | --- |
| `retry` | object | `{ "attempts": 2, "delay": 1000 }` |

| Sub-option | Type | Effect |
| --- | --- | --- |
| `retry.attempts` | number | How many extra attempts a failed transfer gets (default `2`). |
| `retry.delay` | number | Base backoff in ms, doubled on every attempt (default `1000`). |

```json
{
  "retry": {
    "attempts": 3,
    "delay": 2000
  }
}
```

#### idleTimeout
Some shared hosts quietly close an idle connection after a few minutes without telling anyone. SFTPresso would otherwise keep handing that connection out of its pool, and your next upload just hangs on a socket that's never going to answer — until you reload the window.

Set `idleTimeout` and a connection that's been sitting unused that long gets a cheap health check (SFTP `realpath`, FTP `NOOP`) before it's reused. Answers fine → reused as normal. Doesn't answer → dropped, and a fresh connection opens instead.

Set it a bit under whatever your host's actual limit is — if it drops connections at 5 minutes, `240000` (4 min) gives some margin.

| Key | Type | Default |
| --- | --- | --- |
| `idleTimeout` | number | `0` (never checked) |

```jsonc
{
  // check the connection before reusing it after 4 minutes of inactivity
  "idleTimeout": 240000
}
```

When the check passes it's invisible — a healthy server just answers and things carry on, so a working `idleTimeout` looks identical to one that isn't doing anything. To actually confirm it's active, turn on `sftp.debug` and watch the **SFTP** output channel:

```
[debug] probing connection after 301204ms idle (timeout 10000ms)
[debug] probe answered, reusing the connection
```

A reconnect is reported at info level, so that line appears whether or not `sftp.debug` is on:

```
[info] reconnecting: idle connection did not answer in 10000ms (idle for 301204ms)
```

> ℹ️ It only checks on reuse, not on a timer, so it can't interrupt a transfer that's still running. The trade-off: the socket stays open while idle instead of being closed proactively, so if your host counts concurrent connections rather than killing idle ones, this won't help with that.

#### stallTimeout
`idleTimeout` catches a connection that died *between* operations. This one catches the other case — a connection that dies mid-transfer, where the bytes just stop arriving and there's no error to react to, so the upload would otherwise wait forever.

With `stallTimeout` set, a transfer that goes that long without a single byte moving gets failed instead of left hanging — and it's classified the same as a dropped connection, so [`retry`](#retry) picks it up and tries again automatically.

The clock resets on every chunk received, so this is measuring *stalls*, not total transfer time — a huge file crawling over a slow link keeps resetting the timer and never trips it. 30–60 seconds is a reasonable starting point.

| Key | Type | Default |
| --- | --- | --- |
| `stallTimeout` | number | `0` (wait indefinitely) |

```jsonc
{
  // give up on a transfer that hasn't moved a byte in 30 seconds
  "stallTimeout": 30000,
  "retry": { "attempts": 2 }
}
```

#### operationTimeout
The third way a connection can go quiet, and the only one of the three that's on by default.

`idleTimeout` and `stallTimeout` cover the connection dying between operations or mid-transfer. What's left is everything around a transfer — the `mkdir`, the directory listing behind a sync, a `stat`, a rename. A server can keep the SSH transport up and answer keepalives just fine while the SFTP subsystem behind it stops reading its channel — every request just queues up locally with nothing ever answering back, and there's no error to catch.

`operationTimeout` fails any single request that goes unanswered that long with `ETIMEDOUT` and drops the connection, so the next command starts fresh instead of inheriting a dead one — and since that failure is retryable, [`retry`](#retry) picks it up.

It's one round trip, not a whole operation — transfers aren't affected (that's `stallTimeout`'s job), and a multi-step operation like `ensureDir` creating four directories gets four separate deadlines rather than one shared one.

| Key | Type | Default |
| --- | --- | --- |
| `operationTimeout` | number | `60000` |

```jsonc
{
  // a request that goes 30 seconds without an answer is treated as lost
  "operationTimeout": 30000
}
```

A timeout is reported at warn level, so the line appears whether or not `sftp.debug` is on:

```
[warn] remote operation "mkdir" did not answer within 60000ms; dropping the connection
```

> ℹ️ SFTP only. FTP is already covered by [`connectTimeout`](#connecttimeout), which the FTP client applies as an idle timeout on both the control and data sockets. Setting `operationTimeout` on an FTP config is accepted and ignored.

> ⚠️ Unlike the two above, this one's on by default — a full minute with no reply isn't "slow," it's lost, and the alternative is an extension stuck until you reload the window. Got a genuinely slow server tripping this by accident? Raise the number rather than disabling it; `0` goes back to waiting forever.

#### remoteCommands
Labeled shell commands offered by [`SFTP: Run Remote Command`](#configuration-and-connection-commands) as a quick pick, instead of a blank prompt every time. Each command runs over the existing pooled SSH connection.

| Key | Type | Default |
| --- | --- | --- |
| `remoteCommands` | object (label → command string) | *(none)* |

```jsonc
{
  "remoteCommands": {
    "Restart PHP": "sudo systemctl reload php8.3-fpm",
    "Clear cache": "php artisan cache:clear"
  }
}
```

Editing this doesn't invalidate the pooled connection — it's read fresh on every run, not baked into the connection identity.

> ℹ️ SFTP only. Running a command against an FTP config fails with a clear error rather than attempting it — FTP has no remote shell to run one on.

#### remoteCommandTimeout
How long, in milliseconds, a command started by [`SFTP: Run Remote Command`](#configuration-and-connection-commands) may run before it is killed and reported as timed out.

| Key | Type | Default |
| --- | --- | --- |
| `remoteCommandTimeout` | number | `60000` |

```jsonc
{
  // give a long migration more room before it's killed
  "remoteCommandTimeout": 300000
}
```

> ℹ️ OpenSSH's server does not act on the kill request for a plain (non-pty) exec session, so a command that times out may keep running on the server after SFTPresso reports it as timed out — the SSH channel is closed on this end, but the remote process is not guaranteed to be. SFTP only.

### SFTP-only options

#### agent
Path to the ssh-agent UNIX socket for agent-based authentication (usually `$SSH_AUTH_SOCK`). Windows users: set to `pageant` to authenticate with Pageant, or the path to a Cygwin "UNIX socket".

| Key | Type |
| --- | --- |
| `agent` | string |

```json
{ "agent": "/run/user/1000/ssh-agent.socket" }
```

#### privateKeyPath
Absolute path to your private key file.

| Key | Type |
| --- | --- |
| `privateKeyPath` | string |

```json
{ "privateKeyPath": "/Users/me/.ssh/id_rsa" }
```

#### passphrase
Passphrase for an encrypted private key. Set the string itself, or set `true` to be prompted with a dialog (keeps the passphrase out of the config file — recommended).

| Key | Type |
| --- | --- |
| `passphrase` | string \| boolean |

```json
{ "passphrase": true }
```

#### interactiveAuth
Enable keyboard-interactive authentication (e.g. multi-factor / Google Authenticator). Set `true` for a verification-code dialog, or pass an array of predefined responses to answer prompts automatically.

> 💡 Requires the server to have keyboard-interactive authentication enabled.

| Key | Type | Default |
| --- | --- | --- |
| `interactiveAuth` | boolean \| string[] | `false` |

```json
{ "interactiveAuth": true }
```

#### algorithms
Explicit overrides for the SSH transport-layer algorithms. Mainly needed for older servers — see [Error: Connection closed](#error-connection-closed).

Default:

```json
{
  "algorithms": {
    "kex": [
      "ecdh-sha2-nistp256",
      "ecdh-sha2-nistp384",
      "ecdh-sha2-nistp521",
      "diffie-hellman-group-exchange-sha256"
    ],
    "cipher": [
      "aes128-gcm",
      "aes128-gcm@openssh.com",
      "aes256-gcm",
      "aes256-gcm@openssh.com",
      "aes128-cbc",
      "aes192-cbc",
      "aes256-cbc",
      "aes128-ctr",
      "aes192-ctr",
      "aes256-ctr"
    ],
    "serverHostKey": [
      "ssh-rsa",
      "ssh-dss",
      "ssh-ed25519",
      "ecdsa-sha2-nistp256",
      "ecdsa-sha2-nistp384",
      "ecdsa-sha2-nistp521",
      "rsa-sha2-512",
      "rsa-sha2-256"
    ],
    "hmac": [
      "hmac-sha2-256",
      "hmac-sha2-512"
    ]
  }
}
```

#### sshConfigPath
Path to your OpenSSH client config file; settings for this config's [`host`](#host) are resolved the way `ssh` itself does — literal `Host` entries, wildcard `Host` patterns (`Host *.example.com`), and `Match` blocks are all considered, in file order, per `ssh_config(5)` precedence.

| Key | Type | Default |
| --- | --- | --- |
| `sshConfigPath` | string | `~/.ssh/config` |

Six directives are read:

| Directive | Fills in | Notes |
| --- | --- | --- |
| `HostName` | [`host`](#host) | Always applied — this is the point of an alias. |
| `Port` | [`port`](#port) | |
| `User` | [`username`](#username) | |
| `IdentityFile` | [`privateKeyPath`](#privatekeypath) | The first line found wins if it's set more than once. |
| `ConnectTimeout` | [`connectTimeout`](#connecttimeout) | Seconds in `ssh_config`, converted to ms. |
| `ServerAliveInterval` | [`keepaliveInterval`](#keepaliveinterval) | Seconds in `ssh_config`, converted to ms. |

Except for `HostName`, a value you set in `sftp.json` wins — the ssh config only fills in what you left out. `ConnectTimeout` and `ServerAliveInterval` are ignored, with a warning in the output channel, if their value isn't a number of seconds.

> ℹ️ Both `ServerAliveInterval` and wildcard/`Match`-style `Host` entries are read correctly as of 1.30.1 — earlier versions parsed them and then quietly threw the values away. If you're setting a short `ServerAliveInterval` for the first time on an upgrade, expect more keepalive traffic than before; that's this taking effect, not a bug.

#### sshCustomParams
Extra parameters appended to the `ssh` command used by `SFTP: Open SSH in Terminal`.

| Key | Type |
| --- | --- |
| `sshCustomParams` | string |

```json
{ "sshCustomParams": "-g" }
```

#### hop
Connect through one or more intermediate SSH hosts. A single object for one hop, or an array for multiple. See [Connection hopping](#connection-hopping-ssh-proxy--bastion). Each hop accepts the same host/auth options (`host`, `port`, `username`, `privateKeyPath`, …).

> Variable substitution does not work inside a hop configuration.

| Key | Type |
| --- | --- |
| `hop` | object \| object[] |

Every host in the chain has its own host key checked in its own right — a bastion is exactly as impersonatable as the server behind it. Hops inherit the config's [`strictHostKeyChecking`](#stricthostkeychecking) unless they set their own.

#### strictHostKeyChecking
Controls how the server's SSH host key is checked, mirroring OpenSSH's option of the same name. See [Host key verification](#host-key-verification) for what the values mean and how the store works.

| Key | Type | Default |
| --- | --- | --- |
| `strictHostKeyChecking` | `true` \| `false` \| `"ask"` \| `"accept-new"` | `"accept-new"` |

```json
{ "strictHostKeyChecking": "ask" }
```

| Value | Unknown host | Changed key |
| --- | --- | --- |
| `"accept-new"` (default) | Trusted and remembered, no prompt | **Refused** |
| `"ask"` | Prompted with the fingerprint | **Refused** |
| `true` | **Refused** | **Refused** |
| `false` | Trusted and remembered, no prompt | Allowed, with a warning in the log |

A key marked `@revoked` in a known_hosts file is refused under every value, as is a certificate host key (SFTPresso cannot validate one).

> ℹ️ SFTP only. Setting it on an FTP config is accepted and ignored.

#### keepaliveInterval
How often an SSH keepalive packet goes out, in milliseconds. Mainly there for NATs/firewalls that silently drop an unused mapping, or hosts that reap connections that have gone quiet — without this, the next operation just hangs against a socket nobody's listening on anymore.

| Key | Type | Default |
| --- | --- | --- |
| `keepaliveInterval` | number | `30000` |

Resolved in that order: this option if you set it, otherwise `ServerAliveInterval` from your [ssh config](#sshconfigpath) (which states it in seconds), otherwise `30000`. Set to `0` to disable keepalive packets entirely.

```jsonc
{
  // a host that reaps idle connections after 45s needs a shorter grace period
  // than the 60s the default 30000ms / x2 gives it
  "keepaliveInterval": 15000
}
```

> ℹ️ SFTP only.

#### keepaliveCountMax
How many consecutive keepalive packets may go unanswered before the connection is considered dead and torn down. Paired with [`keepaliveInterval`](#keepaliveinterval), an unresponsive server is given up on after roughly `keepaliveInterval × keepaliveCountMax` milliseconds.

| Key | Type | Default |
| --- | --- | --- |
| `keepaliveCountMax` | number | `2` |

```jsonc
{
  // more tolerance for a link that occasionally drops a packet
  "keepaliveCountMax": 4
}
```

> ℹ️ SFTP only.

### FTP(S)-only options

#### secure
Connection encryption mode:

- `true` — encrypt both control and data connections (explicit FTPS)
- `"control"` — encrypt the control connection only
- `"implicit"` — implicitly encrypted control connection (legacy; usually port 990)

| Key | Type | Default |
| --- | --- | --- |
| `secure` | boolean \| `"control"` \| `"implicit"` | `false` |

```json
{ "protocol": "ftp", "port": 21, "secure": true }
```

#### secureOptions
Extra options passed straight to Node's [`tls.connect()`](https://nodejs.org/api/tls.html#tls_tls_connect_options_callback) — e.g. to accept a self-signed certificate.

| Key | Type |
| --- | --- |
| `secureOptions` | object |

```json
{ "secureOptions": { "rejectUnauthorized": false } }
```

### VS Code extension settings

These are regular VS Code settings (`File → Preferences → Settings`, or `settings.json`), separate from `sftp.json`:

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `sftp.debug` | boolean | `false` | Print debug output to the `sftp` Output channel. **Reload VS Code after changing.** |
| `sftp.printDebugLog` | boolean | `false` | **Deprecated** — use `sftp.debug` instead. Still honored for backward compatibility. |
| `sftp.downloadWhenOpenInRemoteExplorer` | boolean | `false` | When opening a file in the Remote Explorer, download it ("Edit in Local") instead of showing a read-only "View Content". |

---

## 5. Usage Examples and Common Workflows

### Simple single-server setup

The minimum viable config — SFTP on port 22, prompted for the password:

```json
{
  "host": "host",
  "username": "username",
  "remotePath": "/remote/workspace"
}
```

### Start from a remote project

If the latest files already live on the server, start with an **empty local folder**:

1. Open the empty folder in VS Code and run `SFTP: Config` (see [First-time setup](#first-time-setup)).
2. Set `remotePath` to the server directory you want.
3. Run **`SFTP: Download Project`** — the remote tree is downloaded into your workspace.
4. From here on, edit locally and upload/sync as needed.

### Upload on save

Mirror every save to the server:

```json
{
  "host": "server.example.com",
  "username": "deploy",
  "remotePath": "/var/www/site",
  "uploadOnSave": true
}
```

If your site is live, add temp-file/atomic uploads so visitors never see a half-written file:

```json
{
  "uploadOnSave": true,
  "useTempFile": true,
  "openSsh": true
}
```

(See [`useTempFile`](#usetempfile) and [`openSsh`](#openssh).)

If others deploy to the same server, add [`conflictCheck`](#conflictcheck) so a save can't quietly overwrite a change you never pulled down:

```json
{
  "uploadOnSave": true,
  "conflictCheck": true
}
```

### Profiles (dev / prod)

One config, several environments. Profile values merge over the top-level config; switch with **`SFTP: Set Profile`**.

When a config defines profiles, the status bar item shows the active profile (e.g. **`SFTP: dev`**, or **`SFTP: (no profile)`** when none is active), and clicking it opens the profile picker — same as running `SFTP: Set Profile`. Without profiles, the status bar keeps its usual behavior (shows `SFTP`, click to toggle the output panel).

```json
{
  "username": "username",
  "password": "password",
  "remotePath": "/remote/workspace/a",
  "watcher": {
    "files": "dist/*.{js,css}",
    "autoUpload": false,
    "autoDelete": false
  },
  "profiles": {
    "dev": {
      "host": "dev-host",
      "remotePath": "/dev",
      "uploadOnSave": true
    },
    "prod": {
      "host": "prod-host",
      "remotePath": "/prod"
    }
  },
  "defaultProfile": "dev"
}
```

> `context` is only available at the root level, not inside a profile. [`watcher`](#watcher) may be set at either — a profile's watcher is merged one level over the root one while that profile is active, so `{ "autoUpload": false }` turns uploads off for production without losing the root's other watcher settings (`files`, `autoDelete`, etc.). `syncOption` and `remoteExplorer` merge the same way when set inside a profile.

To deploy to every environment at once, use the **`… To All Profiles`** [upload commands](#upload-commands).

### Multiple contexts (array config)

Map different workspace subfolders to different servers (or different remote paths). The `context` values must differ, and `name` is **required**:

```json
[
  {
    "name": "server1",
    "context": "project/build",
    "host": "host",
    "username": "username",
    "password": "password",
    "remotePath": "/remote/project/build"
  },
  {
    "name": "server2",
    "context": "project/src",
    "host": "host",
    "username": "username",
    "password": "password",
    "remotePath": "/remote/project/src"
  }
]
```

### Connection hopping (SSH proxy / bastion)

Reach a target server through an intermediate host with the SSH protocol. Note: variable substitution does not work in a hop configuration.

**Single hop** (`local → hop → target`):

```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  "host": "hopHost",
  "username": "hopUsername",
  "privateKeyPath": "/Users/localUser/.ssh/id_rsa",

  "hop": {
    "host": "targetHost",
    "username": "targetUsername",
    "privateKeyPath": "/Users/hopUser/.ssh/id_rsa"
  }
}
```

The top-level `privateKeyPath` is a file **on your local machine**; the one inside `hop` is a file **on the hop host**.

**Multiple hops** (`local → hopA → hopB → target`): make `hop` an array — each entry authenticates from the previous host, and the last entry is the target:

```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  "host": "hopAHost",
  "username": "hopAUsername",
  "privateKeyPath": "/Users/localUser/.ssh/id_rsa",

  "hop": [
    {
      "host": "hopBHost",
      "username": "hopBUsername",
      "privateKeyPath": "/Users/hopAUser/.ssh/id_rsa"
    },
    {
      "host": "targetHost",
      "username": "targetUsername",
      "privateKeyPath": "/Users/hopBUser/.ssh/id_rsa"
    }
  ]
}
```

### Two-way automatic sync with the watcher

Keep the server updated with **no manual interaction** — including changes made outside VS Code, e.g. when Git checks out a branch or reverts commits:

```json
{
  "name": "My Server",
  "host": "<host_ip_address>",
  "protocol": "sftp",
  "port": 22,
  "username": "user1",
  "remotePath": "/folder1/folder2/folder3",
  "uploadOnSave": false,
  "watcher": {
    "files": "**/*",
    "autoUpload": true,
    "autoDelete": true,
    "autoRename": true
  },
  "syncOption": {
    "delete": true
  }
}
```

Keep `uploadOnSave` **false** here — the watcher already covers saves when watching `**/*` (see [`watcher`](#watcher)). `autoRename` here means a rename or move made in VS Code's own Explorer moves the remote copy instead of deleting and re-uploading it — see [Renaming and moving files](#renaming-and-moving-files-on-the-remote). It doesn't extend to `git checkout` or other tools that write straight to disk outside VS Code; those are still handled as a plain delete-and-create.

### Renaming and moving files on the remote

Used to be that renaming or moving something meant a full re-upload — of everything inside it, if it was a directory. Now it's just a single remote `rename()` call regardless of size, in three places:

**From the Remote Explorer.** Right-click a file or folder and choose **Rename**. Type a new name — including a path with `/` to move it into a subfolder — and confirm. The move is refused (with a clear message, nothing is touched) if the destination already exists, falls outside [`remotePath`](#remotepath), or would move a folder into itself.

**By dragging within the Remote Explorer.** Set [`remoteExplorer.enableDragAndDrop`](#remoteexplorer) to `true`, then drag a file or folder onto another folder in the tree to move it there — the same single `rename()` call as the **Rename** command, just started with a drag instead of a right-click. Off by default. Dragging more than one selected item asks for one confirmation covering the whole batch; a single item moves immediately. Refused, with a message, in the same cases the Rename command refuses (existing destination, moving a folder into itself or a descendant), plus a drag between two different configured roots and dragging a connection's root item itself.

**Automatically, for renames and moves made in VS Code's own Explorer.** Set `watcher.autoRename` to `true` and a rename VS Code reports — F2, drag-and-drop, cut-and-paste-as-move, all in VS Code's Explorer — is turned into the same single server-side rename instead of the delete-then-upload the watcher would otherwise do:

```json
{
  "watcher": {
    "files": "**/*",
    "autoUpload": true,
    "autoDelete": true,
    "autoRename": true
  }
}
```

Worth knowing:

- Only fires for renames VS Code itself reports — its Explorer, or anything going through VS Code's rename API. An external tool writing straight to disk still looks like a delete-and-create, same as always.
- Moving something into a *different* configured root can't be a single rename (there's nothing on that remote for the old path to reach), so it falls back to upload-then-delete instead — new path first, old path removed after, never the other order.
- Same fallback for any other rename failure — permissions, a dropped connection, whatever. The remote copy is never deleted before its replacement actually exists.
- Off by default, and only affects renames — doesn't change what `autoUpload`/`autoDelete` do otherwise.

### Uploading a folder's contents without the folder itself

Set [`context`](#context) to the folder — its *contents* then map directly onto `remotePath`. Here everything in `./build` lands in `/folder1/folder2/folder3` (with only JS/HTML auto-uploaded by the watcher):

```json
{
  "name": "My Server",
  "host": "<host_ip_address>",
  "protocol": "sftp",
  "port": 22,
  "username": "user1",
  "remotePath": "/folder1/folder2/folder3",
  "context": "./build",
  "uploadOnSave": false,
  "watcher": {
    "files": "*.{js,html}",
    "autoUpload": true,
    "autoDelete": false
  }
}
```

### Configuration in User Settings (remote-fs)

Define connections once in User Settings (via [remote-fs](https://github.com/liximomo/vscode-remote-fs)) and reference them by name from any project's `sftp.json` with the [`remote`](#remote) option.

In **User Settings**:

```json
"remotefs.remote": {
  "dev": {
    "scheme": "sftp",
    "host": "host",
    "username": "username",
    "rootPath": "/path/to/somewhere"
  },
  "projectX": {
    "scheme": "sftp",
    "host": "host",
    "username": "username",
    "privateKeyPath": "/Users/xx/.ssh/id_rsa",
    "rootPath": "/home/foo/some/projectx"
  }
}
```

In **sftp.json**:

```json
{
  "remote": "dev",
  "remotePath": "/home/xx/",
  "uploadOnSave": false,
  "ignore": [".vscode", ".git", ".DS_Store"]
}
```

### Using the Remote Explorer

Open it by clicking the **SFTP** icon in the Activity Bar, or run `View: Show SFTP`.

- Browsing opens files in a **read-only** view by default. Run **`SFTP: Edit in Local`** (context menu) to download a file into the workspace for editing — or flip the [`sftp.downloadWhenOpenInRemoteExplorer`](#vs-code-extension-settings) setting to make downloading the default.
- **Multi-select** works like the regular explorer: hold `Ctrl`/`Cmd` or `Shift` while clicking to select several files/folders, then upload or download them all at once.
- Create, rename/move, and delete remote files/folders from the context menu ([file commands](#remote-explorer-and-file-commands)) — rename/move is a single remote operation regardless of size, see [Renaming and moving files](#renaming-and-moving-files-on-the-remote).
- **Drag a file or folder onto another folder** in the tree to move it there, once [`remoteExplorer.enableDragAndDrop`](#remoteexplorer) is turned on (off by default) — see [Renaming and moving files](#renaming-and-moving-files-on-the-remote).
- Hide noise (e.g. `node_modules`) with [`remoteExplorer.filesExclude`](#remoteexplorer), and control root ordering with `remoteExplorer.order`.
- **Filter** the tree with **`SFTP: Filter Remote Explorer`** (funnel icon in the view title) — typing live-narrows the tree to matching names and the folders leading to them, even inside folders you haven't opened yet. **`SFTP: Clear Filter`** resets it, and the view title shows the active query while it's on. Substring match only for now. VS Code's own `workbench.list.keyboardNavigation: filter` setting is a handy complement for searching within a folder you've already expanded.
- After a **delete**, manually refresh the parent folder if the tree doesn't update on its own (known issue).

### Monitoring and cancelling transfers

During bulk operations (folder upload/download, sync, project transfers):

- The **status bar** shows a live "Transferring X/Y files" counter, plus the combined transfer speed across every in-flight file once it's available — click the counter to cancel everything.
- The **Transfers** view in the SFTP sidebar lists each file with its status (queued / transferring / failed) and an inline **✕** button to cancel just that file.
- While a file is transferring, its row shows **byte-level progress**, current **speed**, and, once the total size is known, an **ETA** in the description — e.g. `42% — 3.1 MB / 7.4 MB — 1.2 MB/s — ETA 00:04`, or just bytes and speed when the total size isn't known. The speed and ETA are computed from a rolling window of recent progress and appear a moment into the transfer, once enough samples have been collected. Updates are throttled to a couple per second per file.
- A failed transfer keeps its row (marked *failed*) with an inline **↻ Retry** button (`sftp.retryTransfer`). Retrying re-queues just that file with its original direction and options and resets its status to *queued*.
- `SFTP: Cancel All Transfers` is also available from the Command Palette and the Transfers view title bar. It stops the directory scan as well as the queued transfers, so cancelling a large folder or project transfer takes effect immediately instead of after the whole tree has been walked.

### Comparing folders with the remote

Right-click any folder (or run **`SFTP: Compare Folders with Remote`**) to get a recursive diff against its remote counterpart. Results are grouped into **new-local**, **new-remote**, and **modified** files; picking a file offers per-file actions to open a diff, upload, or download. Use it before a sync to preview exactly what would change.

A directory that couldn't be listed on either side is reported as **Could not read** rather than being folded into the diff, and its subtree is left out entirely — nothing is known about what is inside it, so it offers no transfer actions. If the folder you are comparing can't be read at all, the command reports the error instead of showing an empty comparison.

---

## 6. Best Practices

A few habits that'll save you a bad afternoon:

- `password`/`passphrase` sit in `sftp.json` as plain text, so don't commit that file if it has either — put it in `.gitignore`, and use [secret storage](#storing-passwords-securely) or key-based auth ([`privateKeyPath`](#privatekeypath)/[`agent`](#agent)) instead where you can.
- Add the obvious noise to [`ignore`](#ignore) — `/.git`, `/.vscode`, `node_modules`, build caches, `.DS_Store`. Faster transfers, and you're not cluttering the server with things it doesn't need. The [Force commands](#force-alt-commands) cover the rare exception.
- Before running a folder upload/Sync on a project you don't fully know, set [`maxFileSize`](#maxfilesize) — otherwise the first sign of that stray database dump or `.iso` in the tree is the transfer still running twenty minutes later.
- On a live site, turn on [`useTempFile`](#usetempfile) (and `openSsh` if the server supports it) so nobody ever loads a half-written file mid-deploy.
- Don't run [`uploadOnSave`](#uploadonsave) and a broad `watcher` (`"**/*"` + `autoUpload`) at the same time — that's just double uploads for no reason, pick one.
- `syncOption.delete` and `watcher.autoDelete` actually remove things on the other end, so keep [`syncConfirm`](#syncconfirm) on (it already defaults on whenever `delete` is) and run [Compare Folders](#comparing-folders-with-the-remote) first if you're not sure what a sync is about to do.
- If the server's clock is off, set [`remoteTimeOffsetInHours`](#remotetimeoffsetinhours) — otherwise timestamp-based sync can end up copying in the wrong direction.
- Shared hosts often choke on too many simultaneous SFTP operations; dropping `concurrency` to 1–3 trades some speed for not getting rate-limited.
- After touching `sftp.json`, just run `SFTP: Test Connection` — cheaper than finding the typo mid-upload.
- Profiles beat juggling several config files for dev/staging/prod, and don't forget the `… To All Profiles` commands exist for the day a release needs to land everywhere at once.

---

## 7. Troubleshooting and Known Issues

### Enabling debug logs

1. Open Settings (`File → Preferences → Settings`, or `Code → Preferences → Settings` on macOS).
2. Set `sftp.debug` to `true` and **reload VS Code**.
3. View the logs in `View → Output` and select the **sftp** channel.

If a connection drops mid-session, the underlying error is logged there (since 1.16.5) instead of being silently discarded.

### SSH connection error messages

As of 1.16.5, common SSH failures surface as plain-language messages instead of raw `ssh2` errors:

| Message | Meaning |
| --- | --- |
| **Connection refused** | Nothing is listening on the configured host/port, or a firewall is blocking it. |
| **Connection timed out** | Host unreachable — wrong address, network/VPN issue, or a firewall silently dropping packets. |
| **Host not found** | Hostname couldn't be resolved; check for typos or DNS issues. |
| **Authentication failed** | Username, password, or private key was rejected by the server. |

Check the `sftp` Output channel (see [Enabling debug logs](#enabling-debug-logs)) for the underlying detail.

### FTPS transfers fail after connecting (TLS session reuse)

With `secure: true`, some servers (notably pure-ftpd) require the data connection to reuse the control connection's TLS session, which can fail under TLS 1.3 with errors like *"Client network socket disconnected before secure TLS connection was established"* on every listing or transfer, even though the connection itself succeeds. Cap the TLS version via [`secureOptions`](#secureoptions):

```json
{ "secureOptions": { "maxVersion": "TLSv1.2" } }
```

### Error: Failure

This generic message comes from the **remote** SFTP server when a syscall fails. To pinpoint it, enable debug output on the *server* side and retry. Two common causes:

1. **`remotePath` points at a symlink** — change it to the actual (resolved) path.
2. **The server ran out of file descriptors** — raise the server's descriptor limit, or if you can't, set [`limitOpenFilesOnRemote`](#limitopenfilesonremote) in `sftp.json`.

### Error: Connection closed

On legacy/old servers the connection may keep closing because of a key-exchange algorithm mismatch. Override the [`algorithms`](#algorithms) to drop `diffie-hellman-group-exchange-sha256` from `kex`:

```json
{
  "algorithms": {
    "kex": [
      "ecdh-sha2-nistp256",
      "ecdh-sha2-nistp384",
      "ecdh-sha2-nistp521"
    ],
    "cipher": [
      "aes128-gcm",
      "aes128-gcm@openssh.com",
      "aes256-gcm",
      "aes256-gcm@openssh.com",
      "aes128-cbc",
      "aes192-cbc",
      "aes256-cbc",
      "aes128-ctr",
      "aes192-ctr",
      "aes256-ctr"
    ],
    "serverHostKey": [
      "ssh-rsa",
      "ssh-dss",
      "ssh-ed25519",
      "ecdsa-sha2-nistp256",
      "ecdsa-sha2-nistp384",
      "ecdsa-sha2-nistp521",
      "rsa-sha2-256",
      "rsa-sha2-512"
    ],
    "hmac": [
      "hmac-sha2-256",
      "hmac-sha2-512"
    ]
  }
}
```

### ENFILE: file table overflow (macOS)

macOS has a harsh default limit on open files. Raise it:

```sh
echo kern.maxfiles=65536 | sudo tee -a /etc/sysctl.conf
echo kern.maxfilesperproc=65536 | sudo tee -a /etc/sysctl.conf
sudo sysctl -w kern.maxfiles=65536
sudo sysctl -w kern.maxfilesperproc=65536
ulimit -n 65536
```

### Upload Changed Files does nothing

Historically the command was hidden and had no shortcut (see [liximomo/vscode-sftp#854](https://github.com/liximomo/vscode-sftp/issues/854)). It is now visible in the Command Palette and Source Control view and bound to `Ctrl+Alt+U` by default. It requires a Git repository with at least one commit — it uploads files changed or created **since the last commit**.

### Remote Explorer not refreshing after delete

After deleting a remote file, the tree may not update — manually refresh the parent folder (the ↻ button or `sftp.remoteExplorer.refresh`).

### Known issues fixed in this fork

All fixed on `develop` now, kept here mostly for anyone who hits an old bug report and wonders if it's still true:

- `TypeError: isDate is not a function` on upload/download — a Node/`ssh2` incompatibility, patched via `patch-package`.
- Compile errors and Jest/`memfs` breakage that used to hit a fresh checkout — gone, `npm run compile` and `npm test` both pass cleanly now.
- Two remotes could end up sharing one pooled connection if their configs differed only in something like `hop` or `algorithms` — occasionally sent a transfer to the wrong server. Fixed in 1.26.3 by hashing the connection options properly instead of just concatenating them.
- `limitOpenFilesOnRemote` broke every connection that set it, throwing at connect time — an internal `ssh2` API it depended on had been removed in the 1.x upgrade. Fixed in 1.26.3.
- `syncOption.delete` fired its deletions without waiting for them, so a sync could report success while files were actually still sitting on the remote. Fixed in 1.26.3.

---

## 8. Frequently Asked Questions

**Q: How do I upload the contents of a folder, but not the folder itself?**
Set [`context`](#context) to that folder (e.g. `"context": "./build"`) — its contents then map directly to `remotePath`. Full example: [Uploading a folder's contents without the folder itself](#uploading-a-folders-contents-without-the-folder-itself).

**Q: How can I upload files as root?**
A community workaround (may not work everywhere — see [liximomo/vscode-sftp#559](https://github.com/liximomo/vscode-sftp/issues/559)) is:

```json
"sshCustomParams": "sudo su -;"
```

**Q: How do I sync both ways automatically, without any user interaction?**
Use a watcher on `**/*` with `autoUpload`/`autoDelete` plus `syncOption.delete` — full config in [Two-way automatic sync with the watcher](#two-way-automatic-sync-with-the-watcher). This also keeps the server updated when Git changes files (branch checkout, revert).

**Q: Why don't I see dotfiles/hidden files in the Remote Explorer?**
Often a server-side listing setting. With **proftpd**, edit `proftpd.conf` (commonly `/etc/proftpd.conf`, `/etc/proftpd/proftpd.conf`, `/usr/local/etc/proftpd.conf`, or `/usr/local/etc/proftpd/proftpd.conf`) and change `ListOptions "-l"` to `ListOptions "-la"`:

```conf
<Global>
ListOptions "-la"
</Global>
```

**Q: Do I have to store my password in `sftp.json`?**
No — leave `password` out and you'll be prompted on connect, with an offer to remember the password in VS Code's secret storage. You can also save it up front with `SFTP: Save Password` (see [Storing passwords securely](#storing-passwords-securely)). Better yet, use key-based auth (see [Best Practices](#6-best-practices)).

**Q: What do the "Connection refused" / "Connection timed out" / "Host not found" / "Authentication failed" messages mean?**
See [SSH connection error messages](#ssh-connection-error-messages).

**Q: Can I edit files directly in the Remote Explorer?**
Files open read-only by default — use `SFTP: Edit in Local`, or set `sftp.downloadWhenOpenInRemoteExplorer` to make opening a file download it. See [Using the Remote Explorer](#using-the-remote-explorer).

**Q: Sync copies files in the wrong direction / re-uploads unchanged files.**
Sync is timestamp-based; correct clock/timezone differences with [`remoteTimeOffsetInHours`](#remotetimeoffsetinhours).

**Q: Transfers randomly fail on my shared host.**
Lower [`concurrency`](#concurrency) (some servers cap simultaneous operations) and/or set [`limitOpenFilesOnRemote`](#limitopenfilesonremote) if the server runs out of file descriptors.

**Q: Why was my rename/move refused?**
Renaming refuses rather than clobbering or guessing: the destination already exists (delete it first, or pick a different name), the new path falls outside [`remotePath`](#remotepath), or it would move a folder into its own subfolder. Nothing is touched when it's refused. See [Renaming and moving files](#renaming-and-moving-files-on-the-remote).

---

## 9. Development and Contributing

Issues and pull requests are welcome — the project is under active maintenance again at [jmwerk/SFTPresso](https://github.com/jmwerk/SFTPresso).

Development requires Node 22 or newer (see `.nvmrc`).

```sh
git clone https://github.com/jmwerk/SFTPresso.git
cd SFTPresso
npm install        # applies patches (ssh2, memfs) via patch-package
npm run compile    # production build (esbuild)
npm run dev        # watch mode for development
npm run typecheck  # TypeScript type check (tsc --noEmit)
npm run lint       # ESLint
npm test           # jest unit suites (no Docker, no network)
npm run package    # build the .vsix
```

Integration tests drive the real client layers against servers in Docker — FTP
(vsftpd + pure-ftpd) and SFTP (OpenSSH). They are not part of `npm test`:

```sh
npm run test:integration:up     # generates the throwaway ssh key, starts the containers
npm run test:integration
npm run test:integration:down
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for what each suite covers.

Highlights of the codebase:

- `src/extension.ts` / `src/app.ts` — activation and wiring
- `src/commands/` — one module per command
- `src/core/` — config, file system abstractions, transfer scheduling
- `src/modules/remoteExplorer` — the Remote Explorer view
- `schema/` — the JSON schema that validates `.vscode/sftp.json`
- `patches/` — `patch-package` fixes applied on install

See also [CONTRIBUTING.md](../CONTRIBUTING.md) and the [CHANGELOG](../CHANGELOG.md).

## 10. Credits

This project builds on the work of [@Natizyskunk](https://github.com/Natizyskunk) and [@liximomo](https://github.com/liximomo). If their earlier work helped you, their original donation links are in the [upstream README](https://github.com/Natizyskunk/vscode-sftp#donation).
