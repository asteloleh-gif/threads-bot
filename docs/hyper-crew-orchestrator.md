# Hyper Crew Orchestrator — Block 6

Block 6 adds a multi-agent coordination layer **above** the existing Content Runtime. It does not replace the AI Gateway, Content Pipeline, human approval gate, Publish Engine, Meta providers, or their safety controls.

## Block 6A — Orchestrator Shell

The first graph is intentionally small:

```text
Research Agent / supplied research
        ↓
Content Strategist
        ↓
Copywriter
        ↓
Content Reviewer
        ↓
HUMAN APPROVAL  ← hard stop
```

The concrete runtime mapping is:

- Research: supplied research/evidence enters the run. No external mutation.
- Content Strategist: delegates to `ContentRuntime.generateBrief()` and therefore reuses the shared AI Gateway, model router, token/cost budgets, and durable AI telemetry.
- Copywriter: delegates to `ContentRuntime.generateDraft()`.
- Content Reviewer: delegates to `ContentRuntime.reviewDraft()`.
- Human Approval: a non-autonomous hard gate. Hyper Crew 6A stops with `AWAITING_HUMAN_APPROVAL`.

Hyper Crew 6A has **no method that automatically approves a draft, schedules it, or publishes it**. Those actions remain behind the Block 5 approval/control/publishing boundaries.

## Runtime gate

```text
HYPER_CREW_ENABLED=false
```

This is the production default. Enabling Hyper Crew requires Content Runtime to already be enabled and ready plus durable PostgreSQL state to be ready. Startup otherwise fails closed.

Enabling Hyper Crew by itself does not enable Content Runtime, Content Control, Publish Engine, or Meta mutations.

## Durable correlation

Every crew run receives a `crewRunId`. After the strategist creates the durable brief, the orchestrator correlates itself with the Content Runtime `workflowId` and persists the orchestrator state into the existing `agent_runs` table.

The orchestrator telemetry stores stage status only; it does not duplicate full generated content or credentials.

AI model calls continue to be recorded by the shared AI Gateway, so Block 6 does not introduce a second model client, budget counter, or AI telemetry system.

## Safety invariants

Block 6 must preserve all of these invariants:

1. No agent node owns an external social mutation.
2. Human approval is not an agent and cannot be autonomous.
3. Hyper Crew never calls Meta directly.
4. Hyper Crew never bypasses `ContentRuntime` to call an LLM directly.
5. Hyper Crew never bypasses the shared AI budget manager.
6. Hyper Crew 6A never calls `decideApproval()` or `scheduleApprovedDraft()`.
7. Production remains safe with:
   - `HYPER_CREW_ENABLED=false`
   - `CONTENT_PIPELINE_ENABLED=false`
   - `CONTENT_CONTROL_API_ENABLED=false`
   - `PUBLISH_ENGINE_ENABLED=false`
   - `PUBLISH_ENGINE_DRY_RUN=true`
   - `CONTENT_ALLOW_LIVE_SCHEDULING=false`

## Health visibility

`/health` exposes `hyperCrew` state. When disabled, Hyper Crew is healthy-but-skipped and performs no orchestration or durable writes.

If enabled while Content Runtime is unavailable, startup fails rather than silently degrading into a partially active agent system.

## Next Block 6 slices

After 6A is stable:

- **6B — Research Agent / Tool Boundary:** source adapters, evidence normalization, provenance, freshness and source-policy checks.
- **6C — Agent Registry + Task Router:** explicit agent contracts, bounded delegation, task/result envelopes and retry policy.
- **6D — Workflow State / Resume:** durable orchestration checkpoints and safe resume after process restart.
- **6E — Human Approval Resume:** consume an already-confirmed Block 5 approval and continue through the existing scheduler; never self-approve.
- **6F — Experiments / Optimization:** Analytics → hypothesis → controlled content variants using the existing `experiments` and analytics data, still approval-gated.

The later Hyper Crew team can expand with Trend Sniper, SMM adaptation, designer/visual, lead and analytics agents, but those capabilities must attach through explicit tool boundaries rather than gaining unrestricted access to providers or credentials.
