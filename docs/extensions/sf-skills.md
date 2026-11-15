---
title: "SF Skills"
description: "Manage skills through one Skill Funnel: catalog every source (Claude/Codex/Cursor/custom/managed) → gate sources → toggle skills per scope (global/project) → resolve name conflicts, compiled to native skills.customDirectories with exact-file projections. Toggle managed-library invocation via disable-model-invocation stamps on an effective tree. Plus a passive live-context HUD, forcedotcom/sf-skills install, per-skill usage counters, and prune. OMP owns MCP configuration and readiness."
editLink: false
---

# SF Skills

<p class="sfpi-page-lead">Manage skills through one Skill Funnel: catalog every source (Claude/Codex/Cursor/custom/managed) → gate sources → toggle skills per scope (global/project) → resolve name conflicts, compiled to native skills.customDirectories with exact-file projections. Toggle managed-library invocation via disable-model-invocation stamps on an effective tree. Plus a passive live-context HUD, forcedotcom/sf-skills install, per-skill usage counters, and prune. OMP owns MCP configuration and readiness.</p>

## What it does

Skills manager built on the Skill Funnel: a five-tab view (Catalog / Sources / Global / Project / Conflicts) over one resolved Skill Catalog. Source Gate decides which roots OMP sees; Skill Gate toggles individual skills at global and project scope; Skill Conflict Resolution picks a winner by exclusion. Wiring compiles to native YAML skills.customDirectories with exact-file projections. Managed-library prompt visibility is stamped as disable-model-invocation on an isolated effective tree so the git clone stays pullable. OMP owns MCP configuration, connections, and readiness. SF Skills retains a passive live-context HUD, forcedotcom/sf-skills install, per-skill usage counters, and prune.

## Start

Open the extension from its primary command:

```text
/sf-skills
```

Open its Manager detail or change its package state with:

```text
/sf-pi open sf-skills
/sf-pi enable sf-skills
/sf-pi disable sf-skills
```

## Exact reference

<details>
<summary>Show commands, tools, providers, and hooks</summary>

- **Extension id:** `sf-skills`
- **Intent:** Personalize pi
- **Category:** UI
- **Maturity:** stable
- **Default state:** on
- **Commands:** `/sf-skills`
- **LLM tools:** _none_
- **Providers:** _none_
- **Events/hooks:** `session_start`, `message_end`, `session_tree`, `session_compact`, `before_agent_start`, `session_shutdown`

</details>

## For contributors

- [Full extension README](https://github.com/alexander-vyh/sf-omp/blob/main/extensions/sf-skills/README.md)
- [Source folder](https://github.com/alexander-vyh/sf-omp/tree/main/extensions/sf-skills)

## Troubleshooting

See the [Troubleshooting section in the full README](https://github.com/alexander-vyh/sf-omp/blob/main/extensions/sf-skills/README.md#troubleshooting) for extension-specific recovery steps.
