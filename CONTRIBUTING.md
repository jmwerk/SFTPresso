# Contributing to SFTPresso

Thanks for considering it — issues and pull requests are both welcome.

## Before you open a PR

- Search existing issues/PRs first; someone may have already hit the same thing.
- Target `develop`, not `main`.
- Keep commits squashed into one (or a small, logical few) before you open the PR, and
  squash again if you push more commits after review feedback.
- Title it `Add/Remove/Fix <feature>` (e.g. `Add OpenSSH connection method`) and write
  commit messages that say what changed, not `Update README.md`.
- If you're adding a feature, give it at least a line in the README or wiki — future-you
  and everyone else will thank you.

Once it's open, a link-check build runs automatically — make sure it's green before
asking for review.

## Testing

Development requires Node 22+ (see `.nvmrc`).

### Unit tests

```sh
npm test        # jest, no network or Docker required
npm run typecheck
npm run lint
```

### FTP and SFTP integration tests

`test/integration/` drives the real remote-client code against actual servers running
in Docker, rather than mocks:

- **FTP** (`ftpClient.spec.ts`) — plain vsftpd (LIST) and explicit-FTPS pure-ftpd
  (MLSD), covering the `basic-ftp` client.
- **SFTP** (`sftpClient.spec.ts`) — an OpenSSH server, covering the ssh2 client and
  `SFTPFileSystem`: password and key auth, the `filePerm`/`perserveTargetMode`/
  `fallbackMode` mode cascade, `futimes` mtime preservation, symlinks, the
  `useTempFile` atomic-rename paths, the bounded directory walk,
  `limitOpenFilesOnRemote`, and server-side rename/move (including that a populated
  directory's contents come through byte-for-byte, and that an existing destination
  is refused).

This suite isn't part of `npm test` — it needs Docker and the compose stack running:

```sh
npm run test:integration:up      # starts the servers, waits until healthy
npm run test:integration
npm run test:integration:down    # tears them down
```

`test:integration:up` generates a throwaway SSH keypair first
(`test/integration/openssh/prepare-keys.sh`; gitignored, never committed), then runs
`docker compose -f test/integration/docker-compose.yml up -d --build --wait`. The SSH
server is built locally from `test/integration/openssh/Dockerfile` so the sftp
subsystem, OpenSSH's posix-rename extension, and the test user's permissions stay
pinned; the FTP images are pulled as-is. Everything here — credentials, certs, keys —
is throwaway and test-only; please don't reuse any of it elsewhere. All images are
multi-arch, so this runs the same on Apple Silicon and in CI, where the same suite
runs on every push/PR via the `integration-tests` job.
