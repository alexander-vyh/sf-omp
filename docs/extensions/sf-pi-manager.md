---
title: "SF Pi Manager"
description: "Core manager — provides /sf-pi commands"
editLink: false
---

# SF Pi Manager

<p class="sfpi-page-lead">Core manager — provides /sf-pi commands</p>

## What it does

Core manager for the sf-pi package on OMP. Provides /sf-pi list/enable/disable/status/display/recommended/announcements/skills/doctor/auto-update commands plus the interactive TUI overlay and settings panel. The OMP runtime is the native omp on PATH and stays with omp update. Opt-in Auto Update waits for a non-aborted terminal agent_end (settled turn), fast-forwards the sf-omp git checkout (git pull --ff-only + npm ci, only when cleanly behind its upstream), and runs the independent Salesforce CLI stable update. /sf-pi recommended reports recommended packages as unsupported because the launcher loads extensions explicit-only. alwaysActive: enable/disable is mediated through this extension only; it is stored as native disabledExtensions in OMP YAML config and applies on the next OMP start.

## Start

Open the extension from its primary command:

```text
/sf-pi
```

## Safety notes

- Owns the WRITE side of OMP's disabledExtensions for bundled extensions via lib/common/omp-extension-state.ts.
- Auto Update is opt-in, interactive-session only, deferred after aborted settlements, machine-locked, abortable, and output-redacted; it never updates the OMP runtime.
- Checkout automation only fast-forwards a clean, attached branch strictly behind its upstream; dirty, detached, ahead, diverged, and upstream-less checkouts are left untouched, and no package or plugin installer runs.
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
