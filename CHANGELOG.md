## Unreleased

> ⚠️ **Behaviour change for every existing user: `idleTimeout` and `stallTimeout` now default on.** Both used to default to `0` — wait indefinitely — kept that way so adding the option wouldn't itself change anyone's behaviour. But a hung transfer or a silently-dropped pooled connection waiting forever isn't a behaviour anyone actually chose; it's just what "unset" happened to mean. `idleTimeout` now defaults to `60000`: a connection idle a minute is checked with a cheap round-trip before being handed to the next command, rather than handed out unchecked and discovered dead partway through. `stallTimeout` now defaults to `120000`: a transfer with zero bytes moving for two minutes is failed (and, per `retry`, retried) rather than left to hang — the clock resets on every chunk, so a large file that is merely slow is never touched. Two cases will start failing where they used to hang: a genuinely dead connection reused after a minute idle, and a transfer that stalls completely for two minutes on a wedged server — in both cases you now get an error instead of a spinner that never resolves. Set either to `0` to restore the old wait-forever behaviour.

* Fix : **`idleTimeout` and `stallTimeout` now default to `60000` and `120000` respectively, instead of `0`.** Both were added opt-in in 1.28.0 so an existing config's behaviour wouldn't change under it, but `0` on either one means the exact hang they exist to catch — a dead pooled connection, a transfer stuck at zero bytes — is still what happens on a default install. `operationTimeout` already defaults on for the same reason, since 1.29.0; these two now match it. See the note at the top of this section for what starts failing instead of hanging, and how to opt back out.
* New Feature : **Remote Explorer filter.** Finding a file in a server directory with hundreds of entries meant scrolling — `remoteExplorer.filesExclude` is static config, not something you can search with. **`SFTP: Filter Remote Explorer`** opens a live quick pick bound to the tree: typing narrows it (debounced ~150ms) to entries whose name contains the typed substring, plus the ancestor folders leading to each match — including folders you haven't expanded yet, since matching walks the remote tree rather than only what's already rendered. **`SFTP: Clear Filter`** resets it, and the view title shows the active query while a filter is applied. Substring match only for now; glob is a later refinement. The recursive walk caches directory listings for the life of a filter session (cleared on an explicit refresh or when the filter is cleared) so re-typing over an unchanged prefix doesn't re-list the same folders from the server repeatedly, and checks sibling folders concurrently rather than one at a time.
* New Feature : **`keepaliveInterval` and `keepaliveCountMax` config options.** The SSH keepalive interval and count were hardcoded (30s / ×2), with the only way to change them being to edit the extension's source — a real problem for high-latency or heavily NATed links that need a longer grace period, or hosts that reap idle connections faster than the old 60-second default noticed. Both are now `sftp.json` options: `keepaliveInterval` (ms, default `30000`, `0` disables) and `keepaliveCountMax` (default `2`). Unset, they fall back to the same defaults as before, so no existing config changes behavior. Also settable via `ServerAliveInterval` in `~/.ssh/config` (unchanged since 1.30.1) — an explicit `sftp.json` value still wins over it. SFTP only.
* New Feature : **`SFTP: Run Remote Command`.** Every other action here means shelling out to the system `ssh` binary and re-authenticating outside the extension entirely — but the extension is already holding an authenticated connection. This command reuses it: pick a saved command or type one, and it runs over the existing SSH connection, with stdout/stderr streamed live into the output channel and the exit code reported when it finishes. A `remoteCommands` block in `sftp.json` (label -> shell command, e.g. `{"remoteCommands": {"Restart PHP": "sudo systemctl reload php8.3-fpm"}}`) surfaces saved commands as a quick pick instead of a blank prompt. Every run — saved or typed — is confirmed with the resolved command and host shown before anything executes, since this runs on whatever server the active config points at. `remoteCommandTimeout` (default 60000ms) kills a command that runs too long and reports it as timed out; OpenSSH does not act on the kill request for a plain exec session, so the remote process may keep running detached after that. FTP configs get a clear error rather than attempting the command. sftp only.
* New Feature : **Server-side rename and move.** Renaming or moving a file or folder used to mean a full re-upload — and, with `watcher.autoUpload` on, a rename made outside VS Code looked like a delete followed by a create, so moving a large directory re-transferred everything inside it and, depending on event ordering, could delete the remote copy before the re-upload landed. A new **Rename** command on the Remote Explorer context menu prompts for a new name — a name containing `/` moves the item — and issues a single `rename()` call no matter how much is inside, regardless of size. It refuses to overwrite an existing destination rather than clobbering it, creates any missing intermediate remote directories, and validates that the destination stays inside `remotePath` (and isn't the item's own descendant) before anything reaches the network.
* New Feature : A new `watcher.autoRename` option (default `false`) extends server-side rename to renames and moves made **in VS Code's own Explorer** (F2, drag-and-drop) rather than only the dedicated Remote Explorer command — VS Code reports these through its own rename events, which are mapped to the equivalent remote paths and turned into the same single server-side rename. The delete-then-create events the file watcher would otherwise see for everything inside a moved directory are suppressed while the rename is in flight, so moving a large folder no longer re-triggers `autoUpload`/`autoDelete` on its own contents. A rename made by an external tool that writes straight to disk — the OS file manager, `git checkout`, a build script — isn't reported through VS Code's rename events at all, and still looks like a plain delete-and-create to the watcher, exactly as before. A move that crosses into a different configured root, or a rename that fails for any reason — including a file the watcher never actually uploaded in the first place — falls back to a normal upload of the new path followed by a delete of the old one, in that order, so the only remote copy is never removed before its replacement exists.
* Fix : `SFTP: Upload Changed Files` (uploads driven by Git-detected renames) was passing **local** filesystem paths into what is supposed to be a **remote** rename call, so a renamed file's remote counterpart was never actually renamed correctly, and the failure was silent — the call wasn't awaited, so a rejection became an unhandled promise rejection instead of the logged error the surrounding `try`/`catch` was meant to produce. It now resolves the real remote destination path and is awaited.
* Fix : **`sshConfigPath` only ever matched a literal `Host` entry.** Resolution used `find({ Host })`, a plain string lookup against the parsed config, so `Host *.example.com` wildcards and `Match` blocks — both ordinary `ssh_config(5)` syntax — contributed nothing: anyone using either got quietly pushed onto `sftp.json` and the built-in defaults instead, with nothing in the log to say why. It now resolves through the `ssh-config` library's `compute()`, which walks `Host`/`Match` precedence the way `ssh` itself does (`ssh-config` upgraded 1.1.3 → 5.2.1 to get it). `IdentityFile` still takes the first line found when a section repeats it.
* Fix : **`.ssh` is now excluded from the Remote Explorer by default.** The built-in exclusion list only ever covered VCS metadata directories and `.DS_Store`, so a `remotePath` pointed at a home directory — a common setup for personal servers — showed `.ssh`, `authorized_keys` included, as a fully browsable, editable, and deletable folder in the tree. `.ssh` now joins the default list; `remoteExplorer.filesExclude` adds to the defaults rather than replacing them, so there's no config-based way to make it visible again.
* Fix : **The `syncOption` JSON schema advertised `delete`, `skipCreate`, `ignoreExisting`, and `update` as defaulting to `true`.** None of that was ever true at runtime — nothing in the config validator or the sync code applies a default, so an unset key has always read as `undefined` and behaved as `false` — but the schema default is what `sftp.json`'s IntelliSense and the settings UI show, so hovering `syncOption.delete` claimed a destructive option was on by default when it silently did nothing unless set. The schema now states the actual default (`false`, off unless set) for all four, matching both the runtime and the docs.
* Fix : **A profile overriding `watcher`, `syncOption`, or `remoteExplorer` replaced the whole object instead of layering over it.** `mergeProfile` treated every config key as a scalar overwrite, so a profile that set `watcher: { autoUpload: false }` to quiet a production target silently dropped every other root-level watcher setting — `files`, `autoDelete`, `autoRename` — while that profile was active, since the profile's own `watcher` object never mentioned them. These three keys are option bags rather than atomic settings, so they now merge one level deep: a key the profile sets wins, a key it leaves out falls back to the root config's.
* Fix : **`concurrency` capped each transfer batch independently rather than the connection as a whole.** A `FileService` can have several batches in flight at once — the watcher's auto-upload queue, a `Sync`, `Upload … To All Profiles` — and each created its own scheduler sized to the configured `concurrency`, so two batches running together could push twice as many simultaneous transfers down one connection as intended. A shared `TransferSchedulerGroup` now gates every batch a `FileService` creates through one bounded queue, so `concurrency` is a ceiling across all of them rather than per command; switching profiles mid-run updates the ceiling for future batches without disturbing work already admitted through the gate.
* Fix : **A download could echo back through the watcher as an upload.** Writing the downloaded bytes to disk is indistinguishable from any other local write, so with `watcher.autoUpload` on, a download — `SFTP: Download`, `Edit in Local`, download-on-open, or a folder download — could trigger the watcher into re-uploading the file it had just pulled down, wasted traffic at best and a race between the download's write and the watcher's read at worst. The local path is now claimed with the same watcher-suppression mechanism server-side rename already uses, for the duration of the download, and renewed rather than left to expire if the download outlasts the normal suppression TTL.
* Internal : `fs-extra` moves 10.1.0 → 11.2.0 in a routine dependency refresh.

## 1.30.1 - 2026-08-11

* Fix : **The file watcher stopped deduplicating a while ago, and nobody noticed because the symptom is only extra uploads.** Its pending queues were `Set<vscode.Uri>`, and every `FileSystemWatcher` event delivers a *fresh* `Uri` instance — a `Set` compares object identity, so three saves of one file inside the 550 ms debounce window queued three entries and uploaded three times. That is the common case, not the corner one: autosave, formatters, and build watchers touching their own output all fire repeatedly on a single path. The queues are now keyed by `fsPath`. The debounce runs leading-and-trailing by design, so a burst of saves on one file settles at two uploads (one immediate, one at the end of the window) rather than one per event.
* Fix : **`SFTP: Disconnect` only closed the active profile's connection.** The command is the escape hatch for a connection that has stopped answering, and it could miss the very one you ran it for: with `dev`/`staging`/`prod` configured, two of them used, and `prod` active, disconnecting left `dev`'s connection open — including, quite possibly, the wedged one. It closes every profile now, plus a pool-wide sweep for connections opened under a config that has since been edited (nothing resolves to their identity any more, so per-config cleanup cannot reach them). The same leak applied on config reload and on deactivate, so both are fixed by the same change. The notification also reports the number actually closed instead of the number of configs it walked, and says "Nothing was connected" rather than claiming a disconnect that did not happen.
* Fix : **`ServerAliveInterval` and `ConnectTimeout` in `~/.ssh/config` had no effect at all.** Both were parsed and then mapped onto `keepalive` and `connTimeout` — option names `ssh2` does not have and never has had — so they were spread into the connect call and silently ignored. They now map to the options the client actually reads, and are converted from seconds (what `ssh_config` states) to milliseconds (what the client wants); a value that is not a number of seconds is skipped with a warning rather than becoming `NaN`, and the resolved value is logged at debug level. `ConnectTimeout` additionally could not have worked even under the right name: `connectTimeout` was defaulted to `10000` when the config file was read, which is indistinguishable from a value you typed, so it always sat in front of the ssh config. That default now applies *after* the ssh config has had its say — precedence reads `sftp.json` > `~/.ssh/config` > built-in, matching OpenSSH. **If you set `ServerAliveInterval` in your ssh config, it starts taking effect with this release**, replacing the built-in 30-second keepalive; a low value means noticeably more keepalive traffic.
* Fix : **A profile's `watcher` settings were ignored.** The watcher was built from the raw config in the `FileService` constructor, before profiles are resolved, and was never rebuilt — so "turn `autoUpload` off for production" did nothing, which is one of the main reasons to use profiles at all. It is now resolved from the profile-merged config and rebuilt whenever the active profile changes (or an in-memory config value does, such as `SFTP: Add to Ignore List` editing `ignore`). `watcher` is accepted inside a profile by the `sftp.json` schema to match, so the editor offers it there.
* Fix : Ignored paths no longer travel through the watcher's queue. The `ignore` rules were only consulted well down the transfer path, so an ignored file still occupied the queue, was still depth-sorted, and still crossed into the transfer machinery and the log — a `node_modules`-scale write burst pushed hundreds of doomed entries through the debounce. The resolved ignore function is now handed to the watcher and applied before enqueueing, for both uploads and deletes. The outcome for which files transfer is unchanged; what changes is how much work a burst of ignored writes costs.
* Fix : A disposed watcher was left in the lookup table. Recreating a watcher disposed the old one but did not remove it, and when the new config disabled watching the function returned early — leaving a disposed watcher in the table for the next lookup to hand out. It is now disposed *and* dropped before anything is rebuilt.
* Internal : The config-cache tests no longer fail on a Windows checkout. They built a `FileService` on a hard-coded `'/ws'`, but the ignore function decides local-vs-remote by comparing `path.normalize(fsPath)` — `'\ws\foo'` on Windows — against `baseDir`, so every local path took the *remote* branch, came out as `'../../ws/foo'`, and matched nothing. The suite now derives its paths the way the product does, and the same applies to the `ignoreFile` cache key, which resolves through `path.resolve` and so carries a drive letter there.
* Internal : `showHiddenFiles` is gone from the file systems. It was declared on both `list()` implementations with *opposite* defaults (`true` for SFTP, `false` for FTP), was documented nowhere, and no caller anywhere passed it — so it described a divergence that did not exist while implying a knob that was not reachable. Both implementations return every entry the server reports, minus `.` and `..`; filtering is `remoteExplorer.filesExclude`'s job in the Remote Explorer and `ignore`'s in transfers. Integration tests in both protocol suites now assert this, and record the one thing that genuinely differs and cannot be fixed here: whether a dotfile is reported at all is the server's call, since a plain FTP `LIST` (not sent with `-a`) omits them where `MLSD` does not.

## 1.30.0 - 2026-08-11

> ⚠️ **Behaviour change for every existing user: SSH host keys are now checked.** Before this release they were not checked at all, so there is nothing in SFTPresso's own store for anything you connect to today. With the default `strictHostKeyChecking` of `"accept-new"` every existing config keeps connecting exactly as it did — the first connection after upgrading learns the server's key — and from then on a *changed* key stops the connection instead of being accepted silently. Two cases will start failing where they used to succeed, both deliberately: a server whose key really has changed, and a server your `~/.ssh/known_hosts` holds a **stale** entry for (one `ssh` has been warning you about too). In either case, confirm the change is legitimate and then run **`SFTP: Forget Host Key`** — or fix the entry with `ssh-keygen -R` — and connect again. Set `"strictHostKeyChecking": false` to opt out entirely, at the cost of the protection this adds.

* New Feature : **SSH host keys are now verified.** Until now no `hostVerifier` was installed anywhere, which means `ssh2` accepted whatever key a server presented — so SFTPresso would connect to a man-in-the-middle and hand over credentials silently, every time, with nothing in the log to say so. Every other SSH client you use refuses in that situation, and now this one does too. The server's key is fingerprinted (`SHA256:` + base64, exactly what `ssh-keygen -lf` prints, so it can be compared by eye without converting) and looked up in your own `~/.ssh/known_hosts` first — including hashed entries, wildcards, `!` negations, `@revoked`, and `[host]:port` forms — so a host you already trust in `ssh` never prompts here. Keys accepted inside SFTPresso go to a `known_hosts` file of the extension's own, in the same format; your `~/.ssh/known_hosts` is never written to. A key that *changed* refuses the connection outright, with an alarm naming both fingerprints and where the stored one came from, and deliberately no button to proceed — a server rebuild and an attack look identical from here and must not be one click apart. Bastion hosts configured with `hop` are verified in their own right.
* New Feature : A new `strictHostKeyChecking` option mirrors OpenSSH's, as `true` / `false` / `"ask"` / `"accept-new"`. **The default is `"accept-new"`**: an unknown host is trusted and remembered on first connection exactly as before, but from then on a changed key stops the connection. That closes the hole that mattered while leaving every existing config connecting as it did — see the upgrade note below. `"ask"` prompts on first sight with the host, port, key type and fingerprint (**Connect Once** / **Connect and Remember** / cancel), and is what the config wizard writes into new configs. `true` refuses any host not already in a known_hosts file. `false` is the documented escape hatch and also lets a changed key through, loudly, in the log. A `@revoked` entry and a certificate host key are refused under every value.
* New Feature : Two new commands. `SFTP: Show Host Key Fingerprint` shows what is stored for a remote and which file each entry came from; `SFTP: Forget Host Key` removes those entries, which is what unblocks a connection refused because the server's key changed. Entries in files maintained by your ssh client are only removed after a confirmation naming the file and line, and everything else in the file — comments, other hosts — survives byte for byte.
* Fix : **A sync no longer deletes the destination when it fails to read the source.** `_sync` turned a failed directory listing into an empty one (`.catch(err => [])`). With `syncOption.delete` enabled, every entry on the destination was then absent from the source table and so classified as extraneous: a transient SFTP error, an `EACCES`, or an `EMFILE` under concurrency during **Sync Remote → Local** wiped the local directory, and during **Sync Local → Remote** the remote one. The error was not logged, not surfaced, and not counted. A listing that fails is now fatal for that subtree — deletion may only ever be driven by a listing that actually succeeded — and the failure is reported with the path and the operation that failed.
* Fix : `SFTP: Compare Folders with Remote` swallowed listing failures the same way, so the `syncConfirm` preview — which defaults on precisely when `delete` is enabled, and is the only thing standing between that bug and a support ticket — could itself be built from an empty listing and confidently offer to "delete 1,847 files". A directory that could not be listed is now reported as **Could not read** and its subtree is left out, the sync preview counts it separately and says up front that the plan below it is incomplete, and a root folder that cannot be read reports the error instead of an empty comparison.
* Fix : A sync's deletions are now visible after the fact. `sync()` has always returned what it removed and nothing looked at it, so a sync run with `syncConfirm` off deleted files with no trace anywhere. The count is now reported in a notification when the sync finishes and every path is logged at info level, so a surprising deletion is always answerable even when the preview was skipped.
* Internal : Shell scripts are pinned to LF via `.gitattributes`. Checked out with CRLF on a Windows clone, the integration suite's container entrypoint died with `exec /usr/local/bin/entrypoint.sh: no such file or directory` — the kernel reads the shebang as `/bin/sh` — so the whole compose stack failed to start and `npm run test:integration` was unrunnable there.

## 1.29.0 - 2026-08-11
* New Feature : A new `operationTimeout` option puts a deadline on each individual remote request — `mkdir`, `stat`, directory listings, renames, deletes — rather than on transfers. A request that goes unanswered for that long fails with `ETIMEDOUT`, which `retry` already treats as worth another attempt, and the connection is dropped so the next command opens a fresh one instead of inheriting a dead one. Unlike `idleTimeout` and `stallTimeout` this defaults on, at `60000`: a request that has gone a full minute without a reply is not slow, it is lost, and the alternative is an extension that hangs until the window is reloaded. Set it to `0` to wait indefinitely as before. The deadline covers one round trip, so transfers are unaffected (`get`/`put` are governed by `stallTimeout`, which measures progress rather than duration) and a composite operation gets one deadline per request rather than one for the lot — an `ensureDir` creating four directories can take as long as four `mkdir`s need. SFTP only: FTP is already covered by `connectTimeout`, which `basic-ftp` applies as a socket idle timeout, and its operations are serialized through a queue where a deadline started at call time would mostly measure how long the queue is.
* New Feature : A new `SFTP: Disconnect` command closes every pooled connection and drops it, so the next command reconnects from scratch. `operationTimeout` should make it unnecessary, but when something does get stuck this is the escape hatch that used to require reloading the window.
* Fix : An upload no longer hangs forever when the server's SFTP subsystem stops answering. This is the failure behind [#50](https://github.com/jmwerk/SFTPresso/issues/50), and it is a different one from the dropped connections `idleTimeout` and `stallTimeout` were added for in 1.28.0. The SSH transport stays up and keeps answering keepalive pings — `ssh2` counts the `REQUEST_FAILURE` reply as a healthy pong, so its own watchdog never fires — while the SFTP channel behind it stops being read. Once that channel's send window drains to zero every request is buffered locally and nothing reaches the wire, so there is no error to react to and no timeout to hit. Neither existing option covered it: `idleTimeout` is only consulted when a pooled connection is reused, and `stallTimeout` is armed inside a transfer, whereas the request that hangs is typically the `mkdir` that runs *before* the transfer is queued.
* Fix : Uploading several files at once no longer opens a connection per file and then kills the one that survives. Each file runs its own command, and each command asks the pool for a connection. The pool collapsed concurrent *connects* onto one promise, but the staleness check added in 1.28.0 introduced an `await` ahead of that guard: every caller saw the same connection as valid, every caller probed it, every caller invalidated it, and every caller then opened a replacement that overwrote the last one in the pool. Three files meant three probes, three ten-second timeouts and three simultaneous handshakes into a host that rate-limits them, and only the final instance was reachable afterwards. The whole acquisition is now serialized, so concurrent callers share one probe, one reconnect and one connection.
* Fix : A connection that has been replaced can no longer invalidate the one that replaced it. The pool registered its invalidation callback bound to the pool entry rather than to the connection it was watching, so when an orphaned socket finished unwinding — emitting `close`, or `error` on the `ECONNRESET` a rate-limiting server sends — the handler ran against whatever connection was current by then and tore down a perfectly healthy one. Combined with the race above, this is why a multi-file upload could fail with nothing in the log but a successful handshake followed immediately by `Socket ended`. The callback now ignores events from a connection the pool has already moved on from, and `invalid()` no longer clears the in-flight gate, which would have let a second acquisition start while the first was still running.
* Internal : The SFTP integration suite now runs with the operation guard installed rather than exercising a path the product no longer uses by default, and two specs cover what happens when the deadline fires — that a real request past its deadline fails with `ETIMEDOUT`, and that the disconnect notification the connection pool evicts on actually arrives.
* Internal : The shared `vscode` test mock is constructible. It returned a proxy around an arrow function, so any code path reaching `new vscode.ThemeColor(...)` — which the connection status bar does whenever a connection enters the error state — threw "not a constructor" instead of returning the mock's usual do-nothing value. No test covered that path before, and the first one to do so failed for reasons that had nothing to do with what it was testing.

## 1.28.1 - 2026-08-05
* Improvement : `ssh2`, the SSH/SFTP client the extension talks to remotes through, moves from 1.13.0 to 1.17.0, picking up four minor releases of upstream protocol and stream fixes. This also removes a patch the project had been carrying against it: `ssh2` imported `isDate` from `util`, which newer Node versions removed, and the patch swapped in an inline equivalent. 1.17.0 fixes this upstream by using `util.types.isDate`, so the patch is deleted rather than regenerated. The SFTP integration suite — 54 tests against a real OpenSSH server, covering password and key auth, binary and multi-megabyte round trips, mode and mtime preservation, symlinks, and the atomic-rename upload paths — passes against the unpatched 1.17.0.
* Improvement : `upath` (2.0.1 to 3.0.8) and `ignore` (5.3.2 to 7.0.6) move to their current major versions, along with `async` (3.2.4 to 3.2.6). These three sit in the transfer path — `upath` builds remote paths, `ignore` decides which files are skipped — so each was checked against the specific calls the extension makes rather than on test results alone: `upath` still exports `join`, `relative`, `basename`, `dirname`, and `normalize` with unchanged behaviour on the cases the code depends on, and `ignore` still exports the callable factory, `add()`, `ignores()`, and the static `isPathValid()`. Every `ignore` pattern form was additionally run through both 5.3.2 and 7.0.6 side by side over ~2,700 pattern/path combinations to find any decision that changed; exactly one did, below.
* Fix : Negated character classes in `ignore` patterns — `[!abc]` and `[^abc]` — now match what they say. `ignore` 5.x had the sense inverted, so `[!x]y.js` skipped `xy.js` (the one file it should have transferred) and transferred `ay.js` (the one it should have skipped); 7.0.6 fixes this upstream and follows gitignore semantics. Plain classes like `[abc]` and ranges like `[a-z]` are unaffected, as are `*`, `?`, `**`, negation with `!`, anchoring, and directory-only patterns — all verified unchanged. This only affects configs using the negated form, which is rare, but the effect is a straight inversion: **if your `ignore` or `ignoreFile` uses `[!...]` or `[^...]`, the set of files it skips flips with this release**, and a file previously excluded will start transferring. Check those patterns before upgrading if you have any.
* Internal : A release no longer republishes itself. `tag-version.yml` runs on every push to `develop` that touches `package.json`, which includes dependency bumps that leave the version alone. Its release dispatch was guarded against that, but its publish dispatch only checked that the tag existed — true on every such push — so each dependency merge re-dispatched a publish of the version already on the Marketplace, which then failed with `already exists`. Both dispatches are now gated on the run having actually created the tag, which is the real condition.
* Internal : Dependencies with patches applied to them are pinned to the exact version the patch targets. `patch-package` matches patches by exact version, so a floating range meant an unrelated upstream release could leave the patch unappliable — failing `postinstall` and killing every CI job before a single test ran, on a commit that had nothing to do with the package in question.
* Internal : The scheduler tests no longer strand timers. Several of them queue tasks and assert synchronously without awaiting them — deliberately, since that is how they observe a queue with work genuinely in flight — but the abandoned `setTimeout`s kept the event loop alive past the end of the file. Jest force-exited the worker on every run, and roughly one run in eight escalated to a worker crash that failed a suite with no assertion error to explain it. Timers are now tracked and cleared after each test; the stranded delays, and every assertion, are unchanged.
* Internal : Development dependencies move up — Jest 29 to 30, and `actions/checkout`, `actions/setup-node`, and `softprops/action-gh-release` to their current majors — and four high-severity advisories in the build toolchain (`undici`, `fast-uri`, `brace-expansion`, `picomatch`) are resolved, taking `npm audit` to zero. None of these ship in the extension; all four advisories were absent from both the production dependency tree and the packaged `.vsix`.

## 1.28.0 - 2026-08-03
* New Feature : A new `idleTimeout` option stops a server that silently closes idle connections from leaving the next upload hanging. Many shared hosts drop a connection after a few minutes of inactivity without sending anything to say so, and because the socket looks open the extension keeps handing it back — the next transfer then waits forever on a remote that will never answer, and only reloading the window clears it. Set `idleTimeout` to a number of milliseconds (a little under whatever your host allows) and a connection that has been unused for that long is checked with a cheap round-trip — an SFTP `realpath`, an FTP `NOOP` — before it is reused. A server that answers keeps its connection; one that refuses, or that doesn't answer within `connectTimeout`, gets dropped and reconnected transparently. Defaults to `0`, which reuses the connection unchecked exactly as before. The check runs when the connection is reused rather than on a timer, so it cannot interrupt a transfer that is still in flight.
* New Feature : A new `stallTimeout` option covers the other half of the same problem: a connection that dies *during* a transfer rather than between two. There is no error to react to in that case — the bytes simply stop arriving and the upload waits forever — so the only signal is the absence of progress. Set `stallTimeout` to a number of milliseconds and a transfer that goes that long without moving a single byte is failed instead of waited on, classified the same way a dropped connection is, so `retry` runs it again rather than reporting a hard failure. The clock resets on every chunk, so this measures stalling rather than total duration: a large file crawling over a slow link keeps pushing the deadline out and is never interrupted. Defaults to `0`, which waits indefinitely exactly as before.
* Fix : The status bar no longer leaves a hide-timer running after it has been reset. `showMsg()` arms a timer to restore the default text, and `reset()` restored the text without cancelling it, so the stale timer stayed live and could re-render over whatever state had replaced it in the meantime.

## 1.27.0 - 2026-08-03
* New Feature : Transfers that fail with a transient error are retried automatically. A new `retry` option (`{ "attempts": 2, "delay": 1000 }` by default) controls how many extra attempts a failed file gets and the base backoff between them; the wait doubles each attempt and is capped at 15s, so the defaults give 2s then 4s. Only errors worth another attempt are retried — `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `ENOTCONN`, a server that stopped responding, an ssh2 channel that was torn down, and FTP 4xx transient replies. Permission and not-found failures (`EACCES`, `ENOENT`, SFTP status 3, FTP 5xx) are never retried, and neither is a cancelled transfer; anything unrecognized is treated as fatal rather than hammering the server. Set `"retry": { "attempts": 0 }` to turn it off. Note that a retry re-runs the transfer over the connection the transfer was started on; a connection that has been dropped outright is re-established on the next command rather than mid-batch.
* Improvement : A failed batch no longer opens one error dialog per file. Failures are collected for 2 seconds and reported as a single "N files failed to transfer" message with a **Show Log** button; the full per-file error and stack are still written to the SFTP output channel.
* Improvement : `SFTP: Compare Folders with Remote` walks the tree with bounded concurrency instead of one directory at a time, so comparing a large project finishes in a fraction of the time. Sibling subtrees are now scanned in parallel, with the config's `concurrency` (default 4) capping how many directory listings are in flight across both the local and remote sides at once — the same shared-limiter approach the transfer and sync walks have used since 1.26.3, so a single connection isn't flooded. Results are still returned in sorted path order; the sort now also tiebreaks on the raw path, because two distinct paths that a locale comparison ranks equal (canonically equivalent accents, ignorable characters) would otherwise land in whatever order the parallel scan happened to finish in.
* Improvement : The "Comparing local and remote folders..." progress notification is now cancellable, and cancelling stops the directory scan itself rather than just dismissing the notification. A cancelled comparison shows no result list, since a partial diff would otherwise read as a complete one.
* Improvement : The resolved config is now memoized per profile instead of being rebuilt on every lookup. Resolving merges the profile, reads `~/.ssh/config`, resolves paths, validates against the schema, and compiles the `ignore` patterns — work that ran again for every file save, every Transfers view row, and every Remote Explorer entry. It now runs once per profile and is reused. The cache is dropped whenever the config can have changed underneath it: saving `.vscode/sftp.json`, switching profiles, and `SFTP: Toggle Upload on Save`. Invalidation also drops the cached contents of the file named by `ignoreFile`, so an edited ignore file is picked up on the next config reload rather than persisting for the session. A config that fails validation still throws on every call and is never cached.

## 1.26.4 - 2026-07-30
* Improvement : The Transfers view and status bar now show live transfer speed and, once the file size is known, an ETA. `TransferTask` keeps a rolling window of its last 5 throttled progress samples and derives bytes/sec from the oldest and newest one, so a single slow or fast tick doesn't swing the number — the figure stays undefined until a second sample lands (~1s in) rather than showing a misleading "0 B/s". Per-file rows in the Transfers view now read e.g. "42% — 3.1 MB / 7.4 MB — 1.2 MB/s — ETA 00:04"; when the total size is unknown, the ETA is omitted and only bytes and speed are shown. The status-bar "Transferring X/Y files" counter shown during bulk operations now also reports the combined speed across all in-flight files.

## 1.26.3 - 2026-07-30
* Fix : Two different remotes can no longer share a pooled connection. The connection cache keyed entries by concatenating config values with no separators or key names, so configs that differed only in an object-valued option (`hop`, `algorithms`, `secureOptions`) hashed identically — meaning two profiles reaching the same host through different bastions reused one connection and could transfer to the wrong server. Unseparated values collided too (`host: "foo"` + `username: "bar"` matched `host: "foob"` + `username: "ar"`), and the key depended on property order, so the same remote written two ways opened two connections. Identity is now a SHA-256 digest of a canonical, key-sorted, type-tagged serialization of the connection options; passwords are no longer retained inside cache keys.
* Fix : `syncOption.delete` removals are awaited. Deletions were fired without awaiting, so they raced transfers into the same tree and their failures were discarded — a sync could report success while leaving files on the remote that should have been deleted. Files are now removed before directories, and a failed delete fails the sync with the path in the message.
* Fix : `dirPerm` is applied to a directory before its contents are written, and a server that rejects the chmod logs a warning instead of producing an unhandled promise rejection. The chmod call was previously fire-and-forget.
* Fix : `limitOpenFilesOnRemote` no longer breaks every connection that sets it. The file-descriptor throttle hooked `sftp._stream`, an `ssh2` 0.8 internal that has not existed since the 1.x upgrade in 1.17.0, so enabling the option threw `Cannot read properties of undefined (reading 'open')` at connect time. It now hooks the SFTP client's `open`/`opendir`/`close` directly, and logs a warning instead of throwing if a future client drops them.
* Fix : An SFTP upload that is not handed an existing file handle no longer hangs forever. `SFTPFileSystem.put()` waited for the write stream's `finish` event, which `ssh2` only emits when it was given a handle — when it opens the file itself it emits `close` instead. Both are now accepted.
* Fix : `SSHClient._getSftp` resolved with an undefined SFTP handle after rejecting on error (a missing `return`), turning a connection failure into a later, more confusing crash.
* Improvement : Folder uploads/downloads and syncs walk the directory tree with bounded concurrency — the config's `concurrency`, and 1 for FTP — instead of listing every directory at once against a single connection, so large projects start transferring sooner and hold less in memory. `SFTP: Cancel All Transfers` now also interrupts the scan itself rather than only the transfers already queued.
* Internal : Add Dockerized SFTP integration tests (OpenSSH) covering the ssh2/SFTP client layer in CI, alongside the existing FTP suite — password and key auth, friendly connection errors, listing and stat, binary and multi-megabyte round trips, `futimes` mtime preservation, the `filePerm` / `perserveTargetMode` / `fallbackMode` mode cascade, `dirPerm`, symlinks, the `useTempFile` atomic-rename paths with and without `openSsh`, the bounded and cancellable directory walk, and `limitOpenFilesOnRemote`. The last four fixes above were all found by this suite.

## 1.26.2 - 2026-07-20
* Fix : `SFTP: Test Connection` no longer requires `.vscode/sftp.json` to be the active editor. Running it from the Command Palette while any workspace file is open now resolves that file's config; with no matching editor it falls back to the workspace's only config, or prompts to pick one when several are configured (the same resolution `SFTP: Toggle Upload on Save` uses).

## 1.26.1 - 2026-07-18
* Improvement : Consolidate the two duplicate debug settings. `sftp.debug` is now the canonical setting; `sftp.printDebugLog` — which had an identical description and purpose — is marked deprecated in the Settings UI (VS Code `deprecationMessage`) and in the docs, pointing to `sftp.debug`. Both flags are still honored, so existing setups that use `sftp.printDebugLog` keep working.

## 1.26.0 - 2026-07-18
* New Feature : A native getting-started walkthrough. A new "Get started with SFTPresso" entry (VS Code's `contributes.walkthroughs`) replaces the wall of README text for first-run onboarding with a checklist of four steps — **Create your config** (`SFTP: Config` quick setup), **Test the connection** (`SFTP: Test Connection`), **Download the project** (`SFTP: Download Project`), and **Enable upload on save** (`SFTP: Toggle Upload on Save`). Each step has a one-click command-link button and a `completionEvents` entry wired to the relevant command ID so it checks itself off once run, with step markdown under a new `resources/walkthrough/` folder. Open it any time from **Help → Welcome** or the Command Palette's "Welcome: Open Walkthrough…".

## 1.25.0 - 2026-07-18
* New Feature : Move a plaintext password out of `sftp.json` in one click. A new `SFTP: Migrate Plaintext Password` command finds a plaintext `password` in the active `sftp.json` (top-level or in a profile), saves it to VS Code's secret storage via the same path as `SFTP: Save Password` (keyed by `protocol://username@host:port`), then removes the `password` key with a `jsonc-parser` edit so comments and formatting survive — asking for confirmation before writing. In a multi-config array file the matching entry is edited. The existing one-time plaintext-password warning now also shows a notification with a **Migrate Password** button that launches the command.

## 1.24.0 - 2026-07-17
* New Feature : Add resources to `ignore` without editing JSON. A new `SFTP: Add to Ignore` command is available on the file-explorer right-click menu — it appends the selected file or folder's workspace-relative path to the active config's `ignore` array in `.vscode/sftp.json` (folders are added as `path/**`), editing only that array via `jsonc-parser` so comments and formatting survive. In a multi-config array file the matching entry is updated, and an entry already present in `ignore` is left untouched.

## 1.23.0 - 2026-07-16
* New Feature : Toggle `uploadOnSave` without editing JSON. A new `SFTP: Toggle Upload on Save` command flips the active config's `uploadOnSave` value and writes it back to `.vscode/sftp.json`, editing only that property so comments, formatting, and trailing commas survive (via `jsonc-parser`). The active config is resolved from the focused editor (or the sole config, otherwise a quick pick); in a multi-config array file the matching entry is updated. The status-bar item now shows a `$(cloud-upload)` indicator and an "Upload on Save: On/Off" tooltip line reflecting the current state, kept in sync as you switch files, profiles, or reload the config.

## 1.22.0 - 2026-07-15
* New Feature : Stale-remote guard before uploads. A new `conflictCheck` config option checks, before a file upload overwrites the remote, whether the remote copy changed since you last downloaded or uploaded it — and if so shows a modal with both timestamps and **Overwrite** / **Open Diff** / **Cancel** instead of silently clobbering the change. **Open Diff** opens the local/remote diff and leaves the remote untouched. The check is more than a timestamp comparison: the extension records what the remote looked like after each transfer of a file, so a conflict is still caught when your own local edit is the newest change (the case a plain local-vs-remote mtime check misses). With no recorded baseline yet it falls back to flagging a remote newer than the local copy. Applies to single-file uploads, including `uploadOnSave`; folder uploads and Sync are unaffected (use `syncConfirm` to review a tree). Defaults to `false`, so existing setups are unchanged.

## 1.21.0 - 2026-07-14
* New Feature : A connection-status indicator in the status bar. Since FTP connections reconnect lazily on the next operation (1.17.0), silent reconnects and auth failures previously gave no signal; a dedicated item now shows the remote connection state — `$(plug) SFTP` when idle, `$(sync~spin) SFTP` while connecting or reconnecting, `$(vm-active) SFTP` when connected, and `$(error) SFTP` with an error background on failure. When several remotes are live the most urgent state wins (connecting → error → connected → idle). Clicking it runs `SFTP: Test Connection`. Shown only when the extension is enabled, alongside the existing profile and transfer items.

## 1.20.2 - 2026-07-14
* Internal : Publish tagged releases to the VS Code Marketplace and Open VSX automatically. A new `.github/workflows/publish.yml` fires on every `v*` tag (and via manual `workflow_dispatch` with a tag input), runs `typecheck` + `test`, packages a single `sftpresso-<tag>.vsix` with `vsce`, then publishes that same artifact to the Marketplace (`vsce publish`, auth via the `VSCE_PAT` secret) and Open VSX (`ovsx publish`, auth via the `OVSX_PAT` secret). Runs alongside the existing `release.yml` (GitHub Release) rather than replacing it. From this release on, installs no longer require sideloading a VSIX.

## 1.20.1 - 2026-07-14
* Internal : Add Dockerized FTP integration tests (vsftpd + pure-ftpd) covering the basic-ftp client layer in CI.

## 1.20.0 - 2026-07-14
* New Feature : The Transfers view now shows byte-level progress for each in-flight file — e.g. "42% — 3.1 MB / 7.4 MB" in the item description (bytes only when the total size is unknown), refreshed at most ~2×/sec per file. Failed transfers keep their row with an inline **Retry** button (`sftp.retryTransfer`) that re-queues just that file with its original direction and options and resets its status to queued. Per-file cancel and the status-bar counter are unchanged.
* New Feature : Dry-run preview before syncs. A new `syncConfirm` config option shows a modal summary of exactly what a Sync command would do — e.g. "Sync Local → Remote: 3 uploads, 1 overwrite, 2 deletions. Proceed?" — with the affected files listed, computed from the local/remote diff and honoring `syncOption` (`delete` / `skipCreate` / `ignoreExisting` / `update`). Cancelling leaves everything untouched; confirming runs the sync unchanged; a sync with no differences reports "nothing to do" and does not run. `syncConfirm` defaults to `true` when `syncOption.delete` is enabled (the destructive case) and `false` otherwise.

## 1.19.1 - 2026-07-13
* Fix : The 1.19.0 package failed to load ("Cannot find module './impl/format'"), breaking every command. esbuild bundled `jsonc-parser`'s UMD entry, whose inner requires can't be inlined; the bundle now uses the package's ESM build. If you installed 1.19.0, update — no other changes.

## 1.19.0 - 2026-07-13
* New Feature : `sftp.json` is now read as JSONC — `//` line comments, `/* block */` comments, and trailing commas are allowed (parsed with `jsonc-parser`), and the editor treats the file as JSONC so comments aren't flagged as errors. Malformed configs now report the parse error with its line and column instead of a raw exception.
* New Feature : Show the active profile in the status bar. When `sftp.json` defines `profiles`, the status bar item reads `SFTP: <profile>` (or `SFTP: (no profile)` when none is active) and clicking it opens the `SFTP: Set Profile` picker; the text updates immediately on profile switch and resets when a config reload removes the active profile. Configs without profiles keep the previous behavior (`SFTP`, click to toggle the output panel).

## 1.18.0 - 2026-07-13
* New Feature : Guided quick setup for `SFTP: Config` — when no `sftp.json` exists yet, the command now offers "Quick setup" alongside "Edit JSON" (the previous template behavior). Quick setup walks through protocol (sftp/ftp), host, port (defaulted per protocol), username, authentication method (password prompt at connect / private key with `~` expansion and existence check / ssh-agent), remote path, and upload-on-save, validates the answers against the config schema, writes `sftp.json`, and runs `SFTP: Test Connection` to verify the connection.
* New Feature : Store connection passwords in VS Code's secret storage (backed by the OS keychain) instead of plaintext `sftp.json`. New `SFTP: Save Password` and `SFTP: Clear Password` commands manage saved passwords per remote (keyed by `protocol://username@host:port`), and after a successful password-prompted connection the extension offers to remember the password. Saved passwords are used automatically whenever a config provides no other authentication; configs using `password`, `privateKeyPath`, `agent`, or `interactiveAuth` are unaffected.
* Improvement : Log a one-time warning in the output channel when a plaintext `password` is found in `sftp.json`, suggesting the `SFTP: Save Password` command instead.

## 1.17.0 - 2026-07-13
* Internal : Replace the unmaintained `ftp` package with `basic-ftp` behind the existing FTP client abstraction, preserving `secure` / `passive` / `remoteTimeOffsetInHours` semantics (including clear-text data connections for `secure: "control"`). Verified against vsftpd and pure-ftpd Docker servers over plain FTP, explicit FTPS, and control-only TLS. The `p-queue` dependency is replaced by an internal serial queue.
* Improvement : On FTP servers that support MLSD, directory listings now report exact second-precision UTC timestamps, making timestamp-based sync more reliable (`remoteTimeOffsetInHours` is typically only needed for servers limited to `LIST` now). The listing command is pinned per connection so timestamp semantics can't silently change mid-session.
* Internal : FTP connections no longer send periodic NOOP keepalives; if the server closes an idle connection, the extension reconnects automatically on the next operation.
* Internal : Upgrade `joi` 10 → 18 (config validation) and `lru-cache` 4 → 11 (dropping `@types/lru-cache`).
* Internal : Modernize the toolchain — build with esbuild (replacing webpack + ts-loader), TypeScript 3.9 → 5.9, TSLint → ESLint (typescript-eslint), tests via ts-jest, CI on Node 22/24 (16/18 are EOL), and dependabot coverage for GitHub Actions.
* Internal : Raise the minimum supported VS Code version to 1.75 and align `@types/vscode` with it; declare `vscode-uri` as a real dependency (it was previously resolved only by accident through dev dependencies).
* Fix : Register command modules from an explicit index instead of webpack's `require.context`, which would silently register no commands under any non-webpack bundler.

## 1.16.9 - 2026-07-09
* New Feature : Add `sftp.testConnection` command — connects to the active profile's remote using the current `.vscode/sftp.json` config and reports success/failure, with a "Test Connection" CodeLens shown at the top of the config file.

## 1.16.8 - 2026-07-09
* New Feature : Add a `Transfers` view to the SFTP sidebar showing live per-file status (queued/transferring/failed) during folder upload/download/sync operations, with a per-file cancel button in addition to the existing `Cancel All Transfers` command.

## 1.16.7 - 2026-07-09
* New Feature : Add `Compare Folders with Remote` command — recursively diffs a local folder against its remote counterpart and lists new-local, new-remote, and modified files in a QuickPick, with per-file actions to open a diff or upload/download.

## 1.16.5 - 2026-07-08
* Fix : Surface actionable error messages for common SSH connection failures (auth failure, connection refused, timeout, host unreachable, DNS resolution) instead of raw ssh2 error text.
* Fix : Preserve the underlying error when a remote connection drops unexpectedly, so it's logged instead of silently discarded.
* New Feature : Add a transfer progress counter ("Transferring X/Y files") to the status bar during bulk uploads/downloads. Click it to cancel all in-flight transfers.

## 1.16.3 - 2023-06-16
* [#356] New Feature : Upload to all profiles (Pull request [#313](https://github.com/Natizyskunk/vscode-sftp/pull/313) from @wewawa vscode-sftp:create_multi_command).
* [#357] Fix : Correcting Typo 'avaliable' => 'available' (Pull request [#343](https://github.com/Natizyskunk/vscode-sftp/pull/343) from @kjo-sdds vscode-sftp:develop).
* [#358] Permissions : Add filePerm and dirPerm options for configuring permissions (Pull request [#347](https://github.com/Natizyskunk/vscode-sftp/pull/347) from @Jchase2 vscode-sftp:develop).
* [#359] Fix : Correcting sftp connection with public key (Pull request [#350](https://github.com/Natizyskunk/vscode-sftp/pull/350) from @inu1255 vscode-sftp:develop).
* Upgrade `ssh2` version to official v1.13.0 by @mscdex.

## pre-1.16.2 - 2022-11-30
* [#271] Fix case change of file name not sent correctly (Pull request [#249](https://github.com/Natizyskunk/vscode-sftp/pull/249) from @NyaPPuu vscode-sftp:fix_rename).
* [#272] Update npm `types/node` depedency to v9.6.51.

## 1.16.1 - 2022-11-02
* [#251] Add multiple select + Update `Download File` & `Downalod Folder` commands to the remote view + Add `Upload File` & `Upload Folder` commands to the remote view (Pull request [#221](https://github.com/Natizyskunk/vscode-sftp/pull/221) from @NyaPPuu vscode-sftp:add_multiple_select).

## 1.16.0 - 2022-10-29
* [#242] Add order option and fix typos in docs (Pull request [#157](https://github.com/Natizyskunk/vscode-sftp/pull/157) from @NyaPPuu vscode-sftp:add_order_option).
* [#243] Fix refresh when creating/deleting file/folder + Fix 'Reveal in Remote Explorer' and Refresh Button in Remote Explorer. (Pull request [#159](https://github.com/Natizyskunk/vscode-sftp/pull/159) from @NyaPPuu vscode-sftp:fix_refresh).
* [#244] Cleanup Text in Markdown Files (Pull request [#213](https://github.com/Natizyskunk/vscode-sftp/pull/213) from @BrayFlex vscode-sftp:develop).

## 1.15.20 - 2022-08-28
* Fix typo 'worksapce' to 'workspace' (Pull request [#158](https://github.com/Natizyskunk/vscode-sftp/pull/158) from @NyaPPuu vscode-sftp:fix_typo).
* Add `Download File` & `Downalod Folder` commands to the remote view (Thanks to @mrandrey on issue #97).
* Update npm `types/fs-extra` depedency to v9.0.13 (Pull request [#204](https://github.com/Natizyskunk/vscode-sftp/pull/204) from @dependabot vscode-sftp:dependabot/npm_and_yarn/types/fs-extra-9.0.13).
* Update npm `typescript-tslint-plugin` depedency to v1.0.2 (Pull request [#206](https://github.com/Natizyskunk/vscode-sftp/pull/206) from @dependabot vscode-sftp:dependabot/npm_and_yarn/typescript-tslint-plugin-1.0.2).
* Update npm `tslint` depedency to v6.1.3 (Pull request [#207](https://github.com/Natizyskunk/vscode-sftp/pull/207) from @dependabot vscode-sftp:dependabot/npm_and_yarn/tslint-6.1.3).
* Update npm `ts-loader` depedency to v9.4.1 (Pull request [#208](https://github.com/Natizyskunk/vscode-sftp/pull/208) from @dependabot vscode-sftp:dependabot/npm_and_yarn/ts-loader-9.4.1).
* Update npm `typescript` depedency to v3.9.7.
* Update npm `jest` depedency to v29.0.3.

## 1.15.19 - 2022-08-26
* [#72] Change `uploadOnSave` default value from true to false.

## 1.15.18 - 2022-08-26
* Update npm `async` depedency to v3.2.4.
* Update npm `fs-extra` depedency to v10.1.0.
* Update npm `tmp` depedency to v0.2.1.
* Update npm `upath` depedency to v2.0.1.

## 1.15.17 - 2022-08-26
* Upgrade `ssh2` version to official v1.11.0 by @mscdex.

## 1.15.16 - 2022-05-26
* Reorder cipher and serverHostKey algorithms.
* Update [FAQ.md](https://github.com/Natizyskunk/vscode-sftp/blob/master/FAQ.md), and [documentations](https://github.com/Natizyskunk/vscode-sftp/tree/master/docs).

## 1.15.15 - 2022-08-21
* Fix "Open SSH in Terminal" not working because "terminal.integrated.shell.windows" is deprecated and fix typo `src/commands/commandOpenSshConnection.ts`. (Pull request [#155](https://github.com/Natizyskunk/vscode-sftp/pull/155) from @mean-cj vscode-sftp:patch-2).

## 1.15.14 - 2022-05-06
* Update npm `async` depedency to v2.6.4.
* Update npm `minimist` depedency to v1.2.6.

## 1.15.13 - 2022-02-11
* Add support for OpenSSH v8.8 SSH private key by using SHA-2 instead of SHA-1 to fix SSH public key signatures. (See issue [#112](https://github.com/Natizyskunk/vscode-sftp/issues/112)).

## 1.15.12 - 2022-02-11
* Add deletions support to "Upload Changed files" command. (Pull request [#113](https://github.com/Natizyskunk/vscode-sftp/pull/113) from @brykov vscode-sftp:master merged inside [#117](https://github.com/Natizyskunk/vscode-sftp/pull/117)).

* ## 1.15.11 - 2022-02-09
* Enhance sftp interactiveAuth mode (See [Wiki](https://github.com/Natizyskunk/vscode-sftp/wiki/SFTP-only-Configuration#interactiveauth)). (Pull request [#94](https://github.com/Natizyskunk/vscode-sftp/pull/94) from @lacastorine vscode-sftp:lacastorine merged inside [#114](https://github.com/Natizyskunk/vscode-sftp/pull/114)).

## 1.15.10 - 2021-11-22
* Update npm `json-schema` devDepedency to v0.2.3.

## 1.15.9 - 2021-11-21
* Remove ssh configuration bug introduced in pull request [#69](https://github.com/Natizyskunk/vscode-sftp/pull/69) from @clemyan while we can find another solution.

## 1.15.8 - 2021-11-12
  * Fix 'Upload Changed Files' & 'No Such File' bugs (Commit [fix upload changed files](https://github.com/wandway/vscode-sftp/commit/775016788e4c59db901dc68a20c1f61ebcca7bc7#diff-20516d8841b4891f1926f1e40e447e99e0575a5e36ba6814f6b85b45db1b8fbb) from @wandway vscode-sftp:master).
  * Make the 'Upload Changed Files' command visible and add a default keyboard shortcut (Ctrl+Alt+U) to call it (Merged pull request [#84](https://github.com/Natizyskunk/vscode-sftp/pull/84) from @PaPa31 vscode-sftp:master). See [FAQ](https://github.com/Natizyskunk/vscode-sftp/blob/master/FAQ.md#clicking-upload-changed-files-does-not-work)).
  * Update Webpack from 4.39.2 to 5.0.0.
  * Update Webpack-cli from 3.3.7 to 4.7.0.

## 1.15.7 - 2021-11-12
  * Upgrade `ssh2` version to official v1.5.0 by @mscdex.

## 1.15.6 - 2021-10-27
  * Fix ssh configuration resolution (Merged pull request [#69](https://github.com/Natizyskunk/vscode-sftp/pull/69) from @clemyan vscode-sftp:fix-ssh-config).

## 1.15.5 - 2021-10-27
  * Update mtime after file was saved before upload (Merged pull request [#75](https://github.com/Natizyskunk/vscode-sftp/pull/75) from @viperet vscode-sftp:save_before_upload_mtime).
  * Add pull request issue template.
  * Add funding/sponsors page.
  * Add code scanning alert.

## 1.15.4 - 2021-10-04
  * Remove error message when calling sftp.sync.remoteToLocal command in vscode tasks.json.

## 1.15.3 - 2021-09-10
  * Upgrade `ssh2` version to official v1.4.0 bcy @mscdex.

## 1.15.2 - 2021-08-24
  * Fix the `useTempFile` bug (Merged pull request [#41](https://github.com/Natizyskunk/vscode-sftp/pull/41) from @kripper vscode-sftp:master).
  * Change `useTempFile` default value from true to false.
  * Fix the "Cannot read property 'handle' of undefined" bug (related to `useTempFile` bug) [TypeError: Cannot read property 'handle' of undefined](https://github.com/Natizyskunk/vscode-sftp/issues/43).
  * Fix the "fd argument must be of type number. Received undefined" bug (related to `useTempFile` bug) [TypeError since last update (The "fd" argument must be of type number.)](https://github.com/Natizyskunk/vscode-sftp/issues/34).
  * Fix the "Permission denied" bug when uploading.
  * New option [openSsh](https://github.com/Natizyskunk/vscode-sftp/wiki/Common-Configuration#openssh) (Pull request [#42](https://github.com/Natizyskunk/vscode-sftp/pull/42) from @kripper vscode-sftp:atomic-rename merged inside [#45](https://github.com/Natizyskunk/vscode-sftp/pull/45)).
  * Update of the wiki to add support for openSsh option.

## 1.15.1 - 2021-08-24
  * Add the `useTempFile` option to the test configuration spec.
  * Fix get target mode error && add more precise logger-infos for tranfer tasks (Merged pull request [#29](https://github.com/Natizyskunk/vscode-sftp/pull/29) from @kripper vscode-sftp:master).

## 1.15.0 - 2021-08-23
  * New option [useTempFile](https://github.com/Natizyskunk/vscode-sftp/wiki/Common-Configuration#usetempfile) (Merged pull request [#29](https://github.com/Natizyskunk/vscode-sftp/pull/29) from @kripper vscode-sftp:master).
  * Update of the wiki to add support for useTempFile option.

## 1.14.0 - 2021-08-06
  * Update of the FAQ to add support for old/legacy systems.
  * switching from beta to stable.

## 1.14.0-beta - 2021-07-15
  * Add `create remote file` and `create remote folder` commands (Merged pull request [#18](https://github.com/Natizyskunk/vscode-sftp/pull/18) from @mathsgod vscode-sftp:master).

## 1.13.6 - 2021-07-15
  * Fix syntax in `src\fileHandlers\transfer\__tests__\transfer-test.ts`.

## 1.13.5 - 2021-07-10
  * Reorder test parameters for `keepalive`.
  * Add v1.13.5-beta. Only use beta version if you still encounter the "REQUEST_FAILURE" error like described in those two issues : [Buffering on save file after 15 minute](https://github.com/Natizyskunk/vscode-sftp/issues/7) & [Infinite spinner on file save after server rest connection with client](https://github.com/Natizyskunk/vscode-sftp/issues/8).

## 1.13.4 - 2021-07-10
  * Fix "Error with the transfer direction."
  * Add loggers for transfer informations.

## 1.13.3 - 2021-07-09
  * re-add braces >=2.3.1 to package.json.
  * re-add yargs-parser ^20.2.4 to package.json.
  * Remove `yarn.lock`.
  * Add `package-lock.json`.
  * Fix Writing CHANNEL_DATA (0) / Writing FSETSTAT (Merged pull request [#12](https://github.com/Natizyskunk/vscode-sftp/pull/12) from @zarausto vscode-sftp:patch-1).
  * Fix transfer-test for Windows platform (Merged pull request [#11](https://github.com/Natizyskunk/vscode-sftp/pull/11) from @alex1504 vscode-sftp:fix-transfer-test).

## 1.13.2 - 2021-07-07
  * remove braces >=2.3.1 to package.json.
  * remove yargs-parser ^20.2.4 to package.json.
  * Remove the fix for the "No such file" error on VSCode 1.56 since it's been implementend in the new ssh2 v1.1.0 npm package (Commit [SFTP: explicitly set autoClose option for node 14+](https://github.com/mscdex/ssh2/commit/c0de05d186065ad4081b98d2f7aa0fe22161ec09) from @mscdex ssh2:master).

## 1.13.1 - 2021-07-06
  * Add braces >=2.3.1 to package.json.
  * Add node-notifier >=8.0.1 to package.json.
  * Add yargs-parser ^20.2.4 to package.json.
  * Changing publisher and repo links.
  * Fixed error "No such file" on VSCode 1.56.
  * Fixed issue with uploading of file which has unsaved changes.

## 1.13.0 - 2021-07-06
  * Upgrade `ssh2` version to official v1.1.0 by @mscdex.

## 1.12.10 - 2021-05-15
  * Improve sftp reliability.

## 1.12.3 - 2019-04-27
  * Minor improvements.
  * Bug fix.

## 1.12.1 - 2019-03-28
  * Fix [#510](https://github.com/liximomo/vscode-sftp/issues/510).

## 1.12.0 - 2019-03-21
  * new option [sshCustomParams](https://github.com/liximomo/vscode-sftp/wiki/SFTP-only-Configuration#sshcustomparams).

## 1.11.0 - 2019-03-15
  * Save before upload.
  * Fix [#490](https://github.com/liximomo/vscode-sftp/issues/490).

## 1.9.4 - 2019-02-26
  * Fix sshConfig file not work.
  * Open SSH in Terminal can enter to remote path.

## 1.9.3 - 2019-01-30
  * New icon for RemoteExplorer. Thanks [niccolomineo](https://github.com/niccolomineo) and [jonbp](https://github.com/jonbp).
  * Change `port` to number in the generated configuration.

## 1.9.2 - 2019-01-22
  * Fix [#388](https://github.com/liximomo/vscode-sftp/issues/388).
  * Fix [#456](https://github.com/liximomo/vscode-sftp/issues/456).
  * Fix [#459](https://github.com/liximomo/vscode-sftp/issues/459).

## 1.9.0 - 2019-01-08
  * Control files and folders to show or hide in Remote Explorer by `remoteExplorer.filesExclude`. [#410](https://github.com/liximomo/vscode-sftp/issues/410).
  * Suport new OpenSSH key format. [#391](https://github.com/liximomo/vscode-sftp/issues/391).
  * Improve performance.

## 1.8.4 - 2018-12-16
  * Fix ignore not work when use profile. [#428](https://github.com/liximomo/vscode-sftp/issues/428).

## 1.8.3 - 2018-12-14
  * Upgrade VSCode engine version.

## 1.8.2 - 2018-12-13
  * Add **Collapse All** action to RemoteExplorer.

## 1.8.0 - 2018-12-06
  * New command [Upload Changed Files](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-upload-changed-files).
  * Fix bugs.

## 1.7.6 - 2018-11-22
  * Reduce *80%* startup time.
  * Fix [#396](https://github.com/liximomo/vscode-sftp/issues/396).

## 1.7.5 - 2018-11-15
  * Fix [#394](https://github.com/liximomo/vscode-sftp/issues/394).

## 1.7.4 - 2018-11-09
  * Fix [#362](https://github.com/liximomo/vscode-sftp/issues/362).
  * Don't upload the file when it's in downloading. [#390](https://github.com/liximomo/vscode-sftp/issues/390).

## 1.7.3 - 2018-11-03
  * New configuration [limitOpenFilesOnRemote](https://github.com/liximomo/vscode-sftp/wiki/Configuration#limitopenfilesonremote).
  * Show `upload file` context menu in SCM.

## 1.7.2 - 2018-10-29
  * New command [Open SSH in Terminal](https://github.com/liximomo/vscode-sftp/wiki/Commands#open-ssh-in-terminal).

## 1.7.1 - 2018-10-25
  * New setting [downloadwhenopeninremoteexplorer](https://github.com/liximomo/vscode-sftp/wiki/Setting#downloadwhenopeninremoteexplorer).
  * fix some bugs.

## 1.7.0 - 2018-10-19
### New Features
  * New command [Upload Active Folder](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-upload-active-folder).
  * New command [Download Active Folder](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-download-active-folder).
  * New command [List Active Folder](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-list-active-folder).
  * New command [Cancel All Transfers](https://github.com/liximomo/vscode-sftp/wiki/Commands#cancel-all-transfers).
  * New configuration [remotetimeoffsetinhours](https://github.com/liximomo/vscode-sftp/wiki/Configuration#remotetimeoffsetinhours).

## 1.6.0 - 2018-10-12
### New Features
  * New command [Sync Local -> Remote](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-sync-local---remote).
  * New command [Sync Remote -> Local](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-sync-remote---local).
  * New command [Sync Both Directions](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-sync-both-directions).
  * New configuration [syncOption](https://github.com/liximomo/vscode-sftp/wiki/Configuration#syncoption) for `Sync` command.

### Breaking Changes
  * Remove Command `SFTP: Sync To Remote`.
  * Remove Command `SFTP: Sync To Local`.
  * Remove configuration option `syncModel`.

## 1.5.13 - 2018-10-08
* Fix [#344](https://github.com/liximomo/vscode-sftp/issues/344).

## 1.5.12 - 2018-10-07
* New command `Diff Active File with Remote`.
* Command `Set Profile` can receive an argument from keybindings.

  ```json
  {
    "key": "ctrl+shift+cmd+d",
    "command": "sftp.setProfile",
    "args": "dev"
  }
  ```

## 1.5.10 - 2018-09-28
* Fix [#332](https://github.com/liximomo/vscode-sftp/issues/332).

## 1.5.9 - 2018-09-27
* Fix [#330](https://github.com/liximomo/vscode-sftp/issues/330).

## 1.5.8 - 2018-09-25
* Show name in the remote explorer. [#315](https://github.com/liximomo/vscode-sftp/issues/315).
* Fix [#308](https://github.com/liximomo/vscode-sftp/issues/308).

## 1.5.0 - 2018-09-13
### New Features
  * new [alt commands](https://github.com/liximomo/vscode-sftp#alt-commands) `Force Download` and `Force Upload`. This allow you to download/upload files but disregard ignore rules.

### Breaking Changes
  * Rename command `sftp.trans.remote(SFTP: Upload)` to `sftp.upload.activeFile` and command `sftp.trans.local(SFTP: Download)` to `sftp.download.activeFile`. Please update your keybinding if you've used one of these commands.

### Deprecated
  * Commands `SFTP: List` and `SFTP: List All` will be removed in favor of `Remote Explorer` in next release.

## 1.4.1 - 2018-09-03
### Feature
  * [Configuration in User Setting](https://github.com/liximomo/vscode-sftp#configuration-in-user-setting) Configuration your remote in User Setting.

### Fix
  * Fix sshConfig file not overwriting default configuration. [#305](https://github.com/liximomo/vscode-sftp/issues/305).

## 1.4.0 - 2018-08-27
### Feature
  * [Connection Hopping](https://github.com/liximomo/vscode-sftp#connection-hopping) allow you to connection to a target server through a proxy with ssh protocol.

## 1.3.9 - 2018-08-14
* Fix [#286](https://github.com/liximomo/vscode-sftp/issues/286).
* Fix [#287](https://github.com/liximomo/vscode-sftp/issues/287).

## 1.3.8 - 2018-08-13
* Fix [#285](https://github.com/liximomo/vscode-sftp/issues/285).

## 1.3.7 - 2018-08-10
* Fix bug in `remoteExplorer.refresh`.

## 1.3.0 - 2018-08-02
### New Features
  * [Remote Explorer](https://github.com/liximomo/vscode-sftp#remote-explorer).

## 1.2.7 - 2018-07-27
### New Features
  * `ignoreFile` [option](https://github.com/liximomo/vscode-sftp/wiki/Configuration#ignorefile).

## 1.2.3 - 2018-06-19
### New Features
  * [Swtichable Profiles](https://github.com/liximomo/vscode-sftp/#profiles).

## 1.2.0 - 2018-06-19
* Support [SSH configuration file](https://www.ssh.com/ssh/config/). The default ssh configuration file is `~/.ssh/config`. This can be changed by `sshConfigPath` option.

## 1.1.12 - 2018-06-08
* Fix [#200](https://github.com/liximomo/vscode-sftp/issues/200). Thanks for [Gergo Koos](https://github.com/gergokoos).

## 1.1.11 - 2018-05-21
* Fix [#198](https://github.com/liximomo/vscode-sftp/issues/198).

## 1.1.10 - 2018-05-18
* Show open folder prompt in `sftp:config` command.
* Fix [#174](https://github.com/liximomo/vscode-sftp/issues/174).

## 1.1.9 - 2018-05-17
* Add `confirm` option to `downloadOnOpen`.
* Fix [#160](https://github.com/liximomo/vscode-sftp/issues/160).
* Fix [#195](https://github.com/liximomo/vscode-sftp/issues/195).

## 1.1.8 - 2018-05-15
* Some UX improvements.
    * Only show `sftp` menu when extension get activated (Thanks [@mikolino](https://github.com/mikolino)).
    * Remove some unnecessary warning.
* Improve ftp reliability.
* Upgrade `ssh2` version.

## 1.1.7 - 2018-03-31
* `name` [configuration](https://github.com/liximomo/vscode-sftp#full-config).
* Fix bugs.

## 1.1.6 - 2018-03-24
* Better procedure message in status bar.
* Fix sync error when synced target is not exist.
* Fix [#146](https://github.com/liximomo/vscode-sftp/issues/146).

## 1.1.5 - 2018-03-23
* Improve stability of `ftp` protocol.
* Fix document don't show automatically after select a file through `list` command.
* Fix [#113](https://github.com/liximomo/vscode-sftp/issues/113).

## 1.1.4 - 2018-03-21
* `connectTimeout` [config](https://github.com/liximomo/vscode-sftp#full-config).
* `downloadOnOpen` [config](https://github.com/liximomo/vscode-sftp#full-config).
* Fix ftp unexpectedly traverse up director [#80](https://github.com/liximomo/vscode-sftp/issues/80). Thanks for [Andrey Orst](https://github.com/andreyorst)'s help.

## 1.1.3 - 2018-03-18
* Remove default ignore configuration. No files will be ignored if you don't explicitly configuration `ignore` option. Related isuse [#138](https://github.com/liximomo/vscode-sftp/issues/138).
* Fix [#133](https://github.com/liximomo/vscode-sftp/issues/133).
* Fix [#136](https://github.com/liximomo/vscode-sftp/issues/136).


## 1.1.0 - 2018-03-13
* `diff` command.
* Fix [#113](https://github.com/liximomo/vscode-sftp/issues/113).
* Fix [#124](https://github.com/liximomo/vscode-sftp/issues/124).

## 1.0.5 - 2018-02-24
* Support [multi select in the Explorer](https://code.visualstudio.com/updates/v1_20#_multi-select-in-the-explorer).
* Fix some bugs.

## 1.0.4 - 2018-02-08
* New configuration option `concurrency`.
* New configuration option `algorithms`.
* Fix [#103](https://github.com/liximomo/vscode-sftp/issues/103).

## 1.0.3 - 2018-02-05
* Simplify default configuration file's content when exec `sftp: config`.
* Configuration autocomplete.
* Fix watcher stop work after 'download' or 'sync to local'.

## 1.0.2 - 2018-01-30
* Add FTPS support.
* Add passphrase/password dialog support.
* Fix configuration not found error after configuration file changed.
* Fix `sftp config` failed to show created configuration file in vscode.

## 1.0.0 - 2018-01-26
🎉🎉🎉This release include some new features, bugfixs and improvements. It may be bring some new bugs, welcome to feedback.

### New Features
* `list` and `list all` command.
  * `list` will list all remote files except those match your ignore rules.
  * `list all` will list all remote files.

  The target will be dowmload after you select. And it will be open in vscode if the target is a file.
* When you download a folder through a command, the vscode explorer will be refreshed when the command finish.

### Breaking Changes
* Change to git ignore [spec](https://git-scm.com/docs/gitignore). It's more powerful and concise. You may need to change your ignore configuration.


## 0.9.4 - 2017-12-18
* `Context` now receives a relative path.
* Fix [#69](https://github.com/liximomo/vscode-sftp/issues/69), [#70](https://github.com/liximomo/vscode-sftp/issues/70).

## 0.9.0 - 2017-12-16
* Add a option to configuration a local path that correspond to a remote path.
* Support multiple configurations in one configuration file.
* Remove `.sftpConfig.json` configuration file support.
* Remove none-worksapce-root configuration files support.

## 0.8.11 - 2017-11-30
* Fix ftp can't preserve file permissions.

## 0.8.10 - 2017-11-20
* Disable create configuration at none-workspace-root-folder.

## 0.8.9 - 2017-11-17
* Preserve file permissions.
* Better README thanks [kataklys](https://github.com/kataklys).
* Fix Empty (0kb) files when download and uplaod. Thanks for [kataklys](https://github.com/kataklys)'s help ([#33](https://github.com/liximomo/vscode-sftp/issues/33))
* Show a waring for existing none-worksapce-root configuration files. Previously you can create multiple configuration files anywhere under workspace. So you won't need to open multiple vscode instances to make `sftp` working in different folders. Sincle vscode support [Multi-root Workspaces](https://code.visualstudio.com/docs/editor/multi-root-workspaces). There is no necessary to support multiple configuration now. This will make `sftp` both simple and a bettern starup performace.

## 0.8.8 - 2017-11-11
### Bugfix
* Files is not correctly filtered at configuration setup.

## 0.8.7 - 2017-11-07
### Bugfix
* Configuration setup not work for directories whose name does end with `.vscode`.

## 0.8.6 - 2017-11-06
* Performance improvement.
* Show a waring to the old `.sftpConfig.json` file.

### Behaviour Change
Now `uploadOnSave` only happens on a vscode save opetarion. It used to happen on a disk save opetarion caused by anything.

## 0.8.5 - 2017-10-18
### Improvement
* support more cipher algorithms.

## 0.8.4 - 2017-10-10
### Improvement
* log more infos to output pannel.

## 0.8.3 - 2017-09-26
### Bugfix
* fix couldn't create configuration through file picker when no sub files in the directory.

## 0.8.2 - 2017-09-24
### Enhance
* Don't need to reload vscode after execute `SFTP: config` command.
* `SFTP: config` creates `sftp.json` now.

## 0.8.1 - 2017-09-22
### Bugfix
* WIN could not find configuration(path is not normalized).

## 0.8.0 - 2017-09-22
### Feature
* support multi-root workspace.

### Change
* Configuration file name is changing to `sftp.json` from `.sftpConfig.json` for concision.

### Bugfix
* fix a bug that always return the same ssh session when have multiple configurations in workspace.

## 0.7.11 - 2017-09-13
### Bugfix
* fix tribe retrive.

## 0.7.10 - 2017-09-13
### Bugfix
* fix configuration not found when have multiple configuration files in workspace.

## 0.7.9 - 2017-09-01
### Bugfix
* change tip text from uploading to sync when download and upload.

## 0.7.8 - 2017-08-20
### Bugfix
* Fix `command not found error` when no folder opened.

## 0.7.7 - 2017-07-25
### Bugfix
* Fix folder match of ignore.

## 0.7.6 - 2017-07-24
### Bugfix
* Fix [files in "ignored" directories are still uploaded](https://github.com/liximomo/vscode-sftp/issues/15). Thanks for [Tom Spence](https://github.com/tomjaimz)'s help.

## 0.7.5 - 2017-07-18
### Feature
* A new editor configuration `sftp.printDebugLog`, dafault with false.

## 0.7.4 - 2017-07-14
### Enhance
* Configuration validation failing at startup does not require a reload to make extension work.

## 0.7.3 - 2017-07-13
### Feature
* Configuration validation.

### Misc
* More accurate watcher description.

## 0.7.2 - 2017-07-04
### Feature
* Add a way to execute commands on all detected configuration root folders.(run commands throw command palette)

## 0.7.1 - 2017-07-04
### Bugfix
* Fix miss files because of throttle.

## 0.7.0 - 2017-06-30
### Breaking Change
* Now configuration files are located in .vscode folder. Just move every .sftpConfig.json to the .vscode folder of same hierarchy.

## 0.6.14 - 2017-06-29
### Enhance
* show authentication input as asterisk.

## 0.6.13 - 2017-06-28
### Feature
* ssh agent authentication.

## 0.6.12 - 2017-06-26
### Feature
* Interactive authentication.

## 0.6.11 - 2017-06-22
### Feature
* Ignore works for download/sync remote file to local.

## 0.6.10 - 2017-06-13
### Enhance
* Better log.

## 0.6.9 - 2017-06-11
### Bugfix
* Remove unnecessary error message.
* Sync blocks on symlink.

## 0.6.8 - 2017-06-09
### Enhance
* Activate the extension only when it needs to. You must have the vscode greater than 1.13.0.

## 0.6.7 - 2017-06-07
### Enhance
* Keeping active so you don't have to reload vscode to active sftp when create configuration file at the first time.

## 0.6.6 - 2017-06-06
### Bugfix
* Window can't auto create dir non-existing.

## 0.6.2 - 2017-06-05
### Bugfix
* Incorrectly configuration not found error popup.

## 0.6.1 - 2017-06-03
### Bugfix
* Don't watch file when there is no .sftpConfig file.

## 0.6.0 - 2017-06-02
### Feature
* Support ftp.

### Feedback
* More debug info.

### Bugfix
* Fix `SFTPFileSystem.rmdir` doesn't resolve correctly.
* Disable watcher on pulling files.
* Make true re-connect when it need to.

## 0.5.4 - 2017-05-30
### Feedback
* Better error log.
* Output debug info in sftp output channel.

### Bugfix
* Fix some files missed uploading when they has updated because of throttle.

## 0.5.3 - 2017-05-26
### Feature
* AutoSave now works even in external file update!🎉🎉🎉
* A new configuration `watcher`. Now there is a way to perceive external file change(create, delete).

## 0.5.2 - 2017-05-22
### Bugfix
* Running a command through shortcut couldn't find active document correctly.

### Feedback
* Show path that is relative to the workspace root instead of full path on status bar.

## 0.5.1 - 2017-05-22
### Enhance
* Provide a way to run command at the workspace root.

## 0.5.0 - 2017-05-19
### Feature
* Keep ssh connect alive (re-connect only when needed).

## 0.4.12 - 2017-05-18
### Bugfix
* Fix binary file upload.

## 0.4.11 - 2017-05-18
### Feedback
* Better status indication.

## 0.4.10 - 2017-05-18
### Bugfix
* Configuration file not found in windows.
* Check existence of privateKeyPath.

## 0.4.0 - 2017-05-17
### Configuration
* Add option `syncModel`.

### Command
* New command Upload.
* New command Download.
