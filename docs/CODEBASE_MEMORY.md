# Astel Social Engine — Codebase Memory

**Snapshot version:** `v2026.09.15`  
**Last verified:** 2026-09-15  
**Repository:** `asteloleh-gif/threads-bot`  
**Canonical production canary:** `astel.us`

This file is the shared engineering context for ChatGPT, Codex, Claude, and future maintainers. Read it before making architectural or production changes. `AGENT_LOG.md` remains the append-only implementation history; this file is the current-state snapshot.

## 1. Product boundary

Astel Social Engine is an owner-operated social copilot for Oleg's own accounts/pages. It is **not** a SaaS/Tech Provider product for managing third-party customer accounts.

Target runtime:

```text
Owned Threads / Instagram / Facebook accounts
        ↓
Meta webhooks and/or official polling fallback
        ↓
Provider adapters
        ↓
Safety Pipeline
self guard / dedupe / cooldown / rate limits / idempotency / human lock
        ↓
AI reply generation
        ↓
Official Meta reply mutation
        ↓
PostgreSQL durable state + Redis hot state
```

Do not route this project toward Advanced Access, Tech Provider onboarding, third-party account management, or Business Verification unless a concrete Meta requirement for the owner's own assets makes it unavoidable.

## 2. Current repository baseline

Latest verified `main` code baseline before this documentation snapshot:

- Commit: `541deb559ee12e0f2c15a28cffb5fbb397984d14`
- PR: `#55` — Threads reply publishing contract collision fix.
- Regression: **208/208 tests pass** on the astel.us Railway deployment built 2026-09-15.
- Production start command: `node server-meta-runtime.js`.
- Node/npm build observed in Railway: Node `24.20.0`, npm `11.19.0`.

Critical fix in #55: `ThreadsProvider.publishReply(parentId, text)` had been overwritten by the adapter's internal `publishReply(creationId)` during `Object.assign`. That caused source comment IDs to be passed directly to `/threads_publish` and produced Meta `400 code 24 / Media Builder Not Found`. The public reply contract is now explicitly preserved and regression-tested.

## 3. Railway production topology

### astel.us — canary / reference deployment

Railway project: `astel-us`  
App service: `copilot-astel-us`  
Dependencies: dedicated Redis + dedicated PostgreSQL.

Latest verified deployment after Airtable variables were added:

- Deployment: `7c587f0d-3a99-4e15-a8f7-b7216d2c2a0e`
- Status: **SUCCESS**
- Railway `/health`: succeeded on first check.
- Startup: PostgreSQL connected, Redis safety connected, Threads token manager connected.
- Threads: enabled, live replies (`threadsDryRun=false`).
- Instagram: provider present; comment polling starts successfully, but current media scan returns `media=0`; reply mutations remain dry-run.
- Facebook: provider present; reply mutations remain dry-run.
- Publish Engine: disabled + dry-run.
- Content Pipeline: disabled.
- Hyper Crew: disabled.
- Content Control API: disabled.
- Analytics: disabled in astel.us current runtime.
- Proactive Copilot: disabled.

### Other social deployments

- `leoakastel`: main-line social copilot deployment follows the shared engine. #55 code deployed, but a fresh post-fix external live reply has not yet been independently confirmed.
- `astel.u`: RU deployment remains on its separate `ru-bot` history and is intentionally **not yet promoted to the #55 canary baseline**. Do not port/promote until astel.us passes the release gate below.

Standalone Telegram bots and the owner assistant are separate products/services and must not be merged into the Social Engine runtime merely for convenience.

## 4. Verified astel.us Threads state

Threads production is live end-to-end on astel.us.

Verified 2026-09-15:

- inbound external comment reached the engine;
- AI generated a reply successfully;
- official two-step Threads reply container flow completed;
- published reply ID returned;
- self-authored loop guard observed on own comments;
- #55 removed the publish contract collision that previously caused Meta code 24.

This is the canary that future changes must pass before promotion to other account deployments.

## 5. Instagram and Facebook state

### Instagram comments

Implemented:

- `InstagramProvider` and adapter;
- Instagram Login compatibility using `graph.instagram.com`;
- unified Meta webhook parser support;
- official comment polling fallback;
- account isolation and safety pipeline integration;
- token/config present in astel.us runtime;
- polling process starts successfully.

Not yet proven:

- real Development-mode comment webhook delivery for the target account;
- actual comment discovery from media while the API currently returns no visible media;
- first controlled live Instagram reply.

Keep Instagram mutation dry-run until those gates are satisfied.

### Facebook comments

Provider/configuration exists and the target Page subscription was previously configured, but a fresh real Page comment → engine → reply live gate is still pending. Keep Facebook mutation dry-run until that is proven.

### Instagram DMs

Specification exists separately; DM implementation is not yet part of the current runtime.

## 6. Airtable knowledge and security layer

Three Airtable bases are maintained for the three social deployments:

1. `Astel US — Social Copilot`
2. `Leo Akastel — Threads Comment Bot`
3. `Leo Akastel — Threads RU Bot`

Each now contains/uses these logical tables:

- `Comments`
- `KnowledgeBase`
- `BotSettings`
- `RedTeamTests`

Security state as of 2026-09-15:

- 35 red-team regression cases stored in `RedTeamTests`.
- Raw attack payloads are intentionally isolated from runtime knowledge context.
- 9 defensive security rules are active in `KnowledgeBase` covering prompt leakage, credentials, fake authority/urgency, prompt injection, persona integrity, memory poisoning, excessive agency/tools, off-scope handling, and anti-amplification.
- `RED_TEAM_SUITE_V1` is recorded in `BotSettings`.
- astel.us live smoke tests `1.2` (debug/raw config) and `8.1` (fake Meta support asking for an access token) passed.

The astel.us Railway service now has both `AIRTABLE_API_KEY` and `AIRTABLE_BASE_ID` variable names configured and the deployment is healthy. The runtime `getContext()` function reads only `{Active}=TRUE()` records from `KnowledgeBase` / `Knowledge Base`.

**Evidence boundary:** variable presence + healthy deployment prove configuration was applied. They do **not** by themselves prove a successful live Airtable read on a reply. The next controlled astel.us reply should be used to verify that the active KB is actually consumed at runtime.

Never put access tokens or secret values into this repository, `AGENT_LOG.md`, or Codebase Memory.

## 7. Red-team release gate

Release order is intentionally:

```text
astel.us canary
→ security regression suite
→ controlled E2E verification
→ PASS
→ separately promote leoakastel
→ separately promote astel.u
```

Do not blast all 35 attack prompts into production. Run the majority through a test/dry-run handler and keep only a small set of representative live smoke tests.

## 8. Runtime data ownership

- **Redis = hot safety/state:** locks, leases, cooldowns, dedupe, polling state, token refresh state, human lock.
- **PostgreSQL = durable application state:** comments/replies, publish runs, analytics snapshots, content workflow, agent telemetry and approvals.
- **Airtable = human-editable knowledge/security configuration:** active KB entries, test catalog, settings. It is not the primary durable event store.
- **Meta = external source/mutation boundary:** use official APIs only.

Do not replace Railway Postgres/Redis with Supabase just because Supabase is connected to Codex. A backend migration requires an explicit architectural decision.

## 9. Developer tooling / connectors

Current developer context as of 2026-09-15:

- GitHub: source of truth for code, PRs, commits and project docs.
- Railway: production truth for deployments, environment variable names, runtime logs and health.
- Airtable: knowledge/security/configuration layer.
- Context7: connected for Codex; use it for current library/API documentation instead of relying on stale SDK memory.
- Supabase: connected in Codex; organization exists, **no projects**. Do not introduce it into runtime without a deliberate migration decision.
- Vercel: connected in Codex; no usable project command surface discovered at this checkpoint. Production remains Railway.
- PostHog: connected to ChatGPT as an available observability/product-analytics tool, but the Astel Social Engine is **not yet instrumented/configured in PostHog**. Treat future instrumentation as a separate observability block.

Preferred workflow:

```text
Product intent from owner
→ shared context from this file + AGENT_LOG
→ current docs via Context7 when needed
→ code change in GitHub/Codex
→ tests/CI
→ astel.us canary deployment on Railway
→ logs + health + controlled external verification
→ update AGENT_LOG and this snapshot when the baseline materially changes
```

## 10. Safety / architectural invariants

Do not bypass these without an explicit owner decision:

- official Meta APIs only for production social mutations;
- self-reply guard and bot-generated-object guard;
- dedupe/cooldown/rate-limit/idempotency controls;
- branch-scoped conversation memory isolation;
- fail-closed behavior when Redis/Postgres safety state is required and unavailable;
- no hidden auto-publishing from Content Pipeline / Hyper Crew;
- human approval remains a hard gate for content publishing workflows;
- raw red-team payloads must never be loaded as trusted KnowledgeBase context;
- secrets never enter Git, Airtable knowledge text, logs, or project-memory docs.

## 11. Known backlog / unresolved gates

1. Verify live astel.us reply generation actually consumes the active Airtable KB after the 2026-09-15 configuration deployment.
2. Run the full 35-case red-team regression mostly in test/dry-run and record failures before any promotion.
3. Resolve Instagram comment ingress / media visibility and prove first controlled live comment reply.
4. Prove Facebook Page real comment ingress/reply.
5. Implement Instagram DM only after comment path is stable.
6. Promote #55/current baseline to leoakastel and astel.u separately after canary gate; do not mass-cutover.
7. `npm audit` currently reports 2 moderate vulnerabilities; handle as dependency-security backlog, not by blind `npm audit fix` in production.
8. PostHog observability can be added later if it materially reduces debugging effort; do not add telemetry merely because the connector exists.

## 12. Next engineering action

**Immediate next gate:** generate one controlled astel.us Threads interaction whose answer should depend on an Active Airtable `KnowledgeBase` record, then verify the runtime behavior/logs without exposing secrets. If that passes, proceed to the red-team regression gate.

---

# Codebase Memory MCP tooling appendix

The repository includes bootstrap scripts for `DeusData/codebase-memory-mcp`, used as developer memory / code intelligence for coding agents. It is deliberately separate from application runtime memory and must not be deployed to Railway.

It indexes the repository into a persistent local knowledge graph so coding agents can query architecture, symbols, call chains, dependencies, HTTP routes, impact of changes, and related code without repeatedly scanning the whole repository.

Supported setup includes Claude Code and Codex CLI, with:

- `auto_index = true`
- `auto_watch = true`
- `watcher_enabled = true`

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\setup-codebase-memory.ps1
```

Existing install:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\setup-codebase-memory.ps1 -SkipInstall
```

### macOS / Linux

```bash
bash ./tools/setup-codebase-memory.sh
```

Existing install:

```bash
bash ./tools/setup-codebase-memory.sh --skip-install
```

After setup, restart Claude Code and/or Codex, run `/mcp`, and verify `codebase-memory-mcp` is available. Codex may require explicit hook trust/review through `/hooks`.

Optional graph UI:

```text
codebase-memory-mcp --ui=true --port=9749
```

The bootstrap source remains pinned to the reviewed Codebase Memory commit already recorded in repository history. Do not place application tokens, Meta credentials, OpenAI keys, Airtable keys, database credentials, or Railway secrets into MCP configuration.