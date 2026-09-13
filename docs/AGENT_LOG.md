# AGENT_LOG

Shared handoff log for ChatGPT, Claude, and future maintainers working on Astel Social Engine.

## Logging rule

After every closed implementation block or merged PR, append a new entry to the end of this file. Do not rewrite older entries except to correct a factual error.

Use this format:

```md
## YYYY-MM-DD — Block X.Y — <name>

**Status:** DONE / IN PROGRESS / BLOCKED

**Done:**
- item

**Commits/PRs:** #NN (main), #NN (ru-bot)

**Regression:** N/N tests pass

**Changed files/services:** short summary only

**Open questions / external verification:**
- explicitly list anything that still needs external verification
```

Never put access tokens, secrets, passwords, private connection strings, or other credentials in this file.

---

## 2026-09-13 — Block 0 — Architecture Shell

**Status:** DONE

**Done:**
- Added account configuration boundary, SocialProvider contract, account-scoped ProviderRegistry, ThreadsProvider compatibility wrapper, and application composition root.
- Preserved existing Threads Reply Engine behavior and safety pipeline.
- Ported the exact tested architecture tree to `ru-bot` without merging divergent history.

**Commits/PRs:** #22 (main), #23 (ru-bot)

**Regression:** 77/77 tests pass

**Changed files/services:** `app/accounts/*`, `app/providers/*`, `app/composition/*`, architecture tests, minimal `server.js` integration; EN/RU Railway deploys.

**Open questions / external verification:**
- None for Block 0.

---

## 2026-09-13 — Block 1 — Meta Provider Layer and Unified Cutover

**Status:** DONE

**Done:**
- Pinned deterministic Node/npm build path and lockfile.
- Added InstagramProvider and FacebookProvider with normalized SocialEvent and fail-closed reply mutation semantics.
- Added unified Meta webhook router and account-scoped multi-platform composition.
- Added unified `server-meta.js` production entrypoint while preserving legacy rollback via `server.js`.
- Instagram/Facebook remain disabled/dry-run until real Meta assets, permissions, tokens, webhook subscriptions, App Review/Business Verification and Live-mode requirements are completed.

**Commits/PRs:** #24/#25 (build reproducibility), #26/#27 (Instagram), #28/#29 (Facebook), #30/#31 (Meta router), #32/#33 (production cutover)

**Regression:** 107/107 tests pass at Block 1 closure

**Changed files/services:** Meta adapters/providers, normalized event layer, webhook router, account config, community runtime, `server-meta.js`, EN/RU Railway app services.

**Open questions / external verification:**
- Meta onboarding remains externally blocked/paused: IG/FB asset IDs, permissions, tokens, webhook subscriptions, Live mode and verification are not yet active.
- Do not set IG/FB dry-run off until real webhook traffic is verified account-by-account.

---

## 2026-09-13 — Block 2 — Fail-Safe Publish Engine / Scheduler

**Status:** DONE

**Done:**
- Added platform-neutral publish job model, Redis-backed scheduler/queue, dedupe, claims and leases.
- Added fail-safe `AMBIGUOUS_HOLD`; unknown external publish outcomes are never blindly retried.
- Added official two-step Threads text publishing flow.
- Kept production publishing disabled and dry-run by default.

**Commits/PRs:** #34 (main), #35 (ru-bot)

**Regression:** 116/116 tests pass

**Changed files/services:** `app/publishing/*`, `adapters/threadsPostPublisher.js`, Threads provider capability wiring, `server-meta.js`, EN/RU Railway deployments.

**Open questions / external verification:**
- `PUBLISH_ENGINE_ENABLED=false` and `PUBLISH_ENGINE_DRY_RUN=true` remain intentional production defaults until a controlled live publishing test is approved.

---

## 2026-09-13 — Block 3 — PostgreSQL Durable Data Layer

**Status:** DONE

**Done:**
- Added persistent PostgreSQL durable store and migrations.
- Added durable schema/repositories for brands, social accounts, posts, drafts, publish runs, comments, replies, analytics snapshots, content briefs, agent runs, experiments and approvals.
- Kept Redis as HOT state for locks/leases/cooldowns/dedupe/queues; PostgreSQL is DURABLE state.
- Added durable Meta event and publish projections without storing credentials.
- Provisioned separate persistent PostgreSQL services for EN and RU.
- Set `DATABASE_REQUIRED=true` in production.

**Commits/PRs:** #36 (main), #37 (ru-bot)

**Regression:** 121/121 tests pass

**Changed files/services:** `app/db/*`, `db/migrations/001_core.sql`, durable publish wrapper, `server-meta.js`, EN Postgres, RU Postgres.

**Open questions / external verification:**
- None blocking Block 4. Runtime/startup fail-closed behavior was subsequently hardened and explicitly tested in the pre-Block 4 entry below.

---

## 2026-09-13 — Pre-Block 4 — Railway and PostgreSQL Hardening

**Status:** DONE

**Done:**
- Added explicit regression coverage for required Postgres startup failure and runtime pool failure.
- Confirmed startup failure is fatal/fail-closed and runtime pool failure marks the DB unhealthy.
- Added repository-owned Railway service policy/runbook instead of relying on deprecated `railway.json` behavior.
- Explicitly aligned EN/RU app services to pre-deploy `npm test`, `/health`, 30s health timeout, `ON_FAILURE`, max retries 3.
- Confirmed EN and RU production deploys succeeded with identical hardening tree.
- Staged deletion of obsolete `threads-bot-LdTD` and `verify-threads-bot` services.

**Commits/PRs:** #38 (main); exact tested tree ported to `ru-bot`

**Regression:** 123/123 tests pass

**Changed files/services:** `docs/railway-hardening.md`, `infra/railway-service-policy.json`, `tests/postgresDataLayer.test.js`, EN/RU Railway app config.

**Open questions / external verification:**
- Deletion of `threads-bot-LdTD` and `verify-threads-bot` is staged but requires manual Railway 2FA Apply from the dashboard.
- `npm audit` reported 2 moderate vulnerabilities; backlog, not a Block 4 blocker.
- RU still supports the legacy typo `THREDS_ACCESS_TOKEN` intentionally for backward compatibility.

---

## 2026-09-13 — Block 4 — Analytics Engine

**Status:** DONE

**Done:**
- Added read-only Threads account insights, post insights, and recent-post discovery behind the provider capability boundary.
- Added normalized metrics, derived interactions/engagement rate, and per-entity snapshot deltas/rates.
- Persisted account/post analytics snapshots and discovered posts in PostgreSQL using the existing durable layer.
- Added a capability-driven analytics scheduler with account/post failure isolation and `/health` visibility.
- Enabled production analytics on a 6-hour interval with 25-post/30-day bounds; Publish Engine remains disabled/dry-run and analytics performs no Meta mutations.
- EN live gate passed: 1 account snapshot, 17 recent posts, 17 post snapshots, 0 failures.
- RU live gate passed: 1 account snapshot, 14 recent posts, 14 post snapshots, 0 failures.
- Instagram/Facebook insights remain capability-disabled until their real Meta assets/permissions/tokens are onboarded and verified.

**Commits/PRs:** #39 (main), #40 (ru-bot)

**Regression:** 129/129 tests pass

**Changed files/services:** `adapters/threadsInsightsAdapter.js`, `app/analytics/*`, `app/providers/threadsProvider.js`, `server-meta.js`, `.env.example`, Block 4 docs/tests; EN/RU Railway analytics runtime variables.

**Open questions / external verification:**
- Instagram/Facebook Meta onboarding remains pending; their analytics capabilities must not be enabled until live permissions/assets are verified.
- Deletion of obsolete EN Railway services `threads-bot-LdTD` and `verify-threads-bot` remains staged pending manual 2FA Apply.
- `npm audit` still reports 2 moderate vulnerabilities in the dependency tree; backlog, not a Block 5 blocker.

---

## 2026-09-13 — Block 5A — Approval-gated Content Workflow Core

**Status:** DONE

**Done:**
- Added a durable content workflow repository over the existing `content_briefs`, `drafts`, and `approvals` PostgreSQL tables.
- Added the core `Research/Brief → Draft → Review → Human Approval → Schedule` state machine.
- Enforced confirmed human approval before a draft can enter the existing Publish Engine; scheduling uses a draft-scoped dedupe key and records approval provenance.
- Added fail-closed repository behavior and regression coverage for PASS/REVISE/REJECT, human approval/rejection, and exactly-once enqueue intent.
- Kept runtime behavior unchanged: no new HTTP/admin route, no autonomous content run, no new Meta mutation, and production Publish Engine flags remain disabled/dry-run.
- Ported the exact tested main tree to `ru-bot` without merging divergent histories; EN and RU Railway deployments both succeeded.
- Confirmed the previously obsolete EN Railway services are now deleted; only the app, Redis, and Postgres remain in the EN production project.

**Commits/PRs:** #41 (main); exact tested tree port commit `527436e77a8c9bb37f24fd9fbcdd991b68ac5467` (`ru-bot`)

**Regression:** 137/137 tests pass

**Changed files/services:** `app/content/contentRepository.js`, `app/content/contentPipeline.js`, `tests/contentPipeline.test.js`; EN/RU Railway app deployments.

**Open questions / external verification:**
- Runtime composition/admin boundary for the Content Pipeline is intentionally deferred to the next Block 5 slice.
- `PUBLISH_ENGINE_ENABLED=false` and dry-run protections remain intentional; Block 5A introduced no real scheduled or external publish.
- `astel.us` Meta asset/webhook onboarding remains externally pending and will resume through the authenticated Meta DevTools MCP/Codex audit.
- `npm audit` still reports 2 moderate vulnerabilities in the dependency tree; backlog, not a Block 5 blocker.
