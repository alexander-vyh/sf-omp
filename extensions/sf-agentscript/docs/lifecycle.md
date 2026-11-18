# Agent Script lifecycle

Use `agentscript_lifecycle`. Return to [`../AGENT_GUIDE.md`](../AGENT_GUIDE.md) for the preferred loop. For Service Agent user wiring details, read [`agent-user-setup.md`](./agent-user-setup.md).

Use `publish` to create an inactive agent/version. Native quality runs before org calls. New enabled High rule IDs or a quality-analysis failure pause publication and return evidence; retry with `acknowledge_quality_risk=true` only after user approval. Approval is session-scoped to the bundle and reviewed risk IDs. If High or Moderate recommendations remain after publication, the result advises resolving them before activation.

After publication, run `agentscript_eval action="run_release"` with the local `agent_file` and `agent_api_name`, or use the Studio Release Contract tab. It generates and runs the baseline against the exact latest inactive BotVersion, then runs `tests/agentforce/<AgentApiName>.eval.json` when present (or `release_spec_path`). `activate` proceeds only when schema-version-3 Suite evidence is Passed and matches the target org, exact BotVersion, current baseline identity, current designated-spec digest, and current dependency fingerprint. Release lookup uses an exact-identity index, revalidates terminal status/snapshots/raw evidence, and rebuilds from Run manifests when needed; recent-index eviction cannot expire evidence.

Release runs record the mutable targets invoked by the local Agent Script and resolve Flow subflows and supported Flow actions transitively, to depth five:

- **Prompt templates:** Metadata API `GenAiPromptTemplate` active version identifier and SHA-256 of that version's content. Reusing an identifier does not hide content edits; prompt content itself is not persisted in the fingerprint.
- **Flows:** active version ID and version number, including subflows.
- **Apex:** class ID, last-modified timestamp, and SHA-256 of the class body.

Activation resolves these dependencies again. A changed, missing, or unreadable dependency blocks activation and returns a named dependency diff. Cycles and traversal beyond depth five fail closed. Legacy schema-version-2 runs remain readable in Eval Studio, but activation reports **no dependency fingerprint, rerun required**. The Studio Release Contract tab shows recorded dependency versions and hashes; displaying them never performs live validation.

Rerun `run_release` after dependency changes. Emergency activation requires `acknowledge_untested_activation=true` and a distinct Guardrail approval; the same explicit override applies to stale dependency evidence and is reported as an untested activation.

Use `agent_user_status`, `diagnose_agent_user`, and `provision_agent_user` for Service Agent user wiring. Provision defaults to `dry_run=true`; pass `dry_run=false` only after reviewing the plan. Live provisioning deploys a synthesized Permission Set for Apex action access with bounded Metadata API start/poll timeouts so stalled deploys return diagnostics instead of waiting on SDR's long default poll window.

Do not infer activation/deactivation targets from branch state. Pass `agent_api_name` explicitly for `activate`, `deactivate`, and `list_versions`. If a connected helper cannot deactivate because it is in use, deactivate dependent parent agents first, confirm their versions are Inactive, then retry after status propagation.
