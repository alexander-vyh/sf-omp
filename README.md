# sf-omp

Salesforce Agentforce and developer tooling from [Salesforce SF Pi](https://github.com/salesforce/sf-pi),
running natively in a repository-local **OMP 18.17.0** runtime on macOS. This fork is
rebased onto SF Pi 0.354.0 and keeps every bundled SF Pi extension: the
[extension catalog](./docs/extensions.md) lists them and the
[top-level command inventory](./docs/commands.md) lists their commands.

> **Unofficial.** sf-omp is a personal fork maintained by [@alexander-vyh](https://github.com/alexander-vyh). It is not a Salesforce product and is not affiliated with, endorsed by, or supported by Salesforce, Inc. Salesforce, Agentforce, and related marks are trademarks of Salesforce, Inc.

## Run

macOS only. Requires Node.js >=22.19 and npm (Node 24 recommended). OMP and Bun
are pinned local dependencies; nothing is installed globally.

```sh
npm ci
npm start
```

From an existing Salesforce project, keep that project as the working directory:

```sh
cd /path/to/your/salesforce-project
bun /path/to/sf-omp/scripts/omp.ts
```

Provider authentication reuses your existing global OMP logins. OMP UI and
settings stay local to this checkout. Full setup, including Salesforce CLI,
managed skills, and language servers, is in [Install](./docs/install.md).

## Salesforce prerequisites

All additional installs belong under ignored `.runtime/`, never global OMP. The
launcher uses a JDK extracted to `.runtime/toolchains/java` (`Contents/Home`
inside it), setting `JAVA_HOME`, `SF_LSP_JAVA`, and the child process's `PATH`
only. Use an ARM64 archive on Apple Silicon; JDK 21 LTS from
[Eclipse Temurin](https://adoptium.net/temurin/releases/?version=21) is
recommended. Verify the vendor's SHA-256 before extraction; `npm ci` does not
provision the JDK.

```text
/sf-lsp install
/sf-skills defaults install global
```

SF Browser page automation and SF tldraw rendering use pinned third-party
runtimes, also installed under `.runtime/toolchains` and picked up by the
launcher automatically:

```sh
bun scripts/provision-agent-browser.ts   # agent-browser + Chrome for Testing
bun scripts/provision-tldraw-office.ts   # tldraw office (closed source; downloaded, never committed)
```

Here `global` means this launcher's isolated `.runtime/omp/agent`, **not**
`~/.omp`. Use `project` to limit skill wiring to the current project's
`.omp/config.yml`.

Existing Salesforce CLI authentication is reused. Code Analyzer additionally
needs its `code-analyzer` CLI plugin, Java 11+ for PMD/CPD/SFGE, and Python
3.10+ for Flow analysis. LWC Jest belongs in the Salesforce application project.
Org-connected features require a suitable authenticated org and its feature
permissions; installing packages cannot supply those.

## Isolation

- The launcher runs this checkout's OMP **18.17.0** with local Bun **1.4.4**, never the global `omp` or `bun`.
- OMP configuration, profiles, agent state, native addon cache, and Bun/npm caches live under ignored `.runtime/`. Global extension discovery is disabled; the root `package.json` `pi.extensions` list selects the extensions.
- Normal launches keep your real HOME, XDG tool configuration, and Salesforce CLI authentication.
- Global OMP provider credentials and account policies are shared through OMP's native authenticated broker; the credential database is never copied or symlinked. Global extensions, plugin configuration, and conversation history are not imported.
- `npm ci` applies one version-checked patch **only inside this checkout's `node_modules`** (`scripts/patch-local-omp.mjs`): OMP 18.17's compatibility loader otherwise returns ESM namespace objects to CommonJS callers. Review or remove it when upgrading OMP.

## How parity is proven

| Check                | What it proves                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npm run parity:omp` | Each extension, loaded alone in real OMP, registers every manifest command, tool, provider, and supported event  |
| `npm run smoke:omp`  | One real OMP process loads all extensions and calls their registered tools, commands, and hooks against fixtures |
| `npm run smoke:auth` | Shared global OMP auth through the native broker, with invented credentials                                      |
| `npm test`           | The full SF Pi unit suite                                                                                        |

`parity:omp` compares results with `scripts/omp-parity-baseline.json` and fails
on any regression; record an improvement with `bun scripts/omp-parity.ts --update`.
Offline checks never call a live org, Slack, Fin, or model; those paths are
reported as not tested. Reports land under `.runtime/` (`omp-smoke-report.json`,
`omp-auth-smoke-report.json`, `parity/`).

## Checks

```sh
npm run check
npm test
npm run smoke:omp
npm run smoke:auth
npm run parity:omp
```

CI runs these on macOS for every push and pull request.

Upstream release history and Apache-2.0 attribution are retained in
[CHANGELOG.md](./CHANGELOG.md) and [LICENSE.txt](./LICENSE.txt).
