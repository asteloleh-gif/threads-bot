# Block 4 — Meta analytics API references

Verified against Meta's official Postman workspaces on 2026-09-13.

## Threads

Read-only endpoints used by Block 4:

- `GET /me/threads` — recent authenticated-user Threads media objects.
- `GET /{thread_id}/insights?metric=...` — post insights.
- `GET /me/threads_insights?metric=...` — account insights.

Default post metrics requested: `views,likes,replies,reposts,quotes,shares`.

Default account metrics requested: `views,likes,replies,reposts,quotes,followers_count`.

The runtime treats unavailable/unsupported metrics as account/post-scoped failures rather than a reason to mutate or retry external state.

## Instagram / Facebook

Provider analytics capabilities remain disabled until real assets and permissions are onboarded and verified. No unverified production metric contract is enabled in Block 4.
