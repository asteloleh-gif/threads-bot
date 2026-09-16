# Instagram `astel.us` live runbook — verified 2026-09-16

This document records the route that actually produced a real Instagram reply from `astel.us` in production. It is intentionally operational: it separates what worked from the dead ends, and it does not contain access-token, App Secret, verify-token, API-key, or database-secret values.

## Final verified state

Meta App: `Astel US Social Engine` (`1991615571550659`)

Instagram Professional account: `astel.us` (`17841473220032439`)

Linked Facebook Page: `Олег Акастелов` (`656083597578810`)

Railway service: `copilot-astel-us`

Production callback: `https://copilot-astel-us-production.up.railway.app/webhook`

Runtime auth mode: `facebook_login`

Production ingress for owned-account v1: **official Instagram Graph reads through polling**, not real comment webhooks.

Production reply path: **official Graph API** `POST /{comment-id}/replies` with Bearer auth.

Live canary on 2026-09-16:

- inbound comment ID: `18093487196449257`
- AI call: HTTP 200
- published reply ID: `18105338471192490`
- next poll saw the bot's own reply and returned `SELF_COMMENT`
- following poll found no additional event

Therefore the verified production path is:

```text
owned astel.us Reel
  -> Instagram polling
  -> normalized SocialEvent
  -> conversation routing / safety
  -> Airtable KB
  -> GPT
  -> official Meta reply mutation
  -> published reply ID
  -> self-comment guard
  -> no loop
```

## Why polling is the production ingress for v1

The Meta App is still in Development mode. App-level `Instagram -> comments` webhook configuration exists and the callback/HMAC path is valid, but Meta's real comment delivery is not available to this app in its current state. Dashboard Test webhooks reach Railway, while a real external Instagram comment does not produce a real webhook POST.

For the current use case — an owner-managed account — polling already gives a complete official-API route and does not require us to make App Review / Advanced Access / Business Verification a release blocker.

Real webhooks remain a future platform/client milestone. Do not remove the webhook implementation; simply do not treat it as the v1 ingress dependency.

## The connection route that finally worked

### 1. Use the Facebook Login Graph flow

The working adapter mode is:

```text
INSTAGRAM_AUTH_MODE=facebook_login
```

In this mode the adapter uses `graph.facebook.com`, resolves the Facebook-linked Instagram account, and uses a Page Access Token for Instagram identity/media/comment/reply operations.

Do not mix this flow conceptually with the Instagram Login `business_*` flow. The repository still supports both modes, but `astel.us` production is on `facebook_login`.

### 2. Preserve exact account identity

The critical identity pair is:

```text
INSTAGRAM_USERNAME=astel.us
INSTAGRAM_USER_ID=17841473220032439
```

The Instagram API ID exposed through the Facebook-linked Page can differ from IDs seen in other Meta surfaces. Do not use:

- the Meta App ID as an Instagram user ID;
- an internal Business Manager asset ID as the Graph Instagram user ID;
- a guessed ID copied from an unrelated dashboard field.

The startup identity probe must resolve the linked account and verify the username before the runtime is trusted.

Verified production diagnostic:

```text
Instagram identity probe
status=ok
idMatch=true
usernameMatch=true
resolution=configured_page_token
pageTokenFallbackAttempted=true
pageTokenFallbackHasInstagram=true
```

### 3. Use the linked Facebook Page token fallback

`app/accounts/accountConfig.js` supplies the private Instagram linked-Page credential from:

```text
INSTAGRAM_FACEBOOK_PAGE_ACCESS_TOKEN || FACEBOOK_ACCESS_TOKEN
```

The final `astel.us` deployment uses the configured Facebook Page token fallback. The adapter:

1. tries the normal Facebook Login resolution path;
2. if that path cannot discover the Page, tries the already configured Page token;
3. calls the Page identity edge and obtains `instagram_business_account`;
4. checks that the linked Instagram username is actually `astel.us`;
5. caches the Page token + resolved IG ID only in memory;
6. uses that credential for media reads, comment reads, and replies.

Important: the old `INSTAGRAM_ACCESS_TOKEN` later proved expired, but the runtime kept working because the Page-token fallback was the credential actually used for `astel.us`. For a clean future onboarding, use a valid Facebook Login credential and a valid Page credential rather than depending on an expired primary token to fall through.

Never log or document token values.

### 4. Make sure the test media is actually owned by `astel.us`

One confusing blocker was media ownership. A collaborator/co-author post can be visible in the Instagram UI while not appearing as owned media under `/{ig-user-id}/media`.

The decisive test was a fresh Reel published directly by `astel.us` as the original owner, without Collab. After that, the API exposed the media and polling could read its comments.

For onboarding/debugging, always start with a fresh owned post/Reel before blaming permissions or code.

### 5. Keep the polling fallback enabled

The production-safe poller was introduced in PR #52. The important environment controls are:

```text
INSTAGRAM_ENABLED=true
INSTAGRAM_POLLING_ENABLED=true
INSTAGRAM_DRY_RUN=true   # until the canary step
INSTAGRAM_POLLING_INTERVAL_MS=60000
INSTAGRAM_POLLING_MEDIA_LIMIT=10
INSTAGRAM_POLLING_COMMENTS_LIMIT=50
INSTAGRAM_POLLING_FULL_SCAN_EVERY=10
```

The code clamps the polling interval to 15 seconds–1 hour and defaults to 60 seconds.

Safety behavior:

- first run primes existing comments instead of dispatching history;
- Redis tracks seen comment IDs and media comment counts;
- unchanged `comments_count` can skip unnecessary reads;
- a periodic full scan catches comments even if Meta's count is delayed;
- transient durable/safety failures are not marked seen, so they can retry;
- Development-mode empty-media -> later visible-media transition re-primes to avoid a historical blast.

### 6. HMAC issue: what was wrong and what fixed it

Webhook callback verification worked, but Meta Test POST initially returned 403.

Safe diagnostics from PR #62 proved:

```text
platform=instagram
signaturePresent=true
rawBodyPresent=true
secretSource=INSTAGRAM_APP_SECRET
signatureMatch=false
```

The code was correct: Instagram-specific secret selection takes precedence over `META_APP_SECRET`. The actual Railway `INSTAGRAM_APP_SECRET` was simply the wrong App Secret for App `1991615571550659`.

The Meta audit proved the correct secret already matched `META_APP_SECRET`, so Railway was changed to a same-service reference:

```text
INSTAGRAM_APP_SECRET=${{ META_APP_SECRET }}
```

No secret value was copied into GitHub or logs.

After redeploy, Meta Test produced:

```text
POST /webhook -> 200
Meta webhook routed {"status":"ok","platform":"instagram",...}
```

This closed the HMAC problem. It did **not** prove real webhook delivery.

### 7. Why the real webhook still did not arrive

A real external comment was created under owned `astel.us` media. Polling discovered and processed it, but no new real `POST /webhook` appeared.

The subsequent Meta audit found the app is still:

```text
Development mode
is_live=false
```

The app-level `Instagram -> comments` subscription is active, and Dashboard Test reaches the callback, but real comment-webhook delivery is gated by Meta production requirements. Advanced Access / Business Verification / App Review work therefore remains backlog for a future real-webhook release.

Do not re-open the HMAC investigation when Dashboard Test returns 200 and real comments are only missing from webhook delivery.

### 8. Dry-run proof before live

Before enabling mutation, an external comment was processed successfully through polling:

```text
Conversation graph shadow -> RESOLVED
Airtable KB loaded -> records=9
AI_USAGE -> apiStatus=200
Community event processed -> status=dry-run, reason=WOULD_REPLY
Instagram polling cycle -> discovered=1, processed=1, failed=0
```

This established that reads, routing, safety, KB, AI, and the dry-run gate worked before any real Instagram mutation.

### 9. Controlled live cutover

Only one production variable was changed:

```text
INSTAGRAM_DRY_RUN=false
```

Nothing else was enabled. Threads, Facebook, content publishing, proactive, analytics, Content Pipeline, Hyper Crew, and the Publish Engine were left unchanged.

Railway redeployed successfully and the predeploy suite passed `219/219`.

Then one new comment was posted from another Instagram account under the owned Reel.

Production result:

```text
sourceId=18093487196449257
status=published
replyId=18105338471192490
failed=0
```

The reply appeared visibly in Instagram from `astel.us`.

### 10. Anti-loop proof

On the next poll, the bot discovered its own newly published reply.

The safety pipeline returned:

```text
sourceId=18105338471192490
status=ignored
reason=SELF_COMMENT
replyId=null
```

The next full scan returned:

```text
discovered=0
processed=0
failed=0
```

This is the required proof that the Instagram live path does not repeat the historical Threads self-reply-loop incident.

## Code/PR trail

The final route was not one patch; it was a sequence of increasingly precise fixes.

- PR #50 — fixed Instagram Login comment compatibility.
- PR #52 — added production-safe Instagram polling fallback and policy endpoints.
- PR #56 — added safe Instagram startup identity diagnostics.
- PR #57 — added official Facebook Login Graph flow.
- PR #58 — added discovery of the Facebook-linked IG account by username when IDs differ across auth surfaces.
- PR #59 — added fallback to the already configured Facebook Page token.
- PR #60 — experimental known-Page direct fallback; intentionally closed without merge after audit showed the blocker was elsewhere.
- PR #61 — fixed Facebook Login identity fields by removing unsupported `account_type` from that path.
- PR #62 — added secret-free webhook HMAC diagnostics.

Production code of interest:

- `app/accounts/accountConfig.js`
- `app/providers/instagramProvider.js`
- `adapters/instagramAdapter.js`
- `app/polling/instagramCommentPoller.js`
- `app/polling/instagramPollingStore.js`
- `app/webhooks/metaWebhookSignature.js`
- `server-meta.js`
- `server-meta-runtime.js`

## Current required Railway variable names

Record names only, never values:

```text
INSTAGRAM_AUTH_MODE
INSTAGRAM_ENABLED
INSTAGRAM_DRY_RUN
INSTAGRAM_USER_ID
INSTAGRAM_USERNAME
INSTAGRAM_ACCESS_TOKEN
INSTAGRAM_VERIFY_TOKEN
INSTAGRAM_APP_SECRET
INSTAGRAM_POLLING_ENABLED
INSTAGRAM_POLLING_INTERVAL_MS
INSTAGRAM_POLLING_MEDIA_LIMIT
INSTAGRAM_POLLING_COMMENTS_LIMIT
INSTAGRAM_POLLING_FULL_SCAN_EVERY
FACEBOOK_ACCESS_TOKEN
META_APP_SECRET
AIRTABLE_API_KEY
AIRTABLE_BASE_ID
OPENAI_API_KEY
REDIS_URL
DATABASE_URL
```

`INSTAGRAM_FACEBOOK_PAGE_ACCESS_TOKEN` is supported by code as the preferred explicit Page-token variable, with `FACEBOOK_ACCESS_TOKEN` as fallback.

## Checklist for connecting another owned Instagram account

Use this order. Do not jump directly to live.

1. Confirm the Instagram account is Professional and linked to the intended Facebook Page.
2. Confirm the exact IG Graph user ID and username. Keep app IDs / Business Manager asset IDs separate.
3. Keep the account in the existing Meta App unless there is a real reason to create another app.
4. Use `INSTAGRAM_AUTH_MODE=facebook_login` for the same architecture as `astel.us`.
5. Supply a valid Facebook Login credential and Page Access Token without exposing either in GitHub, Airtable, logs, or chat.
6. Enable the Instagram provider with `INSTAGRAM_DRY_RUN=true`.
7. Run the identity probe. Require `status=ok` and `usernameMatch=true`; investigate mismatches before continuing.
8. Publish a fresh test post/Reel directly from that Instagram account, not only as a collaborator.
9. Enable polling and let it prime history.
10. Add one external comment. Require polling `discovered=1`, pipeline success, and `WOULD_REPLY` in dry-run.
11. Verify safety stores, database, Airtable KB, AI, and account isolation are healthy.
12. Change only that account's dry-run to false for one canary.
13. Add one new external comment.
14. Require a concrete Meta reply ID and visually confirm exactly one reply.
15. Observe at least one subsequent poll. Require own reply -> `SELF_COMMENT` and no duplicate publish.
16. Only then leave the account live.

## Things not to repeat

- Do not create a new Meta App just because real webhooks do not arrive in Development mode.
- Do not rotate working credentials blindly when identity/media/comment reads are already healthy.
- Do not weaken HMAC verification to make a webhook test pass.
- Do not confuse successful Dashboard Test delivery with real-event eligibility.
- Do not use collaborator-owned media as the first API visibility test.
- Do not enable live reply before a real dry-run comment passes the entire pipeline.
- Do not remove the self guard, dedupe, cooldown, Redis state, Postgres durable state, or fail-closed behavior.
- Do not run `npm audit fix` blindly because the build reports moderate dependency findings.

## Future webhook path

The webhook implementation is retained for later. Before real comment webhooks can replace polling, complete and verify the Meta production gates for this app, including the required access/review/verification state and the Page/asset subscription edge. Keep `INSTAGRAM_DRY_RUN=true` during that future webhook cutover until a real event produces:

```text
real IG comment
  -> POST /webhook
  -> HMAC PASS
  -> HTTP 200
  -> parsed >= 1
  -> dispatched >= 1
  -> dry-run WOULD_REPLY
```

Only then perform another controlled live canary.

## Outcome

As of 2026-09-16, `astel.us` Instagram comment auto-reply is operational for the owner's account through official API polling and official reply mutation. The first live canary published exactly once and the following poll ignored the bot's own reply with `SELF_COMMENT`.
