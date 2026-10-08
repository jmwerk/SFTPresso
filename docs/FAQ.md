<!-- Source of the GitHub wiki page "FAQ". Published by .github/workflows/sync-wiki.yml; edits made on the wiki are overwritten. -->

## How do I upload the contents of a folder, but not the folder itself?

Set [`context`](Configuration.md#context) to that folder (e.g. `"context": "./build"`) — its contents then map directly to `remotePath`. Full example: [Uploading a folder's contents without the folder itself](Workflows.md#uploading-a-folders-contents-without-the-folder-itself).

## How can I upload files as root?

A community workaround (may not work everywhere — see [liximomo/vscode-sftp#559](https://github.com/liximomo/vscode-sftp/issues/559)) is:

```json
"sshCustomParams": "sudo su -;"
```

## How do I sync both ways automatically, without any user interaction?

Use a watcher on `**/*` with `autoUpload`/`autoDelete` plus `syncOption.delete` — full config in [Two-way automatic sync with the watcher](Workflows.md#two-way-automatic-sync-with-the-watcher). This also keeps the server updated when Git changes files (branch checkout, revert).

## Why don't I see dotfiles/hidden files in the Remote Explorer?

Often a server-side listing setting. With **proftpd**, edit `proftpd.conf` (commonly `/etc/proftpd.conf`, `/etc/proftpd/proftpd.conf`, `/usr/local/etc/proftpd.conf`, or `/usr/local/etc/proftpd/proftpd.conf`) and change `ListOptions "-l"` to `ListOptions "-la"`:

```conf
<Global>
ListOptions "-la"
</Global>
```

## Do I have to store my password in `sftp.json`?

No — leave `password` out and you'll be prompted on connect, with an offer to remember the password in VS Code's secret storage. You can also save it up front with `SFTP: Save Password` (see [Storing passwords securely](Installation-and-Setup.md#storing-passwords-securely)). Better yet, use key-based auth (see [Best Practices](Best-Practices.md)).

## What do the "Connection refused" / "Connection timed out" / "Host not found" / "Authentication failed" messages mean?

See [SSH connection error messages](Troubleshooting.md#ssh-connection-error-messages).

## Can I edit files directly in the Remote Explorer?

Files open read-only by default — use `SFTP: Edit in Local`, or set `sftp.downloadWhenOpenInRemoteExplorer` to make opening a file download it. See [Using the Remote Explorer](Workflows.md#using-the-remote-explorer).

## Sync copies files in the wrong direction / re-uploads unchanged files.

Sync is timestamp-based; correct clock/timezone differences with [`remoteTimeOffsetInHours`](Configuration.md#remotetimeoffsetinhours).

## Transfers randomly fail on my shared host.

Lower [`concurrency`](Configuration.md#concurrency) (some servers cap simultaneous operations) and/or set [`limitOpenFilesOnRemote`](Configuration.md#limitopenfilesonremote) if the server runs out of file descriptors.

## Why was my rename/move refused?

Renaming refuses rather than clobbering or guessing: the destination already exists (delete it first, or pick a different name), the new path falls outside [`remotePath`](Configuration.md#remotepath), or it would move a folder into its own subfolder. Nothing is touched when it's refused. See [Renaming and moving files](Workflows.md#renaming-and-moving-files-on-the-remote).
