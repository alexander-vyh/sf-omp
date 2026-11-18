# Agent Script diagnostic parity

This file records the released-package boundary between official Agent Script
diagnostics and SF Pi's local **Agent Script Hardening Adapter** and native
quality catalog. Keep it synchronized with:

- `tests/diagnostic-parity.test.ts` for hardening diagnostics;
- `tests/quality-upstream-parity.test.ts` for all 20 quality rules.

## Evidence baseline

Fixture evidence was refreshed on 2026-11-17 against these exact installed
packages:

| Package                               |   Version |
| ------------------------------------- | --------: |
| `@sf-agentscript/agentforce`          |  `2.16.5` |
| `@sf-agentscript/language`            |  `3.15.1` |
| `@sf-agentscript/lsp`                 | `2.11.26` |
| `@sf-agentscript/agentscript-dialect` |  `3.24.3` |
| `@sf-agentscript/agentforce-dialect`  |  `2.88.3` |
| `@sf-agentscript/compiler`            |  `3.38.4` |
| `@sf-agentscript/agentfabric-dialect` |  `1.5.16` |

The snapshot tests compare execution context, diagnostic code, source, severity,
complete range, message, data, multiplicity, suggestions, and quick fixes.
Similar names or shared helper functions are not parity.

### Released-package upgrade evidence

`agentfabric-dialect@1.5.16` natively requires `language@3.15.1` and
`agentscript-dialect@3.24.3`. The old nested overrides are removed; `npm ls`
resolves a single deduplicated language version without invalid or extraneous
entries.

The upstream [Agentforce changelog](https://github.com/salesforce/agentscript/blob/main/packages/agentforce/CHANGELOG.md),
[language changelog](https://github.com/salesforce/agentscript/blob/main/packages/language/CHANGELOG.md),
and [LSP changelog](https://github.com/salesforce/agentscript/blob/main/packages/lsp/CHANGELOG.md)
were checked, along with both dialect changelogs. Their newest entries are older
than the previous package baseline, and the npm tarballs omit changelogs.
Therefore they cannot establish this upgrade's diagnostic or schema changes.
The evidence below comes from comparing the old/new published `src/` files and
rerunning the complete diagnostic fixtures, not inferring current behavior from
those historical notes:

- `agentscript-dialect/src/lint/passes/action-io.ts` now treats only explicitly
  `is_required: True` inputs without defaults as required. `action-missing-input`
  is **not renamed**: it disappears from unannotated planner-input fixtures but
  remains informational for explicitly required planner inputs. Both cases are
  covered separately; unknown planner input/type codes remain unchanged.
- `compiler/src/nodes/compile-run-inputs.ts` adds uncoded deterministic-run
  diagnostics: ellipsis slot filling is an error, and an omitted required input
  is a warning. These are adjacent to local policy, not strict parity: code,
  complete range, data, and (for slot filling) severity differ. Preserve the
  official compile error even when local policy is disabled.
- Official `unused-variable` data now includes a structured `target`.
  `instruction-template-syntax` now supplies `data.replacement` and an official
  preferred replacement quick fix. The existing upstream projection and
  code-action adapter consume these without a second evaluator.
- `agentforce-dialect/src/schema.ts` specializes top-level actions and adds
  orchestrator/workflow blocks, live configuration, context search, service-agent
  billing, action cache/async settings, and reasoning-action execution mode. Connection
  system instructions now support procedural conditionals; response-format
  schema examples use `messaging_component://` and `lightning_web_component://`.
  The lazy SDK adapter derives its types from upstream and needs no shadow
  schema migration. Existing GoalBasedAgent/workflow/connection proofs and the
  direct LSP hover/definition/reference provider smoke cover the consumer seam.

No diagnostic-code rename was observed in the retained parity fixtures. The
changed omission semantics and richer quick-fix payloads are recorded in their
full snapshots rather than hidden by normalizing away differences.

## Parity tiers

- **Strict parity**: the official diagnostic covers the same construct in the
  same execution context, with equivalent code mapping, range, severity/risk,
  message/actionability, data, and quick-fix behavior.
- **Adjacent only**: the fixture produces an official diagnostic, but for a
  different construct, execution context, risk, or repair. It cannot authorize
  deletion.
- **SF Pi-owned**: the fixture produces no equivalent official diagnostic.

Only strict parity permits deleting a local evaluator. A released package
upgrade requires rerunning the fixtures before changing a decision.

## Current hardening diagnostics

| SF Pi diagnostic            | Official fixture evidence                                                | Tier          | Decision                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------- |
| `apex-target-method-suffix` | none                                                                     | SF Pi-owned   | Retain Salesforce target hygiene.                                                                         |
| `target-ref-looks-like-id`  | none                                                                     | SF Pi-owned   | Retain stable API-name guidance.                                                                          |
| `inputs-out-of-scope`       | an uncoded cascade on the fixture; it does not identify the scope misuse | Adjacent only | Retain the exact deterministic-action misuse check; allow official connection instruction-template scope. |
| `outputs-out-of-scope`      | none                                                                     | SF Pi-owned   | Retain exact `@outputs` callback-scope diagnostic.                                                        |

## Current quality catalog

| SF Pi quality rule                          | Official fixture evidence                                 | Tier          | Decision                                                                                                                 |
| ------------------------------------------- | --------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `unconditional-transition-cycle`            | none                                                      | SF Pi-owned   | Retain local graph analysis.                                                                                             |
| `slot-filling-in-deterministic-action`      | uncoded deterministic compiler error on the ellipsis      | Adjacent only | Retain stable High policy identity; official error has different severity, range, and data and remains compile-blocking. |
| `deterministic-action-missing-input`        | uncoded deterministic compiler warning on the action ref  | Adjacent only | Retain stable High policy identity and complete-run range; planner omission now requires explicit `is_required: True`.   |
| `deterministic-action-unknown-input`        | uncoded missing-required-input warning, not unknown input | Adjacent only | Retain. Official `action-unknown-input` still applies to planner-selected action bindings, not this execution context.   |
| `action-chain-too-deep`                     | none                                                      | SF Pi-owned   | Retain local chain-depth contract.                                                                                       |
| `variable-description-max-length`           | none                                                      | SF Pi-owned   | Retain the local High guard for the Salesforce publication limit.                                                        |
| `unreachable-subagent`                      | none                                                      | SF Pi-owned   | Retain component-graph reachability. Official `unreachable-code` is statement-level and not parity.                      |
| `unused-action`                             | none                                                      | SF Pi-owned   | Retain scoped action-use analysis. Official `unused-variable` is a different declaration kind.                           |
| `discarded-prompt-before-transition`        | none                                                      | SF Pi-owned   | Retain prompt-before-transition analysis. Official `unreachable-code` examines statements after a terminal transition.   |
| `list-element-type-mismatch`                | none on the representative mixed-list default fixture     | SF Pi-owned   | Retain element-level type and range evidence. Official `variable-default-type-mismatch` no longer fires here.            |
| `non-numeric-list-index`                    | none                                                      | SF Pi-owned   | Retain statically known list-index analysis.                                                                             |
| `slot-filled-variable-missing-description`  | `unused-variable` on the declaration, with a removal fix  | Adjacent only | Retain slot-filling description guidance; removing the variable is not an equivalent repair.                             |
| `deterministic-action-input-type-mismatch`  | none for deterministic `run`                              | SF Pi-owned   | Retain. Official type checks use similar inference only for planner action bindings.                                     |
| `deterministic-action-output-type-mismatch` | none for deterministic `run`                              | SF Pi-owned   | Retain. Official type checks do not cover this deterministic callback fixture.                                           |
| `instruction-template-syntax`               | exact official `instruction-template-syntax` diagnostic   | Strict parity | Reuse the official diagnostic as a Moderate quality projection; maintain no local evaluator.                             |
| `prompt-template-output-flags`              | none                                                      | SF Pi-owned   | Retain planner/display guidance.                                                                                         |
| `action-before-transition`                  | none                                                      | SF Pi-owned   | Retain cost/side-effect advisory before a transition.                                                                    |
| `conditional-transition-cycle`              | none                                                      | SF Pi-owned   | Retain conditional graph evidence.                                                                                       |
| `subagent-delegation-cycle`                 | none                                                      | SF Pi-owned   | Retain returning-delegation graph evidence.                                                                              |
| `cyclomatic-complexity`                     | none                                                      | SF Pi-owned   | Retain report-only per-procedure metric.                                                                                 |

**Current result:** zero local evaluators meet strict parity at this package
baseline, so zero local evaluators are deleted. The new deterministic compiler
checks are adjacent evidence, not permission to erase stable policy identities
or hide official compile errors. Instruction-template syntax remains a projection
of its strict-parity official diagnostic and has no local evaluator.

Disabling a local quality rule still disables only its policy projection. The
quality parity suite proves that an adjacent official compiler diagnostic, when
present, remains visible.

## Completed historical handoffs

Earlier work already removed duplicated evaluators where released official
behavior became authoritative, including official unused-variable handling,
object action I/O diagnostics, instruction-template syntax, and ignored Employee
Agent default user configuration. The former Employee-Agent messaging/escalation
blocks were also removed: the official Agent Script Utils reference documents an
active Omni-Channel connection as the escalation prerequisite and does not impose
an agent-type restriction, while the installed compiler accepts both
`@utils.escalate` and deterministic `escalate` for Employee Agents. Instruction-template
syntax is now projected into quality from the official diagnostic rather than
reimplemented. Those completed handoffs are not evidence for deleting any current
local evaluator; applicable fixtures remain as regression coverage.

Official escalation references:

- https://developer.salesforce.com/docs/ai/agentforce/guide/ascript-ref-utils.html
- https://developer.salesforce.com/docs/ai/agentforce/guide/ascript-blocks.html

## Deletion rule

Do not delete a local diagnostic or quality evaluator because an official pass
has a similar name or imports the same type-inference helper. Delete only after
a current released-package fixture proves strict parity and public quality,
review, edit-time, and publication behavior remains intact.
