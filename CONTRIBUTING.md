# Contributing to SFTPresso

After you've created a branch on your fork with your changes, [open a pull request][pr-link]. 

*Please follow the guidelines given below while making a Pull Request to the SFTPresso*

## Pull Request Guidelines

* The Description should not exceed 100 characters.
* Make sure the PR title is in the format of `Add/Remove/Fix <feature>` *for e.g.*: `Add OpenSSH`
* Use a short descriptive commit message. *for e.g.*: ❌`Update Readme.md`  ✔ `Add OpenSSH connection Method`
* Search previous Pull Requests or Issues before making a new one, as yours may be a duplicate.
* Please make sure the feature has proper documentation.
* Please make sure you squash all commits together before opening a pull request. If your pull request requires changes upon review, please be sure to squash all additional commits as well. [This wiki page][squash-link] outlines the squash process.
* Target your Pull Request to the `develop` branch of the `SFTPresso`

Once you've submitted a pull request, the collaborators can review your proposed changes and decide whether or not to incorporate (pull in) your changes.

### Pull Request Pro Tips

* [Fork][fork-link] the repository and [clone][clone-link] it locally.
Connect your local repository to the original `upstream` repository by adding it as a [remote][remote-link].
Pull in changes from `upstream` often so that you stay up to date and so when you submit your pull request,
merge conflicts will be less likely. See more detailed instructions [here][syncing-link].
* Create a [branch][branch-link] for your edits.
* Contribute in the style of the project as outlined above. This makes it easier for the collaborators to merge
and for others to understand and maintain in the future.

### Open Pull Requests

Once you've opened a pull request, a discussion will start around your proposed changes.

Other contributors and users may chime in, but ultimately the decision is made by the collaborators.

During the discussion, you may be asked to make some changes to your pull request.

If so, add more commits to your branch and push them – they will automatically go into the existing pull request. But don't forget to squash them.

Opening a pull request will trigger a build to check the validity of all links in the project. After the build completes, **please ensure that the build has passed**. If the build did not pass, please view the build logs and correct any errors that were found in your contribution. 

*Thanks for being a part of this project, and we look forward to hearing from you soon!*

## Testing

Development requires Node 22+ (see `.nvmrc`).

### Unit tests

```sh
npm test        # jest, no network or Docker required
npm run typecheck
npm run lint
```

### FTP and SFTP integration tests

The `test/integration/` suite drives the remote client layers against real
servers running in Docker:

- **FTP** (`ftpClient.spec.ts`) — a plain vsftpd (LIST) and an explicit-FTPS
  pure-ftpd (MLSD), covering the `basic-ftp` client.
- **SFTP** (`sftpClient.spec.ts`) — an OpenSSH server, covering the ssh2 client
  and `SFTPFileSystem`: password and key auth, the
  `filePerm` / `perserveTargetMode` / `fallbackMode` mode cascade, `futimes`
  mtime preservation, symlinks, the `useTempFile` atomic-rename paths, the
  bounded directory walk, and `limitOpenFilesOnRemote`.

It is **not** part of `npm test`; it needs the compose stack up and Docker
available.

```sh
# 1. Start the servers (blocks until all report healthy)
npm run test:integration:up

# 2. Run the suite
npm run test:integration

# 3. Tear the servers down
npm run test:integration:down
```

`test:integration:up` generates the throwaway SSH keypair
(`test/integration/openssh/prepare-keys.sh`, gitignored — no private key is ever
committed) and then runs
`docker compose -f test/integration/docker-compose.yml up -d --build --wait`;
`:down` is `down -v`. The SSH server is built from
`test/integration/openssh/Dockerfile` so the sftp subsystem, OpenSSH's
posix-rename extension, and the test user's permissions are pinned; the FTP
images are pulled. Every credential, certificate, and key here is throwaway and
test-only — never reuse them anywhere else. All images are multi-arch, so the
stack runs the same on Apple Silicon and on CI. The same suite runs on every
push/PR in the `integration-tests` GitHub Actions job.

[branch-link]: <http://guides.github.com/introduction/flow/>
[clone-link]: <https://help.github.com/articles/cloning-a-repository/>
[fork-link]: <http://guides.github.com/activities/forking/>
[oauth-link]: <https://en.wikipedia.org/wiki/OAuth>
[pr-link]: <https://help.github.com/articles/creating-a-pull-request/>
[remote-link]: <https://help.github.com/articles/configuring-a-remote-for-a-fork/>
[syncing-link]: <https://help.github.com/articles/syncing-a-fork>
[squash-link]: <https://github.com/todotxt/todo.txt-android/wiki/Squash-All-Commits-Related-to-a-Single-Issue-into-a-Single-Commit>

