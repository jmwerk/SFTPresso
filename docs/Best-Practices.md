<!-- Source of the GitHub wiki page "Best Practices". Published by .github/workflows/sync-wiki.yml; edits made on the wiki are overwritten. -->

A few habits that'll save you a bad afternoon:

- `password`/`passphrase` sit in `sftp.json` as plain text, so don't commit that file if it has either — put it in `.gitignore`, and use [secret storage](Installation-and-Setup.md#storing-passwords-securely) or key-based auth ([`privateKeyPath`](Configuration.md#privatekeypath)/[`agent`](Configuration.md#agent)) instead where you can.
- Add the obvious noise to [`ignore`](Configuration.md#ignore) — `/.git`, `/.vscode`, `node_modules`, build caches, `.DS_Store`. Faster transfers, and you're not cluttering the server with things it doesn't need. The [Force commands](Commands.md#force-alt-commands) cover the rare exception.
- Before running a folder upload/Sync on a project you don't fully know, set [`maxFileSize`](Configuration.md#maxfilesize) — otherwise the first sign of that stray database dump or `.iso` in the tree is the transfer still running twenty minutes later.
- On a live site, turn on [`useTempFile`](Configuration.md#usetempfile) (and `openSsh` if the server supports it) so nobody ever loads a half-written file mid-deploy.
- Don't run [`uploadOnSave`](Configuration.md#uploadonsave) and a broad `watcher` (`"**/*"` + `autoUpload`) at the same time — that's just double uploads for no reason, pick one.
- `syncOption.delete` and `watcher.autoDelete` actually remove things on the other end, so keep [`syncConfirm`](Configuration.md#syncconfirm) on (it already defaults on whenever `delete` is) and run [Compare Folders](Workflows.md#comparing-folders-with-the-remote) first if you're not sure what a sync is about to do.
- If the server's clock is off, set [`remoteTimeOffsetInHours`](Configuration.md#remotetimeoffsetinhours) — otherwise timestamp-based sync can end up copying in the wrong direction. If timestamps are hopeless (checkouts, build steps, servers that don't keep them), switch to [`compareMode`](Configuration.md#comparemode) `"content"`.
- Shared hosts often choke on too many simultaneous SFTP operations; dropping `concurrency` to 1–3 trades some speed for not getting rate-limited.
- After touching `sftp.json`, just run `SFTP: Test Connection` — cheaper than finding the typo mid-upload.
- Profiles beat juggling several config files for dev/staging/prod, and don't forget the `… To All Profiles` commands exist for the day a release needs to land everywhere at once.
