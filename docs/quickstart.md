---
title: SF Pi Quickstart
description: First commands to verify SF Pi and discover the bundled Salesforce runtime surfaces.
---

# SF Pi Quickstart

After installing SF Pi, use these commands to confirm the package is loaded and
to discover the surfaces available in your current OMP session.

## 1. Open the manager

```text
/sf-pi
```

Use the manager to list bundled extensions, enable or disable optional surfaces,
open configuration panels, review recommended-package coverage, and run doctor
checks.

## 2. Check Salesforce context

```text
/sf-org
```

This shows the Salesforce CLI target org information that SF Pi will use for
org-aware workflows. If no org is connected, authenticate with the Salesforce
CLI outside OMP, then restart OMP.

## 3. Inspect the dev status surfaces

```text
/sf-devbar
/sf-lsp
```

`/sf-devbar` explains the status bar and footer state. `/sf-lsp` shows advisory
Apex, LWC, and Agent Script diagnostic status.

## 4. Try the Salesforce-aware tools

Choose the surface that matches your task:

| Task                                      | Start here          |
| ----------------------------------------- | ------------------- |
| Build or test `.agent` files              | `/sf-agentscript`   |
| Work with Data Cloud / Data 360           | `/sf-data360`       |
| Use Salesforce UI as a last-mile fallback | `/sf-browser`       |
| Search Slack from OMP                     | `/sf-slack`         |
| Explore Salesforce data read-only         | `/sf-data-explorer` |
| Review safety gates                       | `/sf-guardrail`     |
| Manage Salesforce skills                  | `/sf-skills`        |

## 5. Start a focused session

OMP's `--tools` takes a comma-separated list of exact built-in or extension
tool names, so a session can expose only the Salesforce tools needed for the
current task. It does not accept `*` patterns. These profiles use OMP's native
tool selection and do not create SF Pi settings or a second exposure model.

```bash
# Agent Script
/path/to/sf-omp/tools/bin/omp --tools read,bash,edit,write,agentscript_authoring,agentscript_preview,agentscript_eval,agentscript_lifecycle

# Data 360
/path/to/sf-omp/tools/bin/omp --tools read,bash,edit,write,sf_data360
```

Each extension page in [Bundled Extensions](./extensions.md) lists its exact
tool names.

## 6. Use generated references

- [Bundled Extensions](./extensions.md) shows every extension and runtime surface.
- [Command Reference](./commands.md) lists every slash command.
- [Troubleshooting](./troubleshooting.md) points to common recovery paths.

## Recommended first session

```text
/sf-pi status
/sf-org
/sf-devbar
/sf-guardrail
/sf-pi doctor
```

Then pick the extension that matches the work in front of you.
