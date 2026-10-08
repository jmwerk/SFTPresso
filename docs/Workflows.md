<!-- Source of the GitHub wiki page "Workflows". Published by .github/workflows/sync-wiki.yml; edits made on the wiki are overwritten. -->

## Simple single-server setup

The minimum viable config — SFTP on port 22, prompted for the password:

```json
{
  "host": "host",
  "username": "username",
  "remotePath": "/remote/workspace"
}
```

## Start from a remote project

If the latest files already live on the server, start with an **empty local folder**:

1. Open the empty folder in VS Code and run `SFTP: Config` (see [First-time setup](Installation-and-Setup.md#first-time-setup)).
2. Set `remotePath` to the server directory you want.
3. Run **`SFTP: Download Project`** — the remote tree is downloaded into your workspace.
4. From here on, edit locally and upload/sync as needed.

## Upload on save

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

(See [`useTempFile`](Configuration.md#usetempfile) and [`openSsh`](Configuration.md#openssh).)

If others deploy to the same server, add [`conflictCheck`](Configuration.md#conflictcheck) so a save can't quietly overwrite a change you never pulled down:

```json
{
  "uploadOnSave": true,
  "conflictCheck": true
}
```

## Profiles (dev / prod)

One config, several environments. Profile values merge over the top-level config; switch with **`SFTP: Set Profile`**.

When a config defines profiles, the status bar item shows the active profile (e.g. **`SFTP: dev`**, or **`SFTP: (base config)`** when none is active, meaning the config's top-level settings apply), and clicking it opens the profile picker — same as running `SFTP: Set Profile`. Without profiles, the status bar keeps its usual behavior (shows `SFTP`, click to toggle the output panel).

The Remote Explorer shows it too: its first row shows the active profile with where it points dimmed after it, e.g. **staging** `203.0.113.10:2223` (the port appears when it isn't 22, so live and staging on one host look different). Click that row to switch, like Source Control's branch button; the picker lists each profile with its address too. Connections from configs without profiles show their own `host:port` after the name instead. Hover a connection's row for its profile, host and remote path.

To add a profile without editing JSON, run **`SFTP: Config`** on a workspace that already has an `sftp.json` and pick **Add Profile**. The wizard starts from the base config's answers, so for a staging site on the same server you typically just change the port. It doesn't ask for a connection name (the profile keeps the site's name, and the Remote Explorer shows the profile next to it), and it writes only the settings that differ into `profiles.<name>`. Everything else is inherited, so a later change to the base config (a new `remotePath`, say) applies to the profile too.

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

> `context` is only available at the root level, not inside a profile. [`watcher`](Configuration.md#watcher) may be set at either — a profile's watcher is merged one level over the root one while that profile is active, so `{ "autoUpload": false }` turns uploads off for production without losing the root's other watcher settings (`files`, `autoDelete`, etc.). `syncOption` and `remoteExplorer` merge the same way when set inside a profile.

To deploy to every environment at once, use the **`… To All Profiles`** [upload commands](Commands.md#upload-commands).

## Multiple contexts (array config)

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

## Connection hopping (SSH proxy / bastion)

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

## Two-way automatic sync with the watcher

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

Keep `uploadOnSave` **false** here — the watcher already covers saves when watching `**/*` (see [`watcher`](Configuration.md#watcher)). `autoRename` here means a rename or move made in VS Code's own Explorer moves the remote copy instead of deleting and re-uploading it — see [Renaming and moving files](#renaming-and-moving-files-on-the-remote). It doesn't extend to `git checkout` or other tools that write straight to disk outside VS Code; those are still handled as a plain delete-and-create.

## Renaming and moving files on the remote

Used to be that renaming or moving something meant a full re-upload — of everything inside it, if it was a directory. Now it's just a single remote `rename()` call regardless of size, in three places:

**From the Remote Explorer.** Right-click a file or folder and choose **Rename**. Type a new name — including a path with `/` to move it into a subfolder — and confirm. The move is refused (with a clear message, nothing is touched) if the destination already exists, falls outside [`remotePath`](Configuration.md#remotepath), or would move a folder into itself.

**By dragging within the Remote Explorer.** Set [`remoteExplorer.enableDragAndDrop`](Configuration.md#remoteexplorer) to `true`, then drag a file or folder onto another folder in the tree to move it there — the same single `rename()` call as the **Rename** command, just started with a drag instead of a right-click. Off by default. Dragging more than one selected item asks for one confirmation covering the whole batch; a single item moves immediately. Refused, with a message, in the same cases the Rename command refuses (existing destination, moving a folder into itself or a descendant), plus a drag between two different configured roots and dragging a connection's root item itself.

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

## Uploading a folder's contents without the folder itself

Set [`context`](Configuration.md#context) to the folder — its *contents* then map directly onto `remotePath`. Here everything in `./build` lands in `/folder1/folder2/folder3` (with only JS/HTML auto-uploaded by the watcher):

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

## Configuration in User Settings (remote-fs)

Define connections once in User Settings (via [remote-fs](https://github.com/liximomo/vscode-remote-fs)) and reference them by name from any project's `sftp.json` with the [`remote`](Configuration.md#remote) option.

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

## Using the Remote Explorer

Open it by clicking the **SFTP** icon in the Activity Bar, or run `View: Show SFTP`.

- Browsing opens files in a **read-only** view by default. Run **`SFTP: Edit in Local`** (context menu) to download a file into the workspace for editing — or flip the [`sftp.downloadWhenOpenInRemoteExplorer`](Configuration.md#vs-code-extension-settings) setting to make downloading the default.
- **Multi-select** works like the regular explorer: hold `Ctrl`/`Cmd` or `Shift` while clicking to select several files/folders, then upload or download them all at once.
- Create, rename/move, and delete remote files/folders from the context menu ([file commands](Commands.md#remote-explorer-and-file-commands)) — rename/move is a single remote operation regardless of size, see [Renaming and moving files](#renaming-and-moving-files-on-the-remote).
- **Drag a file or folder onto another folder** in the tree to move it there, once [`remoteExplorer.enableDragAndDrop`](Configuration.md#remoteexplorer) is turned on (off by default) — see [Renaming and moving files](#renaming-and-moving-files-on-the-remote).
- **Drag files in from Finder/Explorer/your file manager** and drop them onto a folder in the tree to upload them there, under the same [`remoteExplorer.enableDragAndDrop`](Configuration.md#remoteexplorer) setting. Dropping a folder uploads it and everything inside it.
- Prefer not to drag? Right-click a folder (or connection root) and choose **Upload File Here** to pick local files/folders through the OS file picker instead — this one works regardless of `remoteExplorer.enableDragAndDrop`.
- Hide noise (e.g. `node_modules`) with [`remoteExplorer.filesExclude`](Configuration.md#remoteexplorer), and control root ordering with `remoteExplorer.order`.
- **Filter** the tree with **`SFTP: Filter Remote Explorer`** (funnel icon in the view title) — typing live-narrows the tree to matching names and the folders leading to them, even inside folders you haven't opened yet. **`SFTP: Clear Filter`** resets it, and the view title shows the active query while it's on. Substring match only for now. VS Code's own `workbench.list.keyboardNavigation: filter` setting is a handy complement for searching within a folder you've already expanded.
- After a **delete**, manually refresh the parent folder if the tree doesn't update on its own (known issue).

## Monitoring and cancelling transfers

During bulk operations (folder upload/download, sync, project transfers):

- The **status bar** shows a live "Transferring X/Y files" counter, plus the combined transfer speed across every in-flight file once it's available — click the counter to open the Transfers view.
- The **Transfers** view in the SFTP sidebar lists each file with an upload or download icon, its status (queued / transferring / failed), and an inline **✕** button to cancel just that file. Hover a queued or failed row for the full source and destination paths.
- While a file is transferring, its row shows **byte-level progress**, current **speed**, and, once the total size is known, an **ETA** in the description — e.g. `42% of 7.4 MB · 1.2 MB/s · 00:04`, or just bytes and speed when the total size isn't known. The speed and ETA are computed from a rolling window of recent progress and appear a moment into the transfer, once enough samples have been collected. Updates are throttled to a couple per second per file.
- A failed transfer keeps its row (marked *failed*, with the error in its tooltip) and an inline **↻ Retry** button (`sftp.retryTransfer`) until you retry it or run **Clear Failed Transfers** from the view title bar. Retrying re-queues just that file with its original direction and options and resets its status to *queued*.
- `SFTP: Cancel All Transfers` is also available from the Command Palette and the Transfers view title bar. It stops the directory scan as well as the queued transfers, so cancelling a large folder or project transfer takes effect immediately instead of after the whole tree has been walked.

## Comparing folders with the remote

Right-click any folder (or run **`SFTP: Compare Folders with Remote`**) to get a recursive diff against its remote counterpart. Results are grouped into **new-local**, **new-remote**, and **modified** files; picking a file offers per-file actions to open a diff, upload, or download. Use it before a sync to preview exactly what would change.

Two actions sit at the top of the list when they apply:

- **Open All Diffs** opens every modified file side by side with its remote copy, one pinned tab each (it asks first above ten).
- **Check Contents** hashes the modified files whose sizes match and drops the ones whose only difference is a timestamp. It's there when comparing by timestamp; with [`compareMode`](Configuration.md#comparemode) `"content"` the list is already content-accurate, and the summary says how many files differed only in timestamp.

A directory that couldn't be listed on either side is reported as **Could not read** rather than being folded into the diff, and its subtree is left out entirely — nothing is known about what is inside it, so it offers no transfer actions. If the folder you are comparing can't be read at all, the command reports the error instead of showing an empty comparison.
