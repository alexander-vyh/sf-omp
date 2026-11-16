# SF Pi Manager

## What It Does

SF Pi Manager is the package home base. `/sf-pi` lets users browse extensions,
open human-facing detail pages, edit low-risk settings, run diagnostics, manage
recommended packages and external skill roots, and enable or disable bundled
extensions through Pi's native package filters.

The Manager is always active. On Pi, extension state changes update
`settings.json` and reload Pi because package filters are evaluated at startup.

### Enable/disable on OMP

OMP ignores Pi `settings.json` for loading; its native switch is
`disabledExtensions` in OMP YAML config. On the OMP host, `/sf-pi enable|disable`,
`enable-all|disable-all`, the Manager list toggles, and every extension's
"Disable this extension" action write `extension-module:<id>` entries there:

- global: `<agentDir>/config.yml` (the repository-local `.runtime/omp/agent`);
- project: `<cwd>/.omp/config.yml`, which replaces the global list when it
  defines `disabledExtensions` (OMP replaces arrays across layers).

Only bundled `extension-module:<id>` entries are rewritten; other native entries
such as `skill:<name>` are preserved. The sf-omp launcher loads extensions
explicit-only (`--no-extensions -e <repo>`), a mode in which OMP itself skips
`disabledExtensions`, and OMP's reload never re-runs extension factories, so each
bundled extension's `requirePiVersion` gate honours the entry at load time. A
change therefore applies on the next OMP start; the Manager says so instead of
reloading. `alwaysActive` extensions are never gated.

## Commands

Common commands are:

```text
/sf-pi
/sf-pi doctor
/sf-pi status
/sf-pi open <extension-id>
/sf-pi enable <extension-id> [global|project]
/sf-pi disable <extension-id> [global|project]
/sf-pi display <compact|balanced|verbose>
/sf-pi announcements
/sf-pi recommended
/sf-pi auto-update status
/sf-pi help
```

The Manager detail page is the primary no-args destination for bundled extension
commands. Explicit subcommands remain direct and scriptable.

## Configuration

Manager-owned settings include package filters, shared display profile, privacy
preference controls, announcements/recommendations state, doctor repairs, and
opt-in Native Auto Update. Project settings override global settings where a
surface supports both scopes.

SF Pi sets Pi's anonymous install/update telemetry preference to `false` only
when the user has never chosen a value. Explicit `true` or `false` choices are
preserved and `/sf-pi telemetry` reports whether the value is an SF Pi default or
user override.

Native Auto Update is off by default. When enabled, due work waits for a
non-aborted, terminal `agent_end` (OMP marks retry, compaction, and follow-up
ends with `willContinue`), then for the host to be idle; it uses an atomic machine lock,
and handles eligible package and Salesforce CLI targets independently. It never
updates the Pi Runtime itself. Package automation is limited to outdated, unpinned global
npm packages whose metadata declares compatibility with the active Pi and Node
versions.

### Updates and recommended packages on OMP

sf-omp is a git checkout launched through repository-local OMP, so on the OMP
host Auto Update (and `/sf-pi auto-update run`) never calls `pi update`:

1. The OMP runtime is pinned by the checkout's lockfile and only changes with it.
2. sf-omp checkout: `git fetch` the branch's upstream and count ahead/behind.
   Only a clean, attached branch that is strictly behind is updated, with
   `git pull --ff-only` followed by `npm ci`; dirty, detached, ahead, diverged,
   upstream-less, and unreachable checkouts are reported and left untouched.
3. `sf update stable`, as on Pi.

A successful pull recommends restarting OMP. The same consent, settled-turn,
idle, lock, and abort rules apply.

Recommended packages cannot run under sf-omp: the launcher starts OMP
explicit-only (`--no-extensions -e <checkout>`), a mode in which OMP loads
neither Pi packages nor plugins installed with `omp plugin install`. On OMP,
`/sf-pi recommended` and `recommended status` list every item as unsupported with
that reason and the OMP-native or bundled capability that covers it (for
example OMP's web search/fetch tools for `pi-web-access`, the bundled sf-herdr
extension for `pi-herdr`); `recommended install|remove` are refused without
running any installer, and the startup recommendations nudge is suppressed.

## Safety and Data Boundaries

- Only SF Pi Manager writes the package-filter enable/disable state.
- Native Auto Update is opt-in, interactive-only, abortable, output-redacted,
  and bounded to eligible unpinned npm packages plus the Salesforce CLI step.
- Pinned, local, Git, project-scoped, incompatible, and unverifiable packages
  are skipped rather than rewritten.
- `/sf-pi doctor fix` performs only named safe repairs after confirmation and
  quarantines duplicate skills instead of deleting them.
- Extensions marked `alwaysActive` cannot be disabled through the standard
  toggle path.

## Troubleshooting

**The Manager cannot find SF Pi in settings:** Install with `pi install .` from
the repository or `pi install git:github.com/salesforce/sf-pi` so Pi records the
package source.

**A toggle does not take effect:** On Pi, allow the requested reload. On OMP,
restart OMP; enablement is read when extensions load.

**A newer stable Pi version is outside the audited window:** Run
`/sf-pi doctor runtime`. Supported 0.x versions can load in forward-compatibility
mode; do not downgrade without a concrete failure.

**Auto Update skipped a package:** Run `/sf-pi auto-update status`. Pinned,
project, local, Git, current, incompatible, and unverifiable installations are
intentionally outside the automatic path. On OMP the status names why the
checkout was not updated (for example local changes or a diverged branch).

**Auto Update waits for a settled turn:** This is expected. An aborted turn,
new turn, reload, shutdown, or settings change cancels or defers pending
automatic work.

**Project changes do not stick:** Project settings live under
`<cwd>/.pi/settings.json` and win over global settings. Pass the intended scope
explicitly when changing extension state.

**Recommended items or skill roots look stale:** Announcements, recommendations,
and skill-source decisions are revision/state based. Use their Manager pages and
`/sf-pi doctor` before editing state files manually.

**`pi-web-access` reports `Blocked internal address` for a public site:** A VPN or
TUN client can map public hostnames into a reserved synthetic address range such
as `100.64.0.0/10` or `198.18.0.0/15`. `pi-web-access` blocks those ranges by
default to prevent server-side request forgery. Run `/sf-pi doctor` to check the
active DNS result. If the reported mapping is verified as tunnel-owned, add only
the narrowest working subnet to `ssrf.allowRanges` in the reported
`web-search.json` path, for example:

```json
{
  "ssrf": {
    "allowRanges": ["100.64.1.0/24"]
  }
}
```

Do not exempt the complete `100.64.0.0/10` range. SF Pi reports this condition
and guidance but never changes third-party security configuration automatically.

## File Structure

<!-- GENERATED:file-structure:start -->

```
extensions/sf-pi-manager/
  lib/                        ← implementation modules
  tests/                      ← Behavior Proofs and test fixtures
  index.ts                    ← Pi extension entry point
  manifest.json               ← source-of-truth extension metadata
  README.md                   ← human behavior and usage
```

<!-- GENERATED:file-structure:end -->
