<!-- Source of the GitHub wiki page "Development". Published by .github/workflows/sync-wiki.yml; edits made on the wiki are overwritten. -->

Issues and pull requests are welcome — the project is under active maintenance again at [jmwerk/SFTPresso](https://github.com/jmwerk/SFTPresso).

Development requires Node 22 or newer (see `.nvmrc`).

```sh
git clone https://github.com/jmwerk/SFTPresso.git
cd SFTPresso
npm install        # applies patches (ssh2, memfs) via patch-package
npm run compile    # production build (esbuild)
npm run dev        # watch mode for development
npm run typecheck  # TypeScript type check (tsc --noEmit)
npm run lint       # ESLint
npm test           # jest unit suites (no Docker, no network)
npm run package    # build the .vsix
```

Integration tests drive the real client layers against servers in Docker — FTP
(vsftpd + pure-ftpd) and SFTP (OpenSSH). They are not part of `npm test`:

```sh
npm run test:integration:up     # generates the throwaway ssh key, starts the containers
npm run test:integration
npm run test:integration:down
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for what each suite covers.

Highlights of the codebase:

- `src/extension.ts` / `src/app.ts` — activation and wiring
- `src/commands/` — one module per command
- `src/core/` — config, file system abstractions, transfer scheduling
- `src/modules/remoteExplorer` — the Remote Explorer view
- `schema/` — the JSON schema that validates `.vscode/sftp.json`
- `patches/` — `patch-package` fixes applied on install

See also [CONTRIBUTING.md](../CONTRIBUTING.md) and the [CHANGELOG](../CHANGELOG.md).
