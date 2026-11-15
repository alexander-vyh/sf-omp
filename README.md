# sf-omp

Repository-local Salesforce Agentforce tooling for **OMP 18.17.0**, forked from [Salesforce SF Pi](https://github.com/salesforce/sf-pi) 0.352.1. Independent checkout: the original SF Pi repository and global OMP installation are not used as the runtime.

## Run

Requires Node.js >=22.19 and npm; Node 24 is recommended for the bundled Salesforce tooling. OMP and Bun are pinned local dependencies; no global installation or `omp install` step.

```sh
npm ci
npm start
```

Provider authentication reuses your existing global OMP logins; no second provider login is needed for those accounts. OMP UI/settings stay local to this checkout; optional LSP downloads require confirmation.

From an existing Salesforce project, preserve that project's working directory:

```sh
cd /path/to/your/salesforce-project
node /path/to/sf-omp/scripts/omp.ts
```

Use explicit subcommands such as `/sf-agentscript help` and `/sf-skills help`. Bare commands that open the disabled SF Pi Manager are not ported; this checkout focuses on agent tools, direct commands, and native hooks. Existing extension READMEs describe the tools; upstream Pi installation instructions do not apply here.

## Isolation

- Launcher invokes this checkout's OMP **18.17.0** with local Bun **1.4.4**, never the global `omp`/`bun` command.
- OMP configuration, profiles, agent state, native addon cache, and Bun/npm caches live under ignored `.runtime/`. Global extension discovery is disabled; the root manifest selects the ten extensions below.
- Normal launches retain your real HOME, XDG tool configuration, and existing Salesforce CLI authentication.
- Global OMP provider credentials and account policies are shared through OMP's native authenticated broker. An existing configured broker is reused; otherwise the launcher starts a private loopback broker and stops it on exit. OAuth refreshes update the global credential store; its database is never copied or symlinked.
- Only auth account policies/reserve settings are overlaid locally. Global extensions, plugin configuration, and conversation history are not imported; these Salesforce extensions are never installed globally. Broker/configuration errors stop launch rather than silently falling back to local credentials.
- Project-specific configuration still belongs to the current Salesforce project. Skill loading uses native YAML `skills.customDirectories`; selecting an individual `SKILL.md` creates a local directory projection without enabling its siblings.
- Offline smoke uses a separate empty HOME and strips credential environment variables, including inherited auth-broker settings. It makes no model requests, Salesforce API requests, or org changes.

`npm ci` applies one version-checked patch **only inside this checkout's `node_modules`**. OMP 18.17's compatibility loader otherwise returns ESM namespace objects to CommonJS callers, breaking Salesforce dependencies with callable exports. `scripts/patch-local-omp.mjs` preserves Bun's `module.exports` interop, patches both bundled CLI and matching source, refuses a different OMP version, and is safe to rerun. Review/remove it when upgrading OMP.

## Current evidence

`npm run smoke:omp` starts real local OMP and calls actual registered tool implementations with its native extension context. It checks valid and invalid fixtures, native skill rediscovery, local runtime paths, and before/after hashes of global OMP configuration/installed files. Active logs, sessions, and runtime databases are excluded from that hash comparison.

| Extension          | Exercised in native OMP                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `sf-agentscript`   | Valid and invalid local AgentScript compilation; native terminal help panel                                                     |
| `sf-apex`          | Authoring plans and debug-log analysis; LSP diagnostics blocked without provisioned server assets                               |
| `sf-lwc`           | Valid and invalid template diagnostics using the real LWC compiler                                                              |
| `sf-flow`          | Authoring plan and valid/invalid local Flow diagnostics                                                                         |
| `sf-soql`          | API-versioned SOQL parser accepts/rejects queries; registered org-connected tool not exercised offline                          |
| `sf-skills`        | Native YAML loading, sibling exclusion, manual-only invocation, removal, unrelated-setting preservation                         |
| `sf-code-analyzer` | Startup/lifecycle registration; analyzer execution not yet exercised                                                            |
| `sf-lsp`           | Startup/lifecycle registration; native installer confirmation shows the repository-local destination; installation not accepted |
| `sf-brain`         | Startup/lifecycle registration; model-turn prompt projection not exercised by offline smoke                                     |
| `sf-guardrail`     | Startup/lifecycle registration; native tool interception not exercised by offline smoke                                         |

This is **not** proof of live deploy/activate, Agentforce preview/evaluation, schema grounding, Apex execution/tests, Code Analyzer engines, other interactive panels, or model-driven repair continuations. Those require additional runtime scenarios and, where applicable, an authorized Salesforce org. Java is currently unavailable on the development workstation; Apex language-server diagnostics require Java and the server installation. No org deployment/activation has been attempted.

## Checks

```sh
npm run check
npm run test:omp
npm run smoke:omp
npm run smoke:auth
```

The smoke report is `.runtime/omp-smoke-report.json`; detailed child logs and integrity snapshots remain in `.runtime/smoke/`. A blocked optional diagnostic is reported as blocked, never as a clean file. Any import failure, incorrect local result, or global integrity difference fails the smoke command.

The auth smoke report is `.runtime/omp-auth-smoke-report.json`. Disposable native SQLite stores and real local OMP verify API/OAuth credential resolution, live credential updates, refresh-token redaction, account-policy inheritance, all ten Salesforce registrations, local database/session storage, global-extension exclusion, and broker shutdown. This check uses invented credentials, never your global credentials or model requests.

The larger upstream source/docs tree is retained as reference. Only the ten root-manifest extensions form this OMP integration; gateway, browser, branding, package-manager UI, and other SF Pi extensions are not enabled or claimed ported. Upstream release history and Apache-2.0 attribution are retained.
