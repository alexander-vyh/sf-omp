# Agent Script eval

Use `agentscript_eval`. Return to [`../AGENT_GUIDE.md`](../AGENT_GUIDE.md) for the preferred loop.

Use `/sf-agentscript evals` for the local-first Agent Script Eval Studio. Opening it reads repository EvalSpec JSON and `.pi/state/sf-agentscript/runs` evidence only; Salesforce is contacted after an explicit Run Target or Release Contract action. Studio execution requires projectable Scenarios, while `agentscript_eval action="run"` and `/sf-agentscript eval <spec>` preserve permissive raw EvalSpec compatibility.

A Studio Run reviews the run-local org and exact version target before execution, then persists immutable source/executed snapshots. Suite and Scenario Runs are supported, but Scenario, Ad Hoc, Legacy, Incomplete, and Unverified Runs cannot satisfy release evidence. The Conversation tab shows response-integrity counts for each observed turn and expands the selected turn's complete parsed LLM response sequence; detailed legacy reads reconstruct sequence evidence from `raw.json` when it wasn't persisted in older transcripts. Closing the overlay does not cancel a Run; use the explicit cancellation action. `R` refreshes Suite files, and reopening shows current background progress.

New Suite, New Scenario, Edit, and Diagnose actions create a compact authoring brief in Pi's editor. They do not add a second source format or edit JSON inside the overlay. Reopen the Studio manually after the conversational edit completes.

Use `generate_spec` to bootstrap a starter regression spec from a `.agent` file. Use `run` with `agent_api_name` so the runner resolves/injects Active BotVersion ids safely by default.

The runner resolves org identity, version IDs, and seed SOQL with the normal org connection. If an Evaluation API batch returns HTTP 401, it retries that rejected batch once with a shared Agentforce named-user JWT. Non-401 failures remain unchanged; a second 401 is incomplete evidence, never a green run. This auth fallback is independent of the project REST API version.

Use EvalSpec `seed_profiles` when scenarios need org-specific IDs or state. Each profile runs one read-only SOQL query against the selected eval org, requires exactly one row, and maps scalar fields/constants into the existing `context_variables` shape. Scenarios reference one profile with `seed_profile`; reused profiles execute once per Run. Resolution is preflight-only and fails closed before Run creation/API POST for unsafe queries, missing/ambiguous rows, null fields, type mismatches, duplicate IDs, or unknown profiles. Do not select arbitrary customer data—query dedicated test fixtures through stable predicates.

A designated release Suite can provide `generated_baseline.default_seed_profile`, exact test-id `overrides`, and `skip_tests` when a generated one-turn probe is replaced by designated multi-turn coverage. `run_release` copies only referenced profile declarations into the regenerated baseline before pinning the exact pending BotVersion. Dynamic seed values appear only in restricted executed/raw artifacts and are masked on human-facing Studio/report surfaces.

For long or exploratory local runs, pass `batch_timeout_ms` to cap each Evaluation API batch POST. The default remains 300000ms, and client-side timeouts are not retried. Non-2xx batches produce Infrastructure Failed execution plus Incomplete evidence and persist full details in `batch-failures.json`; never accept a green run whose returned test count is lower than the executed spec. During a run, inspect `.pi/state/sf-agentscript/runs/<run_id>/status.json` for atomic phase and batch progress. `manifest.json` owns immutable start identity; `metadata.json` owns the terminal recorded verdict.

`generate_spec` uses an internal stateful scenario compiler. `include_multi_turn_tests` defaults to true and generates same-session turn sequences only when `after_response` updates and a matching source branch are statically provable. Exact state checkpoints use live-supported string or numeric evaluators; dynamic updates appear in `skipped_multi_turn` rather than being guessed. Generated specs also include connected-agent invocation probes, subagent routing, and targeted action probes. Voice agents additionally receive concise greeting and distressed-caller scenarios by default; pass `include_voice_tests=false` only when a designated suite supplies equivalent coverage. These response rubrics remain behavioral evidence, while strict one-response-per-turn integrity stays the deterministic Voice release gate.

Eval runs synthesize trace artifacts from inline Evaluation API data by default. Eval does not expose `RelatedAgentStep`; connected-agent call counts are therefore unavailable, not zero and not inferred from LLM events. Use `agentscript_preview` for authoritative connected-call telemetry, and use `agentscript_eval action="trace"` only when you explicitly need a live planner trace and have a known resident `session_id`/`plan_id`.

Each paired `send_message` and `get_state` turn persists a complete parsed `response_sequence` from `lastExecution.llmEvents` in transcript, failure, and synthesized-trace artifacts. It retains every raw response event and tool name without copying full prompt bodies. Strict router/system-safety telemetry aliases—identical raw prompt/response, same start time, and end time within 1 ms—are marked and counted once as a physical completion while raw and physical counts remain visible. Never deduplicate on response text alone; sequential repeats remain separate and fail strict integrity. Missing `get_state` evidence is `unavailable`, never a passing zero. `raw.json` remains the authoritative untouched API response.

Eval run output aggregates response integrity as a pass/warning/unavailable summary plus exact repeated-surface counts. Completed runs render a bounded Conversation Replay with the full user/agent exchange, per-turn agent path, latency, and integrity proof; expanded cards show all bounded turns. Failure cards show every parsed completion for each failed turn. Integrity is advisory unless the Suite declares `sf_pi.turn_response_integrity`. `severity: "warning"` preserves the server verdict; `severity: "error"` makes excess non-empty completions or exact surface repetition Failed and unavailable evidence Incomplete. Strict policy requires exactly one `agent.get_state` after each `agent.send_message` and fails preflight before org calls or Run creation when that proof is missing. Generated Voice suites declare strict one-response-per-turn integrity automatically; a Voice exact-version release refuses a designated Suite that omits the same strict policy. The source-only policy is preserved in Suite/Scenario snapshots, generated baselines, and release digests but is never sent as an Evaluation API step.

Use `$latest_*` placeholders or `version_resolution="latest"` only for the publish → eval → activate loop, and pass `acknowledge_inactive_version=true` when deliberately testing a non-Active version.

Use `get_failure` after large runs. If exactly one failed completed run exists on the current branch, `run_id` may be omitted; otherwise pass it explicitly.

## Platform guard outcomes

Salesforce trust-layer interceptions are detected from `Inappropriate_Content*`
markers in the turn's `planner_response.lastExecution.topic` or LLM-event
`agent_name` / `prompt_name` metadata. Mentioning a marker in user, prompt, or
response text is not evidence. Markers belong only to their own scenario.

A blocked, single-turn curated safety, regulated-advice, or guardrail probe
passes as a safe refusal and carries `platform_guard: {category}`. Missing
evaluators, evaluator errors, duplicate results, and unrelated step errors
still fail closed as Incomplete evidence. A block does not prove a multi-turn
workflow succeeded.

Functional rows receive the distinct `platform_guard` verdict, not an agent
failure. `test_platform_guard` and `ev_platform_guard` count blocked functional
coverage separately. By default this verdict cannot satisfy a release gate.
To explicitly allow platform-blocked functional coverage, set the Suite's
extension-owned policy:

```json
{
  "sf_pi": {
    "platform_guard": { "functional": "allow" }
  }
}
```

Omit the policy or use `"functional": "fail_closed"` for the default. Allowing
guards changes only the aggregate release verdict; scenario evidence retains
`platform_guard`. Other failures, incomplete evidence, and strict response
integrity requirements remain effective.

Reports label the platform cause and category. `evidence.json` and
`failures.jsonl` retain the annotation (including passed safe-refusal records);
transcript entries identify guarded turns. `raw.json` remains untouched so the
server's original score and response can always be inspected.

## Writing stable assertions

Test observable behavior, not a preferred sentence. A designated Suite should
survive harmless paraphrasing without weakening its action, safety, or state
requirements. Prefer deterministic evidence wherever it is available:

- **Actions and routing:** assert the action name in
  `lastExecution.invokedActions` or the topic in `lastExecution.topic`. Check
  forbidden actions against the observed invocation list, not a promise in the
  response.
- **Connected agents:** use `agentscript_preview` connected-call telemetry.
  Evaluation API response text does not prove a connected agent was called.
- **Citations and links:** check that a citation/link exists, then parse each
  URL and compare its hostname with an explicit allowlist (for example,
  `docs.example.com`). A substring match also accepts deceptive hosts such as
  `docs.example.com.invalid`; do not use one as a host check.
- **No record created:** verify the scoped fixture's resulting records or
  authoritative action outcome. A response saying nothing was created, or a
  missing action name alone, is not proof of an unchanged org.
- **Refusal category and state:** compare structured categories or state
  variables when the source and runtime expose them. Otherwise judge the
  semantic refusal, not a stock apology.

For example, these EvalSpec step fragments check an observed action and a
source-declared state value after `state1`, without judging response wording:

```json
[
  {
    "type": "evaluator.list_assertion",
    "id": "policy_lookup_invoked",
    "actual": "{state1.response.planner_response.lastExecution.invokedActions}",
    "expected": ["lookup_policy"],
    "operator": "contains"
  },
  {
    "type": "evaluator.string_assertion",
    "id": "request_status",
    "actual": "{state1.response.planner_response.sessionContext.stateVariables.request_status}",
    "expected": "needs_review",
    "operator": "equals"
  }
]
```

Use LLM rubrics for semantic properties that cannot be checked from structured
evidence. Keep the behavior strict while allowing equivalent wording:

| Brittle wording requirement         | Stable behavioral rubric                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| Responds with "Here is your source" | Cites a source page supporting the answer.                                     |
| Says "I did not create a ticket"    | Does not claim to have created a ticket and explains the missing prerequisite. |
| Includes "I cannot help with that"  | Declines the unsupported request and redirects to the supported domain.        |

`generate_spec` already uses deterministic action, subagent-topic, and provable
state checkpoints; it does not infer citation schemas, allowed hosts, record
outcomes, or refusal fields from descriptions. Supply authoritative evidence
checks in the designated workflow when those properties matter; do not invent
Evaluation API evaluator types or treat unavailable telemetry as a passing
zero. Generated semantic rubrics permit paraphrases, including when a
state-activated source instruction contains example wording.

Generation reports advisory `summary.rubric_warnings` for response rubrics
containing quoted phrases or `responds with`. Review these findings rather
than automatically stripping quotes: literal data may be intentional, but
usually belongs in a deterministic assertion. The lint neither rewrites the
spec nor changes a run verdict.
