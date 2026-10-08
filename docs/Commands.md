<!-- Source of the GitHub wiki page "Commands". Published by .github/workflows/sync-wiki.yml; edits made on the wiki are overwritten. -->

All commands live under the **SFTP** category in the Command Palette. Most are also exposed via context menus (file explorer, editor, editor title, SCM view, Remote Explorer). Commands are only available when the extension is active (workspace contains `.vscode/sftp.json`).

## Configuration and connection commands

| Command | ID | Description |
| --- | --- | --- |
| `SFTP: Config` | `sftp.config` | Create a new `sftp.json` for the workspace — via a guided quick-setup wizard or a starter template — or open the existing one. See [First-time setup](Installation-and-Setup.md#first-time-setup). |
| `SFTP: Set Profile` | `sftp.setProfile` | Switch the active [profile](Workflows.md#profiles-dev--prod). |
| `SFTP: Test Connection` | `sftp.testConnection` | Connect to the active profile's remote and report success/failure. Also available as a CodeLens on `sftp.json`. |
| `SFTP: Disconnect` | `sftp.disconnect` | Drop every pooled connection (all configs/profiles, not just the active one) so the next command reconnects fresh. Manual escape hatch for a stuck connection — [`operationTimeout`](Configuration.md#operationtimeout) usually catches that on its own, but this is faster than reloading the window when it doesn't. |
| `SFTP: Toggle Upload on Save` | `sftp.toggleUploadOnSave` | Flip the active config's [`uploadOnSave`](Configuration.md#uploadonsave) and write it back to `sftp.json` (comments and formatting preserved). Also available as the `$(cloud-upload)` status bar button, which is dimmed while it's off. |
| Add to Ignore | `sftp.addToIgnore` | File-explorer context menu command. Appends the right-clicked file or folder's workspace-relative path to the active config's [`ignore`](Configuration.md#ignore) array in `sftp.json` (folders as `path/**`), preserving comments and formatting; a no-op if the entry is already listed. |
| Copy Remote Path | `sftp.copyRemotePath` | Context menu command in the file explorer, the editor and the Remote Explorer. Copies the remote absolute path of the file or folder to the clipboard; with several selected, one path per line. |
| `SFTP: Open SSH in Terminal` | `sftp.openConnectInTerminal` | Open a VS Code terminal with a shell on the server, starting in `remotePath`. The tab is named after the site, plus the profile for configs that use profiles (e.g. `example-site (staging)`). It runs over SFTPresso's own connection, so it uses the same password, key, passphrase, agent, [`hop`](Configuration.md#hop) and [host key](Installation-and-Setup.md#host-key-verification) settings as file transfers, with nothing to type again. Also a terminal icon button on each SFTP root in the Remote Explorer (on hover), and in the right-click menu of roots and folders — from a folder, the shell starts in that folder, and with several folders selected you get one terminal per folder (it asks first above five). SFTP only. Type `exit` to close it; `SFTP: Disconnect` also ends it, and so does saving `sftp.json`, which resets its connections. If [`sshCustomParams`](Configuration.md#sshcustomparams) is set, the command instead types an `ssh` command into a regular terminal, as before. |
| `SFTP: Save Password` | `sftp.savePassword` | Store a password for a remote in VS Code's secret storage (OS keychain). See [Storing passwords securely](Installation-and-Setup.md#storing-passwords-securely). |
| `SFTP: Migrate Plaintext Password` | `sftp.migratePassword` | Move a plaintext `password` out of `sftp.json` into secret storage and strip the key (comments/formatting preserved, confirms first). Same thing the **Migrate Password** button on the plaintext warning does. See [Storing passwords securely](Installation-and-Setup.md#storing-passwords-securely). |
| `SFTP: Clear Password` | `sftp.clearPassword` | Remove a saved password from secret storage. |
| `SFTP: Show Host Key Fingerprint` | `sftp.showHostKey` | Show the stored host key(s) for a remote — fingerprint, type, source file — with a copy button. See [Host key verification](Installation-and-Setup.md#host-key-verification). |
| `SFTP: Forget Host Key` | `sftp.forgetHostKey` | Clear the stored host key(s) for a remote, so the next connection is treated as new. What you run when a connection's refused because the server's key changed. Removing an entry from your own `~/.ssh/known_hosts` asks for confirmation first, naming the file and line. |
| `SFTP: Run Remote Command` | `sftp.runRemoteCommand` | Run a command on the remote over the existing SSH connection, no re-auth. Pick from [`remoteCommands`](Configuration.md#remotecommands) or type one — either way you confirm the resolved command and host before it runs, since it executes on whatever server the active config points at. Output streams to the SFTPresso output channel; a command past [`remoteCommandTimeout`](Configuration.md#remotecommandtimeout) gets killed and reported as timed out. FTP configs just get an error instead. |

## Upload commands

Uploads overwrite the remote copy unconditionally. Enable [`conflictCheck`](Configuration.md#conflictcheck) to be warned first when the remote file changed since you last downloaded or uploaded it.

| Command | ID | Description |
| --- | --- | --- |
| `SFTP: Upload Active File` | `sftp.upload.activeFile` | Upload the file currently open in the editor. |
| `SFTP: Upload Active Folder` | `sftp.upload.activeFolder` | Upload the folder containing the current file. |
| `SFTP: Upload Project` | `sftp.upload.project` | Upload the whole project (respecting [`ignore`](Configuration.md#ignore) rules). |
| `SFTP: Upload Changed Files` | `sftp.upload.changedFiles` | Upload all files changed or created since the last Git commit (including deletions). Default keybinding `Ctrl+Alt+U`; also shown in the Source Control view. |
| Upload File / Upload Folder | `sftp.upload.file` / `sftp.upload.folder` | Context-menu variants that act on the right-clicked explorer item. |
| `SFTP: Upload … To All Profiles` | `sftp.upload.activeFile.to.allProfiles`, `sftp.upload.activeFolder.to.allProfiles`, `sftp.upload.project.to.allProfiles`, `sftp.upload.file.to.allProfiles`, `sftp.upload.folder.to.allProfiles` | Same as above but pushes to **every** profile defined in the config, not just the active one. |

## Download commands

| Command | ID | Description |
| --- | --- | --- |
| `SFTP: Download Active File` | `sftp.download.activeFile` | Download the remote version of the current file, overwriting the local copy. |
| `SFTP: Download Active Folder` | `sftp.download.activeFolder` | Download the folder containing the current file. |
| `SFTP: Download Project` | `sftp.download.project` | Download everything under [`remotePath`](Configuration.md#remotepath) into the workspace. |
| Download File / Download Folder | `sftp.download.file` / `sftp.download.folder` | Context-menu variants (explorer and Remote Explorer). |

## Sync commands

Sync compares timestamps and transfers only what differs; behavior is tuned with [`syncOption`](Configuration.md#syncoption). Set [`compareMode`](Configuration.md#comparemode) to `"content"` to compare file contents instead, so files whose only difference is a timestamp are left alone. Enable [`syncConfirm`](Configuration.md#syncconfirm) to preview and confirm exactly what a sync will upload, overwrite, and delete before it runs.

| Command | ID | Description |
| --- | --- | --- |
| `SFTP: Sync Local → Remote` | `sftp.sync.localToRemote` | Copies files that differ (by timestamp, or by content with [`compareMode`](Configuration.md#comparemode)), plus files that exist only locally. |
| `SFTP: Sync Remote → Local` | `sftp.sync.remoteToLocal` | Same, in the opposite direction. |
| `SFTP: Sync Both Directions` | `sftp.sync.bothDirections` | Compares modification times and always keeps the **newest** version on both sides. With [`compareMode`](Configuration.md#comparemode) `"content"`, files with identical contents are skipped whatever their timestamps. Only `syncOption.skipCreate` and `syncOption.ignoreExisting` apply to this command. |

> If local and remote clocks disagree (server in another timezone, clock drift), set [`remoteTimeOffsetInHours`](Configuration.md#remotetimeoffsetinhours) so timestamp comparison stays accurate.

## Diff and compare commands

| Command | ID | Description |
| --- | --- | --- |
| `SFTP: Diff Active File with Remote` | `sftp.diff.activeFile` | Open VS Code's diff view: current file vs. its remote counterpart. |
| Diff with Remote | `sftp.diff` | Context-menu variant for any explorer file. |
| `SFTP: Compare Folders with Remote` | `sftp.compareFolders` | Recursively diffs a local folder against its remote counterpart; results (new-local / new-remote / modified) are listed in a QuickPick with per-file actions to open a diff, upload, or download. |

## Remote Explorer and file commands

| Command | ID | Description |
| --- | --- | --- |
| `SFTP: List` / `SFTP: List Active Folder` / `SFTP: List All` | `sftp.list` / `sftp.listActiveFolder` / `sftp.listAll` | List remote directory contents in a QuickPick. `List All` includes ignored files. |
| Rename | `sftp.rename.remote` | Rename or move the selected file/folder **on the remote** (Remote Explorer context menu) — a single `rename()` call regardless of size, no re-upload. A name containing `/` moves the item. Refuses to overwrite an existing destination or move the item outside `remotePath` or into itself. See [Renaming and moving files](Workflows.md#renaming-and-moving-files-on-the-remote). |
| Delete | `sftp.delete.remote` | Delete the selected file/folder **on the remote** (Remote Explorer context menu). |
| Create Folder / Create File | `sftp.create.folder` / `sftp.create.file` | Create a remote folder or file from the Remote Explorer. |
| Upload File Here | `sftp.remoteExplorer.uploadHere` | Right-click a folder (or a connection root) in the Remote Explorer and pick local files/folders to upload directly into it, via the OS file picker — no local workspace mapping needed. See [Using the Remote Explorer](Workflows.md#using-the-remote-explorer). |
| Edit in Local | `sftp.remoteExplorer.editInLocal` | Download the remote file into the workspace so it can be edited (Remote Explorer opens files read-only by default). |
| View Content | `sftp.viewContent` | Open a read-only view of a remote file. |
| Reveal in Explorer | `sftp.revealInExplorer` | Jump from a remote file to its local counterpart in the file explorer. |
| Reveal in Remote Explorer | `sftp.revealInRemoteExplorer` | Jump from a local file to its remote counterpart in the Remote Explorer. |
| Refresh | `sftp.remoteExplorer.refresh` | Refresh the Remote Explorer tree. |
| Refresh Active Remote File | `sftp.remoteExplorer.refreshActiveFile` | Re-fetch the remote file open in the editor. |
| `SFTP: Filter Remote Explorer` | `sftp.remoteExplorer.filter` | Open a live, debounced quick pick that narrows the Remote Explorer to entries whose name contains the typed substring, plus their ancestor folders — including folders not yet expanded. See [Using the Remote Explorer](Workflows.md#using-the-remote-explorer). |
| `SFTP: Clear Filter` | `sftp.remoteExplorer.clearFilter` | Clear an active Remote Explorer filter and restore the full listing. |

## Transfer management commands

| Command | ID | Description |
| --- | --- | --- |
| `SFTP: Cancel All Transfers` | `sftp.cancelAllTransfer` | Stop every in-flight upload/download. Also in the Transfers view title bar. |
| Clear Failed Transfers | `sftp.clearFailedTransfers` | Remove failed rows from the [Transfers view](Workflows.md#monitoring-and-cancelling-transfers). Shown in its title bar while any failure is listed. |
| Cancel Transfer | `sftp.cancelTransfer` | Cancel a single in-flight file — the inline ✕ button on items in the [Transfers view](Workflows.md#monitoring-and-cancelling-transfers). |
| Retry Transfer | `sftp.retryTransfer` | Re-queue a single failed file — the inline ↻ button on failed items in the [Transfers view](Workflows.md#monitoring-and-cancelling-transfers). |

## Force (Alt) commands

Hold **Alt** while a context menu is open to reveal the force variants, which **disregard [`ignore`](Configuration.md#ignore) rules**:

| Command | ID | Description |
| --- | --- | --- |
| Force Upload | `sftp.forceUpload` | Upload even files matched by ignore rules. |
| Force Download | `sftp.forceDownload` | Download even files matched by ignore rules. |
| Force Upload To All Profiles | `sftp.forceUpload.to.allProfiles` | Force-upload to every profile. |

## Commands with keybinding arguments

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

## Default keybindings

| Keys | Command | When |
| --- | --- | --- |
| `Ctrl+Alt+U` | `SFTP: Upload Changed Files` | Extension active |
