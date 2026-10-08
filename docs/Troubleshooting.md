<!-- Source of the GitHub wiki page "Troubleshooting". Published by .github/workflows/sync-wiki.yml; edits made on the wiki are overwritten. -->

## Enabling debug logs

1. Open Settings (`File → Preferences → Settings`, or `Code → Preferences → Settings` on macOS).
2. Set `sftp.debug` to `true` and **reload VS Code**.
3. View the logs in `View → Output` and select the **SFTPresso** channel.

If a connection drops mid-session, the underlying error is logged there (since 1.16.5) instead of being silently discarded.

## SSH connection error messages

As of 1.16.5, common SSH failures surface as plain-language messages instead of raw `ssh2` errors:

| Message | Meaning |
| --- | --- |
| **Connection refused** | Nothing is listening on the configured host/port, or a firewall is blocking it. |
| **Connection timed out** | Host unreachable — wrong address, network/VPN issue, or a firewall silently dropping packets. |
| **Host not found** | Hostname couldn't be resolved; check for typos or DNS issues. |
| **Authentication failed** | Username, password, or private key was rejected by the server. |

Check the `sftp` Output channel (see [Enabling debug logs](#enabling-debug-logs)) for the underlying detail.

## FTPS transfers fail after connecting (TLS session reuse)

With `secure: true`, some servers (notably pure-ftpd) require the data connection to reuse the control connection's TLS session, which can fail under TLS 1.3 with errors like *"Client network socket disconnected before secure TLS connection was established"* on every listing or transfer, even though the connection itself succeeds. Cap the TLS version via [`secureOptions`](Configuration.md#secureoptions):

```json
{ "secureOptions": { "maxVersion": "TLSv1.2" } }
```

## Error: Failure

This generic message comes from the **remote** SFTP server when a syscall fails. To pinpoint it, enable debug output on the *server* side and retry. Two common causes:

1. **`remotePath` points at a symlink** — change it to the actual (resolved) path.
2. **The server ran out of file descriptors** — raise the server's descriptor limit, or if you can't, set [`limitOpenFilesOnRemote`](Configuration.md#limitopenfilesonremote) in `sftp.json`.

## Error: Connection closed

On legacy/old servers the connection may keep closing because of a key-exchange algorithm mismatch. Override the [`algorithms`](Configuration.md#algorithms) to drop `diffie-hellman-group-exchange-sha256` from `kex`:

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

## ENFILE: file table overflow (macOS)

macOS has a harsh default limit on open files. Raise it:

```sh
echo kern.maxfiles=65536 | sudo tee -a /etc/sysctl.conf
echo kern.maxfilesperproc=65536 | sudo tee -a /etc/sysctl.conf
sudo sysctl -w kern.maxfiles=65536
sudo sysctl -w kern.maxfilesperproc=65536
ulimit -n 65536
```

## Upload Changed Files does nothing

Historically the command was hidden and had no shortcut (see [liximomo/vscode-sftp#854](https://github.com/liximomo/vscode-sftp/issues/854)). It is now visible in the Command Palette and Source Control view and bound to `Ctrl+Alt+U` by default. It requires a Git repository with at least one commit — it uploads files changed or created **since the last commit**.

## Remote Explorer not refreshing after delete

After deleting a remote file, the tree may not update — manually refresh the parent folder (the ↻ button or `sftp.remoteExplorer.refresh`).

## Known issues fixed in this fork

All fixed on `develop` now, kept here mostly for anyone who hits an old bug report and wonders if it's still true:

- `TypeError: isDate is not a function` on upload/download — a Node/`ssh2` incompatibility, patched via `patch-package`.
- Compile errors and Jest/`memfs` breakage that used to hit a fresh checkout — gone, `npm run compile` and `npm test` both pass cleanly now.
- Two remotes could end up sharing one pooled connection if their configs differed only in something like `hop` or `algorithms` — occasionally sent a transfer to the wrong server. Fixed in 1.26.3 by hashing the connection options properly instead of just concatenating them.
- `limitOpenFilesOnRemote` broke every connection that set it, throwing at connect time — an internal `ssh2` API it depended on had been removed in the 1.x upgrade. Fixed in 1.26.3.
- `syncOption.delete` fired its deletions without waiting for them, so a sync could report success while files were actually still sitting on the remote. Fixed in 1.26.3.
