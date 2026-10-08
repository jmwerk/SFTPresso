<!-- Source of the GitHub wiki page "Configuration". Published by .github/workflows/sync-wiki.yml; edits made on the wiki are overwritten. -->

Configuration lives in `<workspace>/.vscode/sftp.json` — either a single object, or an **array of objects** for [multiple contexts](Workflows.md#multiple-contexts-array-config). Open it any time via `SFTP: Config`.

The file is read as **JSONC**: `// line comments`, `/* block comments */`, and trailing commas are all allowed, so you can annotate a config or comment out options without breaking it. Parse errors are reported with their line and column.

## Options at a glance

| Area | Options |
| --- | --- |
| Connection | [`protocol`](#protocol) · [`host`](#host) · [`port`](#port) · [`username`](#username) · [`password`](#password) · [`warnPlaintextPassword`](#warnplaintextpassword) · [`profiles`](#profiles) · [`remote`](#remote) |
| Mapping | [`name`](#name) · [`context`](#context) · [`remotePath`](#remotepath) · [`filePerm`](#fileperm) · [`dirPerm`](#dirperm) |
| Uploads and downloads | [`uploadOnSave`](#uploadonsave) · [`useTempFile`](#usetempfile) · [`openSsh`](#openssh) · [`downloadOnOpen`](#downloadonopen) · [`conflictCheck`](#conflictcheck) · [`maxFileSize`](#maxfilesize) |
| Sync and compare | [`syncOption`](#syncoption) · [`syncConfirm`](#syncconfirm) · [`compareMode`](#comparemode) · [`remoteTimeOffsetInHours`](#remotetimeoffsetinhours) |
| Ignoring files | [`ignore`](#ignore) · [`ignoreFile`](#ignorefile) |
| Watching for changes | [`watcher`](#watcher) |
| Remote Explorer | [`remoteExplorer`](#remoteexplorer) |
| Performance and timeouts | [`concurrency`](#concurrency) · [`limitOpenFilesOnRemote`](#limitopenfilesonremote) · [`connectTimeout`](#connecttimeout) · [`retry`](#retry) · [`idleTimeout`](#idletimeout) · [`stallTimeout`](#stalltimeout) · [`operationTimeout`](#operationtimeout) |
| Remote commands | [`remoteCommands`](#remotecommands) · [`remoteCommandTimeout`](#remotecommandtimeout) |
| SFTP authentication | [`agent`](#agent) · [`privateKeyPath`](#privatekeypath) · [`passphrase`](#passphrase) · [`interactiveAuth`](#interactiveauth) |
| SFTP connection | [`hop`](#hop) · [`strictHostKeyChecking`](#stricthostkeychecking) · [`algorithms`](#algorithms) · [`sshConfigPath`](#sshconfigpath) · [`sshCustomParams`](#sshcustomparams) · [`keepaliveInterval`](#keepaliveinterval) · [`keepaliveCountMax`](#keepalivecountmax) · [`transferMode`](#transfermode) |
| FTP(S) | [`secure`](#secure) · [`secureOptions`](#secureoptions) |

## Common options

Apply to both SFTP and FTP unless noted.

### name
A string to identify your configuration. Shown in pickers when multiple configs exist. **Required when using an array (multi-context) config.**

| Key | Type | Default |
| --- | --- | --- |
| `name` | string | — |

```json
{ "name": "My Server" }
```

### context
A path relative to the workspace root. Use it to map a **subfolder** (rather than the whole workspace) to `remotePath`. Only available at the root level of a config (not inside profiles).

| Key | Type | Default |
| --- | --- | --- |
| `context` | string | workspace root |

```json
{ "context": "./build" }
```

### protocol
Transfer protocol.

| Key | Type | Default |
| --- | --- | --- |
| `protocol` | `"sftp"` \| `"ftp"` | `"sftp"` |

### host
Hostname or IP address of the server.

| Key | Type |
| --- | --- |
| `host` | string |

### port
Server port. Typically `22` for SFTP, `21` for FTP, `990` for implicit FTPS.

| Key | Type |
| --- | --- |
| `port` | integer |

### username
Username for authentication.

| Key | Type |
| --- | --- |
| `username` | string |

### password
Password for password-based authentication. **Optional** — omit it to use a password saved via `SFTP: Save Password`, or to be prompted at connect time (see [Storing passwords securely](Installation-and-Setup.md#storing-passwords-securely)).

> ⚠️ **Warning:** passwords in `sftp.json` are stored as **plain text**. Prefer [`privateKeyPath`](#privatekeypath) or [`agent`](#agent) — or keep the password in [secret storage](Installation-and-Setup.md#storing-passwords-securely) — and keep `sftp.json` out of version control. See [Best Practices](Best-Practices.md).

| Key | Type |
| --- | --- |
| `password` | string |

### warnPlaintextPassword
Show a notification when the config has a plaintext [`password`](#password), at the top level or in a profile. Set it to `false` if you've secured `sftp.json` another way (for example, it's never committed); **Don't Show Again** on the notification writes it for you. The warning is still logged to the output channel.

| Key | Type | Default |
| --- | --- | --- |
| `warnPlaintextPassword` | boolean | `true` |

### remotePath
The absolute path on the remote host that maps to your local [`context`](#context). This is what `SFTP: Download Project` downloads.

| Key | Type | Default |
| --- | --- | --- |
| `remotePath` | string | `/` |

### filePerm
Octal permissions applied to newly created remote files.

| Key | Type | Default |
| --- | --- | --- |
| `filePerm` | number | unset |

```json
{ "filePerm": 644 }
```

### dirPerm
Octal permissions applied to newly created remote directories.

| Key | Type | Default |
| --- | --- | --- |
| `dirPerm` | number | unset |

```json
{ "dirPerm": 750 }
```

### uploadOnSave
Upload the file on every VS Code save. See the [Upload on save](Workflows.md#upload-on-save) workflow. You can flip this without editing JSON via **`SFTP: Toggle Upload on Save`** or by clicking the `$(cloud-upload)` button in the status bar, which is dimmed while it's off.

| Key | Type | Default |
| --- | --- | --- |
| `uploadOnSave` | boolean | `false` |

### useTempFile
Upload to a temporary file first, then move it into place — avoids serving a half-written file to visitors while the upload is in progress.

| Key | Type | Default |
| --- | --- | --- |
| `useTempFile` | boolean | `false` |

### openSsh
Enable **atomic** file uploads (rename-into-place). Only supported by OpenSSH servers.

> 💡 If `openSsh` is `true`, [`useTempFile`](#usetempfile) must also be `true`.

| Key | Type | Default |
| --- | --- | --- |
| `openSsh` | boolean | `false` |

```json
{ "openSsh": true, "useTempFile": true }
```

### downloadOnOpen
Download the remote version of a file whenever it is opened locally.

| Key | Type | Default |
| --- | --- | --- |
| `downloadOnOpen` | boolean | `false` |

### syncOption
Tunes the [Sync commands](Commands.md#sync-commands).

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

### syncConfirm
Get a dry-run preview before a [Sync command](Commands.md#sync-commands) actually runs — something like *"Sync Local → Remote: 3 uploads, 1 overwrite, 2 deletions. Proceed?"*, with the files listed, and Cancel/Proceed to decide. Nothing happens until you click Proceed; if there's nothing to sync, you just get a quick "nothing to do" message instead.

| Key | Type | Default |
| --- | --- | --- |
| `syncConfirm` | boolean | `true` when [`syncOption.delete`](#syncoption) is enabled, otherwise `false` |

Default's conservative on purpose — a sync that can delete things asks first, one that can't doesn't bother you. Set it explicitly if you want the opposite either way.

One caveat: if a directory can't be read while building the preview (or, with [`compareMode`](#comparemode) `"content"`, a file), it shows up as `! could not read:` and the summary says so up front — the rest of the preview is only as complete as what it could actually see. Comparing by content, the preview also lists how many files it skipped because only their timestamps differ, and the sync that follows reuses the preview's hashes instead of reading every file again.

```json
{
  "syncConfirm": true
}
```

### compareMode
How [Compare Folders](Workflows.md#comparing-folders-with-the-remote), the [`syncConfirm`](#syncconfirm) preview, and the [Sync commands](Commands.md#sync-commands) decide that a file present on both sides has changed.

| Key | Type | Default |
| --- | --- | --- |
| `compareMode` | `"mtime"` \| `"content"` | `"mtime"` |

- **`"mtime"`** — a file differs when its size or modification time (to the second) differs. Only directory listings are read, so it's fast, but anything that touches a file without changing it — `git checkout`, a build step, a server that doesn't preserve timestamps — makes it look modified.
- **`"content"`** — a file differs when its *contents* differ. Files of different sizes are known to differ without reading anything; same-size files are compared by SHA-256, whatever their timestamps say (so it also catches a change that kept the size and mtime).

Over SFTP, remote files are hashed **on the server** with `sha256sum` (or `shasum -a 256`), a directory's worth per command, so nothing is downloaded. If the server has neither, refuses command execution (an SFTP-only or `internal-sftp` account), or is too slow, the extension quietly falls back to streaming the files to hash them locally — correct, but it costs as much as downloading them. Over FTP it always streams. Local hashes are cached between runs, keyed on path, size, and modification time.

A file that can't be read is reported as **Could not read** rather than guessed at, and a Sync stops on it instead of overwriting either copy.

Don't want to switch modes? Compare Folders offers **Check Contents** on its results to clear out timestamp-only differences once.

```json
{
  "compareMode": "content"
}
```

### conflictCheck
Guard against uploads that would silently overwrite someone else's work. Before a file upload replaces an existing remote file, the extension checks whether the remote copy changed since you last downloaded or uploaded it. If it did, a modal shows both timestamps and offers **Overwrite**, **Open Diff**, or **Cancel** — **Open Diff** opens the local/remote [diff](Commands.md#diff-and-compare-commands) and leaves the remote untouched.

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

A few things to know: it only covers single-file uploads (including `uploadOnSave`) — folder uploads and [Sync](Commands.md#sync-commands) skip it, since prompting mid-batch doesn't really work; use [`syncConfirm`](#syncconfirm) there instead. It costs one extra round-trip per upload, which is part of why it's off by default. Baselines are per-workspace, so uploading from a second machine can trigger one stale-baseline prompt — just choose Overwrite and it's back in sync. And on FTP servers without `MFMT` support, the remote's mtime is just "whenever it was uploaded," which makes conflicts get flagged more often than they should — see [`remoteTimeOffsetInHours`](#remotetimeoffsetinhours) if that's biting you.

### ignore
Files/folders excluded from transfers and sync. Gitignore-style patterns (wildcards with `*`), relative to the config's [`context`](#context). Bypass with the [Force commands](Commands.md#force-alt-commands).

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

### ignoreFile
Path to an ignore file (e.g. `.gitignore`-style list) — absolute, or relative to the workspace root.

| Key | Type |
| --- | --- |
| `ignoreFile` | string |

```json
{ "ignoreFile": ".gitignore" }
```

### maxFileSize
Caps file size (MB) for a **batch** transfer — folder upload/download or [Sync](Commands.md#sync-commands). Anything over the limit just gets skipped, with a summary afterward naming the count and the largest offender (full list in the output channel). This exists because someone's project has a stray database dump or video file in it, and nobody wants to find that out an hour into a folder upload. Doesn't apply if you explicitly right-click one file and upload/download it — that always goes through regardless of size. `0` or unset means no cap.

| Key | Type | Default |
| --- | --- | --- |
| `maxFileSize` | number | `0` (disabled) |

```json
{ "maxFileSize": 100 }
```

### watcher
Watches for changes made outside VS Code itself — build output, `git checkout`, some other tool writing to disk — and reacts automatically. See [Two-way automatic sync](Workflows.md#two-way-automatic-sync-with-the-watcher) for a full example.

A [profile](#profiles) can override this — even turn it off entirely with `"files": false` — just for that profile. Switching profiles rebuilds the watcher, and the profile's own [`ignore`](#ignore) rules apply to it too.

| Key | Type | Default |
| --- | --- | --- |
| `watcher` | object | `{}` |

| Sub-option | Type | Effect |
| --- | --- | --- |
| `watcher.files` | string (glob) | Which files to watch (required). |
| `watcher.autoUpload` | boolean | Upload when a watched file changes. |
| `watcher.autoDelete` | boolean | Delete on the remote when a watched file is removed locally. |
| `watcher.autoRename` | boolean | Server-side rename/move on the remote when a watched file or folder is renamed locally, instead of deleting and re-uploading it. See [Renaming and moving files](Workflows.md#renaming-and-moving-files-on-the-remote). Default `false`. |

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

### remoteTimeOffsetInHours
Hours of clock difference between the remote server and your machine (**remote minus local**). Needed for accurate timestamp-based [sync](Commands.md#sync-commands) when the server is in another timezone or its clock drifts.

> **FTP note:** servers that support the `MLSD` command (e.g. pure-ftpd, ProFTPD) report exact UTC timestamps, so this option should normally stay `0` for them. It's mainly needed for FTP servers limited to `LIST` (e.g. vsftpd), whose listings carry only server-local, minute-precision dates, and for SFTP servers with a skewed clock.

| Key | Type | Default |
| --- | --- | --- |
| `remoteTimeOffsetInHours` | number | `0` |

### remoteExplorer
Tunes the [Remote Explorer](Workflows.md#using-the-remote-explorer) view.

| Key | Type | Default |
| --- | --- | --- |
| `remoteExplorer` | object | `{}` |

| Sub-option | Type | Effect |
| --- | --- | --- |
| `remoteExplorer.filesExclude` | string[] | Patterns for files/folders to hide in the Remote Explorer. |
| `remoteExplorer.order` | number | Sort position of this config among Remote Explorer roots (default `0`). |
| `remoteExplorer.enableDragAndDrop` | boolean | Allow dragging an item onto a folder in the Remote Explorer to move it there with a single server-side rename, and allow dragging files in from your OS file manager to upload them. Default `false`. See [Renaming and moving files](Workflows.md#renaming-and-moving-files-on-the-remote) and [Using the Remote Explorer](Workflows.md#using-the-remote-explorer). |

```json
{
  "remoteExplorer": {
    "filesExclude": ["**/node_modules"],
    "order": 1,
    "enableDragAndDrop": true
  }
}
```

### concurrency
Maximum simultaneous transfers. It also bounds how many directory listings the scan of a folder transfer or sync issues at once, so a large tree can't flood a single connection with requests. Lower it if your server limits concurrent connections/operations. FTP always uses `1`.

| Key | Type | Default |
| --- | --- | --- |
| `concurrency` | number | `4` |

### connectTimeout
Maximum time (ms) to wait when establishing a connection.

| Key | Type | Default |
| --- | --- | --- |
| `connectTimeout` | number | `10000` |

Resolved in that order: this option if you set it, otherwise `ConnectTimeout` from your [ssh config](#sshconfigpath) (which states it in seconds), otherwise `10000`.

### limitOpenFilesOnRemote
Cap the number of file descriptors opened on the remote server. Set `true` for the default limit (222), or a number for a custom limit (values below 127 are raised to 127). Use it if transfers fail with the generic [`Error: Failure`](Troubleshooting.md#error-failure) because the server runs out of descriptors.

> 💡 **Do not set this unless you have to.**

> ℹ️ Broken between the `ssh2` 1.x upgrade and **1.26.3** — setting it threw `Cannot read properties of undefined (reading 'open')` and no connection could be established. Update to 1.26.3 or later if you need it.

| Key | Type | Default |
| --- | --- | --- |
| `limitOpenFilesOnRemote` | boolean \| number | `false` |

### profiles
A collection of named profiles keyed by profile name. Each profile is merged over the top-level config; switch with `SFTP: Set Profile`. See [Profiles (dev / prod)](Workflows.md#profiles-dev--prod).

| Key | Type |
| --- | --- |
| `profiles` | object |
| `defaultProfile` | string — profile activated by default |

### remote
Reference a connection defined in User Settings under `remotefs.remote` instead of repeating host details per project. See [Configuration in User Settings](Workflows.md#configuration-in-user-settings-remote-fs).

| Key | Type |
| --- | --- |
| `remote` | string |

### retry
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

### idleTimeout
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

When the check passes it's invisible — a healthy server just answers and things carry on, so a working `idleTimeout` looks identical to one that isn't doing anything. To actually confirm it's active, turn on `sftp.debug` and watch the **SFTPresso** output channel:

```
[debug] probing connection after 301204ms idle (timeout 10000ms)
[debug] probe answered, reusing the connection
```

A reconnect is reported at info level, so that line appears whether or not `sftp.debug` is on:

```
[info] reconnecting: idle connection did not answer in 10000ms (idle for 301204ms)
```

> ℹ️ It only checks on reuse, not on a timer, so it can't interrupt a transfer that's still running. The trade-off: the socket stays open while idle instead of being closed proactively, so if your host counts concurrent connections rather than killing idle ones, this won't help with that.

### stallTimeout
`idleTimeout` catches a connection that died *between* operations. This one catches the other case — a connection that dies mid-transfer, where the bytes just stop arriving and there's no error to react to, so the upload would otherwise wait forever.

A transfer that goes that long without a single byte moving gets failed instead of left hanging — and it's classified the same as a dropped connection, so [`retry`](#retry) picks it up and tries again automatically.

The clock resets on every chunk received, so this is measuring *stalls*, not total transfer time — a huge file crawling over a slow link keeps resetting the timer and never trips it. It's on by default at 30 seconds; raise it for a server that legitimately pauses longer, or set `0` to wait forever. Separately, the Transfers view marks a row *stalled* after 5 seconds without data, so a dead connection is visible long before the timeout fires.

| Key | Type | Default |
| --- | --- | --- |
| `stallTimeout` | number | `30000` |

```jsonc
{
  // give up on a transfer that hasn't moved a byte in 60 seconds
  "stallTimeout": 60000,
  "retry": { "attempts": 2 }
}
```

### operationTimeout
The third way a connection can go quiet. Like `stallTimeout`, it's on by default.

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

> ⚠️ Like `stallTimeout`, this one's on by default — a full minute with no reply isn't "slow," it's lost, and the alternative is an extension stuck until you reload the window. Got a genuinely slow server tripping this by accident? Raise the number rather than disabling it; `0` goes back to waiting forever.

### remoteCommands
Labeled shell commands offered by [`SFTP: Run Remote Command`](Commands.md#configuration-and-connection-commands) as a quick pick, instead of a blank prompt every time. Each command runs over the existing pooled SSH connection.

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

### remoteCommandTimeout
How long, in milliseconds, a command started by [`SFTP: Run Remote Command`](Commands.md#configuration-and-connection-commands) may run before it is killed and reported as timed out.

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

## SFTP-only options

### agent
Path to the ssh-agent UNIX socket for agent-based authentication (usually `$SSH_AUTH_SOCK`). Windows users: set to `pageant` to authenticate with Pageant, or the path to a Cygwin "UNIX socket".

| Key | Type |
| --- | --- |
| `agent` | string |

```json
{ "agent": "/run/user/1000/ssh-agent.socket" }
```

### privateKeyPath
Absolute path to your private key file.

| Key | Type |
| --- | --- |
| `privateKeyPath` | string |

```json
{ "privateKeyPath": "/Users/me/.ssh/id_rsa" }
```

### passphrase
Passphrase for an encrypted private key. Set the string itself, or set `true` to be prompted with a dialog (keeps the passphrase out of the config file — recommended).

| Key | Type |
| --- | --- |
| `passphrase` | string \| boolean |

```json
{ "passphrase": true }
```

### interactiveAuth
Enable keyboard-interactive authentication (e.g. multi-factor / Google Authenticator). Set `true` for a verification-code dialog, or pass an array of predefined responses to answer prompts automatically.

> 💡 Requires the server to have keyboard-interactive authentication enabled.

| Key | Type | Default |
| --- | --- | --- |
| `interactiveAuth` | boolean \| string[] | `false` |

```json
{ "interactiveAuth": true }
```

### algorithms
Explicit overrides for the SSH transport-layer algorithms. Mainly needed for older servers — see [Error: Connection closed](Troubleshooting.md#error-connection-closed).

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

### sshConfigPath
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

### sshCustomParams
Extra parameters appended to the `ssh` command used by `SFTP: Open SSH in Terminal`. Setting it switches that command back to running your system's `ssh` in a regular terminal (which ignores `password`, `passphrase`, `hop` and SFTPresso's host key store) instead of the built-in terminal. Requires a trusted workspace.

| Key | Type |
| --- | --- |
| `sshCustomParams` | string |

```json
{ "sshCustomParams": "-g" }
```

### hop
Connect through one or more intermediate SSH hosts. A single object for one hop, or an array for multiple. See [Connection hopping](Workflows.md#connection-hopping-ssh-proxy--bastion). Each hop accepts the same host/auth options (`host`, `port`, `username`, `privateKeyPath`, …).

> Variable substitution does not work inside a hop configuration.

| Key | Type |
| --- | --- |
| `hop` | object \| object[] |

Every host in the chain has its own host key checked in its own right — a bastion is exactly as impersonatable as the server behind it. Hops inherit the config's [`strictHostKeyChecking`](#stricthostkeychecking) unless they set their own.

### strictHostKeyChecking
Controls how the server's SSH host key is checked, mirroring OpenSSH's option of the same name. See [Host key verification](Installation-and-Setup.md#host-key-verification) for what the values mean and how the store works.

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

### keepaliveInterval
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

### keepaliveCountMax
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

### transferMode
How a single file's bytes are moved. `"auto"` (the default) transfers a file larger than ~256KB as several concurrent chunked requests instead of one stream — on a high-latency link, a single outstanding request bounds throughput to chunk-size/round-trip-time regardless of available bandwidth, so a "slow server" is often just protocol latency, and chunking removes that ceiling. Smaller files stay on the single-stream path, where the extra requests would cost more than they save. `"parallel"` forces chunked transfer for every file regardless of size; `"stream"` always uses the classic single-pipe transfer. Per-file chunk concurrency scales down as [`concurrency`](#concurrency) goes up, so a batch of several large files transferring at once can't multiply into an unbounded number of simultaneous requests against one connection. If the chunked path fails for a reason other than cancelling the transfer yourself — a server that caps concurrent handles, say — it's retried once as a plain stream before counting as a real failure.

| Key | Type | Default |
| --- | --- | --- |
| `transferMode` | `"auto"` \| `"parallel"` \| `"stream"` | `"auto"` |

```json
{ "transferMode": "parallel" }
```

> ℹ️ SFTP only — always behaves as `"stream"` on FTP and `local`.

## FTP(S)-only options

### secure
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

### secureOptions
Extra options passed straight to Node's [`tls.connect()`](https://nodejs.org/api/tls.html#tls_tls_connect_options_callback) — e.g. to accept a self-signed certificate.

| Key | Type |
| --- | --- |
| `secureOptions` | object |

```json
{ "secureOptions": { "rejectUnauthorized": false } }
```

## VS Code extension settings

These are regular VS Code settings (`File → Preferences → Settings`, or `settings.json`), separate from `sftp.json`:

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `sftp.debug` | boolean | `false` | Print debug output to the `sftp` Output channel. **Reload VS Code after changing.** |
| `sftp.printDebugLog` | boolean | `false` | **Deprecated** — use `sftp.debug` instead. Still honored for backward compatibility. |
| `sftp.downloadWhenOpenInRemoteExplorer` | boolean | `false` | When opening a file in the Remote Explorer, download it ("Edit in Local") instead of showing a read-only "View Content". |
