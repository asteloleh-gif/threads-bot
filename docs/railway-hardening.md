# Railway hardening policy

This document is the source-of-truth runbook for Astel Social Engine app services on Railway.

## Required service settings

Apply `infra/railway-service-policy.json` to every production app service (`threads-bot`, `threads-bot-ru`, and future brand/account copies):

- Pre-deploy command: `npm test`
- Healthcheck path: `/health`
- Healthcheck timeout: `30s`
- Restart policy: `ON_FAILURE`
- Maximum restart retries: `3`

Required dependency posture:

- `DATABASE_REQUIRED=true`
- `REDIS_REQUIRED=true`
- Publishing starts fail-safe: `PUBLISH_ENGINE_ENABLED=false`
- Publishing starts in dry-run: `PUBLISH_ENGINE_DRY_RUN=true`

## Why this is repository-owned policy instead of railway.json

Railway's legacy Config as Code (`railway.json` / `railway.toml`) is deprecated. New services cannot opt into it, and existing Config as Code stops being read after 2026-12-01. Do not introduce a new legacy `railway.json` as the portability mechanism for this project.

Railway Infrastructure as Code (`.railway/railway.ts`) is project-scoped. This repository currently deploys into two independent Railway projects with different service names and existing database/cache resources, so migration to full project-level IaC must be planned and applied per project rather than silently introduced by an application deploy.

Until full project IaC owns both Railway projects, the canonical portable contract is `infra/railway-service-policy.json`, applied through Railway service configuration/API/agent when a service is created or cloned.

## Clone / migration gate

A newly created app service is NOT ready for production until all of the following are true:

1. Source branch is correct for the account/brand.
2. `npm test` is configured as the pre-deploy command.
3. `/health` is configured as the deployment healthcheck with a 30 second timeout.
4. Restart policy is `ON_FAILURE`, max retries `3`.
5. `DATABASE_URL` and `REDIS_URL` point to the intended sibling services.
6. `DATABASE_REQUIRED=true` and `REDIS_REQUIRED=true`.
7. Publishing and proactive mutations remain disabled during first boot.
8. A deployment reaches healthy only after Redis and required Postgres are connected.

## Failure semantics

Required Postgres failure at startup is fail-closed: startup must reject and the process must exit non-zero rather than listening without durable storage.

If the Postgres pool emits an error after a successful startup, the durable store marks itself disconnected. `/health` includes the database state and must return HTTP 503 while a required database is disconnected.

Railway's deployment healthcheck is a deploy-time gate, not continuous runtime monitoring. Runtime outage monitoring should therefore be handled separately from this deployment gate.

## Audit checklist

When auditing Railway, compare the live app-service settings against `infra/railway-service-policy.json`. Any divergence in healthcheck, restart policy, dependency requirements, or mutation defaults is a release blocker for a newly created service.
