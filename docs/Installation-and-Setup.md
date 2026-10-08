<!-- Source of the GitHub wiki page "Installation and Setup". Published by .github/workflows/sync-wiki.yml; edits made on the wiki are overwritten. -->

## Installing the extension

As of **v1.20.2**, every tagged release is published automatically to both the **VS Code Marketplace** and **Open VSX** by [`.github/workflows/publish.yml`](https://github.com/jmwerk/SFTPresso/blob/develop/.github/workflows/publish.yml), so you can install it straight from your editor:

1. Open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **SFTPresso** and install it — or run `ext install jmwerk.sftpresso` from the Command Palette.
3. If you still have an older `sftp` extension installed (from `@liximomo` or `@Natizyskunk`), SFTPresso detects it on startup and prompts you to disable it — see [Legacy extension detection](#legacy-extension-detection).

Listings: [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jmwerk.sftpresso) · [Open VSX](https://open-vsx.org/extension/jmwerk/sftpresso) (for VSCodium, Gitpod, Eclipse Theia, and other editors that use Open VSX).

To sideload a specific build instead, install from a VSIX package:

1. Grab a `.vsix` from [GitHub Releases](https://github.com/jmwerk/SFTPresso/releases) — or build one from source (see [Development and Contributing](Development.md)).
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

## Legacy extension detection

SFTPresso is a fork, and the two projects it descends from — `sftp` (`@liximomo`) and `vscode-sftp` (`@Natizyskunk`) — happen to register commands under that same `sftp.*` namespace. Enable one of them alongside SFTPresso and VS Code has to pick one to actually run `SFTP: Upload`; which one it picks isn't something you control, and the resulting bugs are a nightmare to reproduce since half the time it isn't even this extension's code that ran.

So on startup, SFTPresso checks whether either older extension is installed *and enabled* (disabled doesn't count) and, if so, shows one notification: **Disable the Other**, **Show Me** (just reveals it in the Extensions view first), or **Don't Show Again** for this workspace. Nothing gets disabled without you clicking something — and the dismissal only applies to that one workspace, in case you've genuinely got a reason to run both somewhere.

## First-time setup

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
5. Type `SFTP` in the Command Palette to see all available commands (see the [Command Reference](Commands.md)). Many are also available from the file explorer and editor context menus.

Notes:

- `password` is optional — if omitted you'll be prompted when a connection is made, and offered to have the password remembered in VS Code's secret storage (see [Storing passwords securely](#storing-passwords-securely)). If you do store it in `sftp.json`, be aware it is **plain text** (see [Best Practices](Best-Practices.md)).
- Backslashes and other special characters in JSON values must be escaped with a backslash.
- `sftp.json` gets schema-validated in the editor, so you get completions and warnings for unknown or mistyped option names.

## Verifying your connection

Run **`SFTP: Test Connection`** from the Command Palette, or click the **Test Connection** CodeLens shown at the top of `sftp.json`. It connects using the active profile's settings and reports success or failure with an actionable message (see [SSH connection error messages](Troubleshooting.md#ssh-connection-error-messages)).

There's also a **connection-status indicator** in the status bar, next to the profile item — a plug icon when idle, a spinner while (re)connecting, an active-VM icon when connected, a disconnect icon when the server or network dropped the connection (it reconnects on next use), and a highlighted error icon when it fails. Hover it for the state in words. Connections reconnect lazily on the next operation, so without this you'd never actually see a reconnect fail; click the icon to run `SFTP: Test Connection`.

## Storing passwords securely

Instead of writing `password` into `sftp.json` (which is plain text), you can keep it in VS Code's secret storage, which is backed by the operating system keychain:

- Run **`SFTP: Save Password`**, pick the remote, and enter the password. Future connections use it automatically — no prompt, nothing in `sftp.json`.
- Or just connect: when you're prompted for a password and the connection succeeds, the extension offers to **remember** it.
- Already have a plaintext `password` in `sftp.json`? Run **`SFTP: Migrate Plaintext Password`** (or click **Migrate Password** on the warning) to move it into secret storage and strip the `password` key from the file in one step — comments and formatting are preserved, and you're asked to confirm first.
- Run **`SFTP: Clear Password`** to delete a saved password (for example after it changed on the server).

Saved passwords are keyed by `protocol://username@host:port` — so any config or profile pointing at the same server/user shares one, and it's only used when nothing else in the config already provides auth (`password`, `privateKeyPath`, `agent`, `interactiveAuth` all still work exactly as before). Still got a plaintext `password` sitting in `sftp.json`? You'll get a reminder when the config loads, with a **Migrate Password** button. If you've secured the file another way, click **Don't Show Again** to add [`"warnPlaintextPassword": false`](Configuration.md#warnplaintextpassword) to that config.

## Host key verification

SFTPresso checks the server's SSH host key before handing over your credentials — same as `ssh` or `scp` would. Without that, anything answering on the right IP gets trusted by default, which is exactly the gap a man-in-the-middle needs.

It looks in your own `~/.ssh/known_hosts` first (plus `known_hosts2` and `/etc/ssh/ssh_known_hosts`), so a host you've already accepted with plain `ssh` is trusted here too, no extra prompt — hashed entries, wildcards, `!` negations, `@revoked`, `[host]:port`, all of it works the way you'd expect. Keys you accept from inside SFTPresso itself go into a `known_hosts` file of its own (same format, in the extension's global storage) rather than touching yours — your real `known_hosts` stays something only your ssh client writes to.

What happens on connect depends on [`strictHostKeyChecking`](Configuration.md#stricthostkeychecking) (default `"accept-new"`):

- **First time seeing a host** — trusted and remembered silently by default. Set `"ask"` if you'd rather see a modal first, with the fingerprint in the same `SHA256:…` form `ssh-keygen -lf` prints, and a choice of Connect Once / Connect and Remember / cancel.
- **Key matches what's stored** — connects, no fuss.
- **Key changed** — connection refused, flat out, with both fingerprints shown and where the old one came from. There's deliberately no "connect anyway" button here — a changed key means either the server got rebuilt or something worse is happening, and those two shouldn't be one click apart. If you're sure it's legitimate, run **`SFTP: Forget Host Key`** and connect again.

**`SFTP: Show Host Key Fingerprint`** shows what's stored for a host and where it came from; **`SFTP: Forget Host Key`** clears it (asking first, with the file and line, if it'd mean touching a file your own ssh client maintains).

> ⚠️ **Coming from 1.29.0 or earlier?** Host keys weren't checked at all before this, so SFTPresso's store starts empty regardless of what you've already connected to. With the default `"accept-new"` nothing changes for existing configs — the first connection after upgrading just learns the key — but a key that *changes* after that now stops the connection instead of sailing through. One snag: if `~/.ssh/known_hosts` already has a stale entry you've been ignoring, that connection will start failing here too. Run `SFTP: Forget Host Key` or `ssh-keygen -R` to clear it.
