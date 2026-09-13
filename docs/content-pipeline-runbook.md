# Block 5 Content Pipeline — Operator Runbook

This runbook covers the approval-gated Content Pipeline and the Block 5E end-to-end **dry-run** path.

## Production safety posture

Production must remain fail-closed while Block 5 is being verified:

- `CONTENT_PIPELINE_ENABLED=false`
- `CONTENT_CONTROL_API_ENABLED=false`
- `PUBLISH_ENGINE_ENABLED=false`
- `PUBLISH_ENGINE_DRY_RUN=true`
- `CONTENT_ALLOW_LIVE_SCHEDULING=false`

Do not change these production gates to run the Block 5E regression suite. CI uses injected/in-memory boundaries and performs no Meta mutation.

The private Content Control API is mounted only when `CONTENT_CONTROL_API_ENABLED=true`. It is not a public API and requires a Bearer secret of at least 32 bytes. Never put that secret in URLs, request bodies, logs, docs, or source control.

## Block 5 workflow

The complete workflow is:

```text
Research input
  → AI Brief
  → AI Draft
  → AI Review
  → Human Approval
  → Scheduler
  → Publish Engine dry-run
  → SIMULATED
```

AI review `PASS` is not human approval. A named human reviewer must explicitly submit `APPROVED` before scheduling is possible.

## Safe end-to-end dry-run requirements

The end-to-end runner refuses to start unless:

1. Content Runtime is enabled and ready in the isolated operator/test environment.
2. Publish Engine is enabled in that isolated environment.
3. Publish Engine is still `dryRun=true`.
4. The caller supplies an explicit human `APPROVED` decision and reviewer name.
5. The private Content Control API is authenticated when the HTTP operator path is used.

The runner schedules one workflow-specific job and then targets that exact job for simulation. It deliberately does **not** call a generic scheduler tick, so unrelated queued jobs cannot be processed by the E2E operation.

If Publish Engine is live (`dryRun=false`), the E2E operation fails before any content workflow operation executes.

## Private operator API

Base path when explicitly enabled:

```text
/internal/content
```

All routes require:

```text
Authorization: Bearer <CONTENT_CONTROL_API_TOKEN>
```

All mutation routes also require:

```text
Idempotency-Key: <unique-machine-safe-key>
```

### Read-side

Read operations do not require an idempotency key:

```text
GET /internal/content/status
GET /internal/content/briefs/:briefId
GET /internal/content/drafts/:draftId
GET /internal/content/drafts/:draftId/workflow
```

The workflow read joins the durable brief, draft, latest human approval, and current publish job state. It is read-only and does not call Meta.

### Step-by-step mutation path

```text
POST /internal/content/briefs/generate
POST /internal/content/briefs/:briefId/drafts/generate
POST /internal/content/drafts/:draftId/review
POST /internal/content/drafts/:draftId/approval
POST /internal/content/drafts/:draftId/schedule
```

Each mutation is idempotent through the Redis-backed control operation store.

### One-shot end-to-end dry-run

```text
POST /internal/content/dry-runs
```

Example body shape:

```json
{
  "accountKey": "account:threads",
  "objective": "Teach one supported idea",
  "research": [
    { "fact": "operator-supplied fact", "source": "operator-supplied source" }
  ],
  "language": "en",
  "humanApproval": {
    "decision": "APPROVED",
    "reviewer": "operator-name"
  }
}
```

A successful response ends with `status: "simulated"` and exposes the stage trace plus a workflow snapshot. The publish job must end in `SIMULATED`, never `PUBLISHED`.

## Verification checklist

Before calling Block 5 closed, verify:

- CI passes the full regression suite.
- E2E trace contains: `research`, `aiBrief`, `aiDraft`, `aiReview`, `humanApproval`, `scheduler`, `simulatedPublish`.
- AI review result is `PASS` before human approval.
- Human approval is `APPROVED` and records reviewer identity.
- Draft ends in `SCHEDULED`.
- Publish job ends in `SIMULATED`.
- Provider `publishPost` is never invoked by the E2E dry-run regression.
- Reusing the same control-plane idempotency key replays the stored result instead of running the workflow twice.
- Operator workflow reads can reconstruct brief → draft → approval → publish state.
- EN and RU production safety gates remain unchanged and disabled as listed above.
- No Meta mutation is performed as part of Block 5E validation.

## Failure handling

- AI budget/client/output failure: stop at the current AI stage; do not continue to approval or scheduling.
- AI review `REVISE` or `REJECT`: stop before human approval/scheduling.
- Missing/negative human approval: do not schedule.
- Publish Engine disabled: scheduling/E2E dry-run refuses to proceed.
- Publish Engine not in dry-run: E2E runner refuses to proceed before workflow execution.
- Idempotency operation stuck/in-progress: return conflict/fail closed; never blindly repeat the mutation.
- Simulation state commit failure: treat as ambiguous/failure; never fall through to a real provider call.

## Transition to Block 6

Block 5 is complete only after the dry-run path, operator read-side, CI, EN/RU deployment gates, documentation, and exact-tree parity are verified. Block 6 Hyper Crew Orchestrator should consume the Content Runtime through these existing boundaries instead of bypassing human approval, idempotency, budgets, or Publish Engine safety gates.
