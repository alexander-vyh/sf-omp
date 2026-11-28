---
title: "SF Welcome"
description: "Salesforce-branded splash screen with environment status, SF Pi release freshness, and community info"
editLink: false
---

# SF Welcome

<p class="sfpi-page-lead">Salesforce-branded splash screen with environment status, SF Pi release freshness, and community info</p>

## What it does

Non-blocking startup header with model/environment status, cache-only dedicated-compaction readiness, one-line LSP readiness, optional gateway usage, SF Pi package freshness, announcements, skill sources, and recent sessions. OMP itself updates with omp update. SF_PI_SAFE_START=1 keeps the non-blocking header for recovery launches; /sf-welcome and /sf-setup-fonts remain available on demand.

## Start

Open the extension from its primary command:

```text
/sf-welcome
```

Open its Manager detail or change its package state with:

```text
/sf-pi open sf-welcome
/sf-pi enable sf-welcome
/sf-pi disable sf-welcome
```

## Exact reference

<details>
<summary>Show commands, tools, providers, and hooks</summary>

- **Extension id:** `sf-welcome`
- **Intent:** Personalize pi
- **Category:** UI
- **Maturity:** stable
- **Default state:** on
- **Commands:** `/sf-welcome`, `/sf-setup-fonts`
- **LLM tools:** _none_
- **Providers:** _none_
- **Events/hooks:** `session_start`, `agent_start`, `tool_call`, `session_shutdown`

</details>

## For contributors

- [Full extension README](https://github.com/alexander-vyh/sf-omp/blob/main/extensions/sf-welcome/README.md)
- [Source folder](https://github.com/alexander-vyh/sf-omp/tree/main/extensions/sf-welcome)

## Troubleshooting

See the [Troubleshooting section in the full README](https://github.com/alexander-vyh/sf-omp/blob/main/extensions/sf-welcome/README.md#troubleshooting) for extension-specific recovery steps.
