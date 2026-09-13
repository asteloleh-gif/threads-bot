# Block 4 — Analytics Engine

## Scope

Block 4 adds a read-only analytics plane above the existing provider and durable-storage layers.

Flow:

`Provider Insights API -> normalized metrics -> Postgres analytics_snapshots -> deltas/rates -> future Strategist/Hyper Crew`

## Safety model

- Analytics performs GET/read operations only.
- It does not publish posts, comments, replies, DMs, or any other Meta mutation.
- Failures are isolated per account and per post; one failed metric request does not stop other accounts/posts.
- Tokens are sent in Authorization headers and are never written to analytics snapshots or health output.
- The engine is disabled by default with `ANALYTICS_ENGINE_ENABLED=false`.
- Analytics failures do not make the real-time Community Engine unhealthy; required Postgres health remains authoritative through the existing database gate.

## Initial provider support

Threads is the first live analytics provider because its API contract is already available in production. It supports:

- account insights;
- post insights;
- recent-post discovery for analytics backfill.

Instagram/Facebook keep `capabilities.insights=false` until their real Meta assets, permissions and tokens are onboarded and verified. The analytics engine is capability-driven, so they can be added without changing orchestration.

## Normalized metrics

Provider metrics remain available by their stable names. The normalization layer also derives:

- `interactions` from available likes/replies/comments/reposts/quotes/shares/saves;
- `engagement_rate = interactions / views` (or impressions/reach fallback) when a denominator exists;
- per-snapshot deltas;
- relative rates versus the immediately previous snapshot for the same account/entity.

## Production defaults

- interval: 6 hours;
- recent posts per account: 25;
- lookback: 30 days.

These values are runtime-configurable through `ANALYTICS_*` environment variables.
