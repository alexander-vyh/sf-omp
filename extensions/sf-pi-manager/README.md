# SF Pi Manager

## What It Does

SF Pi Manager is the package home base. `/sf-pi` lets users browse extensions,
open human-facing detail pages, edit low-risk settings, run diagnostics, review
recommended-package coverage and external skill roots, and enable or disable
bundled extensions through OMP's native `disabledExtensions` config.

The Manager is always active.

### Enable/disable

OMP's native switch is `disabledExtensions` in OMP YAML config.
`/sf-pi enable|disable`, `enable-all|disable-all`, the Manager list toggles, and
every extension's "Disable this extension" action write `extension-module:<id>`
entries there:

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

In the OMP terminal, the Manager opens as an overlay. Use the arrow keys to
move, Enter to open an extension or action, and Esc to go back. PageUp and
PageDown scroll long settings pages without changing a field's value. While
editing a field, Home and End move its caret.

## Configuration

Manager-owned settings include extension enablement, shared display profile,
announcements state, doctor repairs, and opt-in Native Auto Update. Project
settings override global settings where a surface supports both scopes.

Native Auto Update is off by default. When enabled, due work waits for a
non-aborted, terminal `agent_end` (OMP marks retry, compaction, and follow-up
ends with `willContinue`), then for the host to be idle; it uses an atomic
machine lock and handles the sf-omp checkout and Salesforce CLI targets
independently. It never updates OMP itself.

### Updates

sf-omp is a git checkout launched through the native `omp` on PATH, so Auto
Update (and `/sf-pi auto-update run`) runs no package or plugin installer:

1. OMP itself is left to `omp update`.
2. sf-omp checkout: `git fetch` the branch's upstream and count ahead/behind.
   Only a clean, attached branch that is strictly behind is updated, with
   `git pull --ff-only` followed by `npm ci`; dirty, detached, ahead, diverged,
   upstream-less, and unreachable checkouts are reported and left untouched.
3. `sf update stable` for the Salesforce CLI.

A successful pull recommends restarting OMP. The same consent, settled-turn,
idle, lock, and abort rules apply.

### Recommended packages

Recommended packages cannot run under sf-omp: the launcher starts OMP
explicit-only (`--no-extensions -e <checkout>`), a mode in which OMP loads
neither Pi packages nor plugins installed with `omp plugin install`.
`/sf-pi recommended` and `recommended status` list every item as unsupported with
that reason and the OMP-native or bundled capability that covers it (for
example OMP's web search/fetch tools for `pi-web-access`); `recommended install|remove` are refused without
running any installer, and the startup recommendations nudge is suppressed.

## Safety and Data Boundaries

- Only SF Pi Manager writes bundled `extension-module:<id>` entries in OMP's
  `disabledExtensions`.
- Native Auto Update is opt-in, interactive-only, abortable, output-redacted,
  and bounded to fast-forwarding a cleanly-behind sf-omp checkout plus the
  Salesforce CLI step.
- Dirty, detached, ahead, diverged, and upstream-less checkouts are reported
  rather than rewritten.
- `/sf-pi doctor fix` performs only named safe repairs after confirmation and
  quarantines duplicate skills instead of deleting them.
- Extensions marked `alwaysActive` cannot be disabled through the standard
  toggle path.

## Troubleshooting

**SF Pi commands are missing:** Start OMP through the sf-omp launcher
(`<checkout>/tools/bin/omp`). It loads this checkout explicit-only; the plain
native `omp` binary, `pi install`, and `omp plugin install` do not load SF Pi.

**A toggle does not take effect:** Restart OMP; enablement is read when
extensions load.

**The host runtime looks wrong:** Run `/sf-pi doctor runtime` to see the OMP
and Node.js details SF Pi detected. Update OMP itself with `omp update`.

**Auto Update did not update the checkout:** Run `/sf-pi auto-update status`.
The status names why the checkout was not updated (for example local changes,
a detached HEAD, or a diverged branch).

**Auto Update waits for a settled turn:** This is expected. An aborted turn,
new turn, reload, shutdown, or settings change cancels or defers pending
automatic work.

**Project changes do not stick:** Project extension state lives in
`<cwd>/.omp/config.yml`, and its `disabledExtensions` list replaces the global
one. Pass the intended scope explicitly when changing extension state.

**Announcements or skill roots look stale:** Announcements and skill-source
decisions are revision/state based. Use their Manager pages and `/sf-pi doctor`
before editing state files manually.

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
