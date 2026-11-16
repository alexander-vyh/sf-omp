---
title: "SF Pi Manager"
description: "Core manager — provides /sf-pi commands"
editLink: false
---

# SF Pi Manager

<p class="sfpi-page-lead">Core manager — provides /sf-pi commands</p>

## What it does

Core manager for the sf-pi package. Provides /sf-pi list/enable/disable/status/display/recommended/announcements/skills/doctor/auto-update commands plus the interactive TUI overlay and settings panel. Doctor includes a bounded, read-only synthetic-DNS compatibility check for the recommended pi-web-access package without changing third-party security configuration. Pi runtime updates remain user-managed, with newer stable 1.x releases loading in forward-compatibility mode. Opt-in Auto Update waits for a non-aborted terminal agent_end (settled turn), updates only declared-compatible unpinned global npm Pi packages through Pi, and runs the independent Salesforce CLI stable update. Under OMP it instead fast-forwards the sf-omp git checkout (git pull --ff-only + npm ci, only when cleanly behind its upstream) and reports recommended Pi packages as unsupported because the launcher loads extensions explicit-only. alwaysActive: enable/disable is mediated through this extension only; under OMP it is stored as native disabledExtensions in OMP YAML config and applies on the next OMP start.

## Start

Open the extension from its primary command:

```text
/sf-pi
```

## Safety notes

- Owns the WRITE side of pi's package filter list via lib/common/sf-pi-package-state.ts.
- Auto Update is opt-in, interactive-session only, deferred after aborted settlements, machine-locked, abortable, and output-redacted; it never performs an unbounded Pi self-update.
- Recommended-package compatibility diagnostics are explicit-command, bounded, and read-only; they never weaken or rewrite third-party security settings.
- Package automation is limited to outdated unpinned global npm packages with declared active Pi/Node compatibility; pinned, local, git, project, incompatible, and unverifiable packages are skipped.
- On OMP, checkout automation only fast-forwards a clean, attached branch strictly behind its upstream; dirty, detached, ahead, diverged, and upstream-less checkouts are left untouched, and no pi or plugin installer runs.
- alwaysActive cannot be disabled through the standard toggle action.

## Exact reference

<details>
<summary>Show commands, tools, providers, and hooks</summary>

- **Extension id:** `sf-pi-manager`
- **Intent:** Personalize pi
- **Category:** Manager
- **Maturity:** stable
- **Default state:** always-on
- **Commands:** `/sf-pi`
- **LLM tools:** _none_
- **Providers:** _none_
- **Events/hooks:** `session_start`, `agent_start`, `agent_end`, `session_switch`, `session_tree`, `session_shutdown`

</details>

## For contributors

- [Full extension README](https://github.com/alexander-vyh/sf-omp/blob/main/extensions/sf-pi-manager/README.md)
- [Source folder](https://github.com/alexander-vyh/sf-omp/tree/main/extensions/sf-pi-manager)

## Troubleshooting

See the [Troubleshooting section in the full README](https://github.com/alexander-vyh/sf-omp/blob/main/extensions/sf-pi-manager/README.md#troubleshooting) for extension-specific recovery steps.
