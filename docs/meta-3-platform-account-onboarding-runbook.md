# Meta 3-platform account onboarding runbook

Verified operational path for Astel Social Engine, snapshot 2026-09-22.

This runbook exists so a future account/brand can be connected to Threads + Instagram + Facebook without repeating the investigation that was required for `astel.us`.

It records only secret-free operational facts. Never commit access tokens, App Secrets, verify tokens, OpenAI keys, Redis URLs, Postgres URLs, or other credentials.

---

## 1. Final architecture that worked

One brand/service owns exactly one primary Threads account plus optional Instagram and Facebook accounts.

Repository:

`asteloleh-gif/threads-bot`

Current production service:

`copilot-astel-us`

Current production callback:

`https://copilot-astel-us-production.up.railway.app/webhook`

Meta App:

- name: `Astel US Social Engine`
- App ID: `1991615571550659`
- mode: Development
- Business Portfolio ID: `1069900484139703`

Current connected brand:

- Threads: `astel.us`
- Instagram: `astel.us`
- Facebook Page: `Олег Акастелов`
- Facebook Page ID: `656083597578810`
- Instagram Graph User ID: `17841473220032439`

Current main commit at the time this runbook was created:

`3414602c68998da71fcca5749cbfe7c0fda07350`

Current production deployment used for the final Facebook validation:

`54073133-830e-4e00-96c9-26d1f04b97da`

Predeploy suite:

`244/244 PASS`

---

## 2. Known Meta asset inventory

These Page/Instagram pairs were already verified in the Business Portfolio.

| Brand/Page | Facebook Page ID | Instagram | IG Graph User ID |
|---|---:|---|---:|
| Олег Акастелов | 656083597578810 | astel.us | 17841473220032439 |
| Astel E-COM | 407638319092200 | astel.u | 17841473267485723 |
| Leo Astel | 703391439515655 | leoakastel | 17841448996132476 |

Important:

- a Business Manager asset ID is not automatically the Graph Instagram User ID;
- the Meta App ID is not an Instagram User ID;
- Threads IDs for future brands must be verified independently;
- never guess account IDs from UI labels.

---

## 3. Service isolation rule for future brands

`app/accounts/accountConfig.js` supports:

- one primary Threads account;
- one optional Instagram account;
- one optional Facebook account.

The safe pattern is therefore:

`one brand = one Railway service = one Threads + one IG + one FB identity set`.

Do not put `astel.us`, `astel.u`, and `leoakastel` into the same service unless the account model is intentionally redesigned.

For a new brand, create/clone a dedicated service and keep brand identity isolated with:

`SOCIAL_BRAND`

and preferably:

`SOCIAL_REQUIRE_BRAND_ISOLATION=true`

Redis/Postgres state must not be accidentally shared across brands without explicit namespaces/isolation.

---

## 4. Shared safety stack — do not remove

All three platforms use the same safety philosophy:

- self guard;
- known bot reply ID guard;
- source dedupe;
- Redis reservation / branch lease;
- cooldown;
- conversation reply limits;
- global daily limits;
- durable Postgres event/reply state;
- branch relationship resolution;
- fail-closed handling when relationship/identity is ambiguous;
- no blind retry after ambiguous Meta mutation;
- human takeover lock;
- account dry-run gates;
- polling history priming.

Do not weaken these protections to make an edge case “work”.

A working platform is only considered live after:

1. an external test event is discovered;
2. the full AI pipeline succeeds;
3. exactly one real reply is published;
4. the next cycle sees the bot’s own reply;
5. the self/bot-generated guard prevents a loop.

---

# THREADS

## 5. Threads connection path

Use the existing Meta App. Do not create a new App for each Threads account.

For an owned/test account in Development mode:

1. Add the Threads profile as a Threads Tester.
2. Accept the Tester invitation while signed in as that Threads account.
3. Request only the required Threads scopes:
   - `threads_basic`
   - `threads_content_publish`
   - `threads_read_replies`
   - `threads_manage_replies`
4. Obtain an official Threads authorization code/token.
5. Exchange the short-lived token for a long-lived Threads token.
6. Verify read-only:
   - profile identity;
   - recent owned posts;
   - conversations/replies.
7. Confirm the returned username is exactly the intended account.
8. Record the exact Threads user ID.
9. Put the credential into Railway without exposing it.

Required variable names:

```text
THREADS_ACCESS_TOKEN
THREADS_USER_ID
THREADS_USERNAME
THREADS_VERIFY_TOKEN
THREADS_POLLING_ENABLED
THREADS_POLLING_INTERVAL_MS
THREADS_POLLING_POSTS_LIMIT
THREADS_POLLING_REPLIES_LIMIT
THREADS_POLLING_FULL_SCAN_EVERY
BOT_ENABLED
BOT_DRY_RUN
```

Recommended first cutover:

```text
BOT_ENABLED=true
BOT_DRY_RUN=true
THREADS_POLLING_ENABLED=true
THREADS_POLLING_INTERVAL_MS=60000
THREADS_POLLING_POSTS_LIMIT=10
THREADS_POLLING_REPLIES_LIMIT=50
THREADS_POLLING_FULL_SCAN_EVERY=10
```

Polling must prime historical replies before any new event is dispatched.

After dry-run proof, do one controlled live canary and verify the self guard before leaving Threads live.

Existing detailed task:

`docs/CODEX_CONNECT_ASTEL_US_THREADS.md`

---

# INSTAGRAM

## 6. Instagram connection path that actually worked

For this architecture use:

```text
INSTAGRAM_AUTH_MODE=facebook_login
```

The working route is based on the Instagram Professional account linked to its Facebook Page.

For `astel.us`:

- Instagram: `astel.us`
- IG User ID: `17841473220032439`
- linked Page ID: `656083597578810`

Critical rule:

The Page token fallback is supplied by:

```text
INSTAGRAM_FACEBOOK_PAGE_ACCESS_TOKEN || FACEBOOK_ACCESS_TOKEN
```

So a broken `FACEBOOK_ACCESS_TOKEN` can break both Facebook and the Instagram Facebook-login fallback.

### Instagram onboarding order

1. Confirm the Instagram account is Professional.
2. Confirm it is linked to the intended Facebook Page.
3. Confirm exact IG Graph user ID + username.
4. Use `facebook_login`.
5. Supply a valid Page credential.
6. Start with:
   `INSTAGRAM_DRY_RUN=true`.
7. Require the identity probe to show:
   - `status=ok`
   - `idMatch=true`
   - `usernameMatch=true`
8. Publish a fresh test Reel/post directly from the target IG account.
9. Do not use collaborator/co-author media as the first API visibility test.
10. Enable polling and let it prime.
11. Add one external comment.
12. Require dry-run `WOULD_REPLY`.
13. Change only `INSTAGRAM_DRY_RUN=false`.
14. Add one new external comment.
15. Require one concrete Meta reply ID.
16. Require next cycle to classify the bot reply as self and publish no duplicate.

Required variable names:

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
```

Verified `astel.us` live canary:

- inbound comment ID: `18093487196449257`
- published reply ID: `18105338471192490`
- following cycle: bot reply ignored as self;
- no loop.

Existing detailed runbook:

`docs/instagram-astel-us-live-runbook.md`

---

# FACEBOOK

## 7. Facebook connection path that actually worked

The Facebook path took the longest because User Access Token, Page Access Token, OAuth grants, Development-mode behavior, and Page permissions were initially mixed together.

The final rule is simple:

`FACEBOOK_ACCESS_TOKEN must be the Page Access Token for the exact Page.`

Do not put a normal User Access Token into `FACEBOOK_ACCESS_TOKEN`.

For `astel.us`:

- Page name: `Олег Акастелов`
- Page ID: `656083597578810`
- App ID: `1991615571550659`

### 7.1 User OAuth grant required for Page-token derivation

The successful reauthorization used these six permissions:

```text
pages_show_list
pages_read_engagement
pages_read_user_content
pages_manage_engagement
instagram_basic
instagram_manage_comments
```

The previous failure mode was:

- `pages_manage_engagement=granted`
- the other required Page discovery/read permissions were `declined`
- `/me/accounts` returned `data: []`

Do not debug code when this happens. Fix the OAuth grant first.

### 7.2 Correct token chain

```text
fresh User Access Token
  -> verify /me/permissions
  -> obtain Page Access Token for exact Page
  -> verify token type=Page
  -> verify Page identity
  -> verify published_posts
  -> verify comments
  -> only then install the Page token in Railway
```

Never expose either token in chat, logs, GitHub, screenshots, or docs.

The working Page credential was validated as:

- token type: Page;
- correct App ID;
- correct Page ID;
- required scopes present;
- token expiration shown by Meta as “Never”;
- data access expiration must still be monitored separately.

At validation time the data-access expiry shown by Meta was:

`2026-12-21 19:05 UTC`

Treat that as a revalidation deadline, not as a promise that the credential can never become invalid.

### 7.3 Read-only verification before Railway

Require all of these to pass:

```text
GET /me?fields=id,name
GET /{PAGE_ID}?fields=id,name
GET /{PAGE_ID}/published_posts
GET /{POST_ID}/comments
```

The Page identity returned by `/me` must be the intended Page when using the Page token.

### 7.4 Railway cutover

Change only:

```text
FACEBOOK_ACCESS_TOKEN=<verified Page Access Token>
```

Do not simultaneously change polling, dry-run, webhook, or safety variables.

After deployment require:

- deployment SUCCESS;
- tests PASS;
- Facebook identity probe PASS;
- `published_posts` polling PASS;
- no Meta 100/200/210 permission failures;
- Instagram regression check PASS, because Instagram may use the same Page-token fallback.

### 7.5 Facebook production canary proof

Verified live sequence:

```text
external Page comment
  -> Facebook polling
  -> relationship RESOLVED
  -> PersonaMemory
  -> Airtable KB
  -> GPT
  -> status=published
  -> concrete replyId
  -> later poll
  -> BOT_GENERATED_OBJECT
  -> no duplicate
```

Verified production examples include:

- source `122172116702818185_1418564890405640`
  -> reply `122172116702818185_1106185425182200`
  -> later `BOT_GENERATED_OBJECT`

- source `122172116702818185_956744023484109`
  -> reply `122172116702818185_3437723576429930`
  -> later `BOT_GENERATED_OBJECT`

- source `122172116702818185_1724051282009653`
  -> reply `122172116702818185_1093105756703391`
  -> later `BOT_GENERATED_OBJECT`

This proves the polling + AI + mutation + anti-loop path works technically in production.

### 7.6 Authorless Facebook behavior

Meta may return Page comments with `from=null`, even when the Facebook UI visibly shows the author.

Current behavior intentionally distinguishes safe and unsafe cases.

Safe external root comment under an owned Page post can still proceed when the relationship is provable.

Known bot reply IDs are quarantined across in-process/Redis/durable storage and are stopped as:

`BOT_GENERATED_OBJECT`

Known self-authored objects are stopped as:

`SELF_COMMENT`

An external nested reply under a manually Page-authored comment may remain unprovable when Meta hides its author. In that case the bot fails closed:

`AUTHORLESS_UNTRUSTED`

Do not remove this guard just to make the edge case answer automatically.

### 7.7 Facebook polling variables

Required names:

```text
FACEBOOK_ACCESS_TOKEN
FACEBOOK_ENABLED
FACEBOOK_DRY_RUN
FACEBOOK_USER_ID
FACEBOOK_USERNAME
FACEBOOK_VERIFY_TOKEN
FACEBOOK_POLLING_ENABLED
FACEBOOK_POLLING_INTERVAL_MS
FACEBOOK_POLLING_FULL_SCAN_EVERY
```

The current poller:

- reads recent `/{page}/published_posts`;
- checks comment counts;
- periodically full-scans comments;
- stores seen IDs + counts in Redis;
- hydrates missing authors with direct Graph lookup when possible;
- keeps transient fail-closed events unseen so they can be retried.

Do not clear the Facebook polling Redis state during normal onboarding.

---

# WEBHOOKS

## 8. What is already working and what is not

Shared callback:

`https://copilot-astel-us-production.up.railway.app/webhook`

Verified:

- callback URL correct;
- GET verification path works;
- POST route exists;
- HMAC/signature validation is configured;
- Meta Dashboard test webhook reaches Railway and returns 200;
- router identifies Facebook test payloads.

For Facebook, app-level Page webhook configuration exists and `feed` is configured.

However the current App is still in Development mode.

Meta Dashboard explicitly reported during investigation that only test webhooks are delivered in the current unpublished state; real production webhook events are not delivered.

Therefore current v1 ingress is:

- Threads: polling fallback;
- Instagram: polling fallback;
- Facebook: polling fallback.

Do not make real webhook delivery a blocker for another owner-operated account.

### `pages_manage_metadata`

This permission is needed to read/manage Page subscription state such as `/{page}/subscribed_apps`.

It is NOT required for the current Facebook polling + comment-reply path.

Do not request it merely because polling/replies are being onboarded.

---

# DEVELOPMENT MODE LIMITATION

## 9. Important public-visibility caveat

Technical Facebook API mutation is verified, but Development-mode public visibility is not equivalent to a normal Live-app rollout.

Observed during testing:

- Page/API reply is successfully created;
- admin/Page views can see the reply;
- another account may see `View 1 reply` while the API-created reply body is not rendered to that viewer.

Do not claim public Facebook auto-reply is production-ready for arbitrary external users while the App remains unpublished.

Treat Facebook in Development mode as:

`technically operational for owner/admin testing; public visibility not guaranteed`.

Do not “fix” this in application code.

When public visibility becomes a requirement, separately evaluate current Meta Live/App Review/verification requirements for that specific account and permission set.

---

# REUSABLE ONBOARDING FOR ANOTHER BRAND

## 10. Exact order for the next account

Use this sequence for `astel.u`, `leoakastel`, or another owned brand.

### Phase A — inventory

1. Identify exact brand name.
2. Identify Threads username + official Threads user ID.
3. Identify Facebook Page + Page ID.
4. Identify Instagram Professional username + IG Graph User ID.
5. Confirm Page ↔ Instagram linkage.
6. Confirm the owner/admin has sufficient asset access.
7. Reuse the existing Meta App unless there is a real isolation/compliance reason not to.

### Phase B — isolated service

8. Create/clone a dedicated Railway service for that brand.
9. Use its own `SOCIAL_BRAND`.
10. Enable brand isolation.
11. Keep all platform mutation/dry-run gates safe initially.
12. Keep Content Pipeline, Publish Engine, Hyper Crew, proactive publishing, and unrelated features disabled.

### Phase C — Threads

13. Add/accept Threads Tester.
14. Obtain long-lived official Threads token.
15. Verify identity + posts + replies read-only.
16. Configure Threads ID/username/token.
17. Enable Threads polling in dry-run.
18. Prime history.
19. Run one external dry-run canary.
20. Enable live only after exact proof.
21. Verify own reply is ignored.

### Phase D — Facebook + Instagram credential chain

22. Reauthorize a human User token with the required Page/IG scopes.
23. Verify all required permissions are `granted`, not merely available in the App.
24. Derive the exact Facebook Page Access Token.
25. Verify Page token identity.
26. Verify `published_posts` + comments.
27. Install the Page token as `FACEBOOK_ACCESS_TOKEN`.
28. Verify Instagram Facebook-login/Page-token fallback resolves the intended IG account.
29. Verify IG identity/media/comments.
30. Never use a User token as the final `FACEBOOK_ACCESS_TOKEN`.

### Phase E — dry-run

31. Enable FB + IG polling with both platform dry-runs true.
32. Let both pollers prime history.
33. Create one fresh owned IG post/Reel.
34. Add one external IG test comment.
35. Add one external FB test comment.
36. Require reads → routing → KB → GPT → `WOULD_REPLY`.
37. Verify Redis/Postgres/safety health.

### Phase F — controlled live canary

38. Flip only one platform dry-run at a time.
39. Create exactly one fresh external comment.
40. Require exactly one published reply ID.
41. Visually confirm the reply.
42. Wait for the next poll.
43. Require self/bot reply classification and no duplicate.
44. Only then leave that platform live.
45. Repeat for the next platform.

### Phase G — observe

46. Run the account for at least a day before expanding automation.
47. Review odd language/persona responses.
48. Review authorless/nested edge cases.
49. Review latency.
50. Do not touch working permissions/tokens without evidence of a credential issue.

---

# THINGS NOT TO REPEAT

## 11. Dead ends / mistakes already paid for

Do not repeat these on the next account.

### Meta auth

- Do not put a User Access Token into `FACEBOOK_ACCESS_TOKEN`.
- Do not assume `/me/accounts=[]` means code is broken.
- First inspect `/me/permissions` for declined Page discovery/read scopes.
- Do not equate “permission exists in App” with “user token has it granted”.
- Do not infer Business Verification/App Review is the immediate blocker for an owner/admin Development-mode read/poll test without evidence.
- Do not rotate a working token blindly.

### Instagram

- Do not confuse App ID, Business Manager asset ID, and IG Graph User ID.
- Do not start API visibility testing on a collaborator-owned post.
- Do not mix Instagram Login `business_*` assumptions into the verified `facebook_login` route.
- Do not blame webhook HMAC if Dashboard Test is already returning 200.

### Facebook

- Do not remove authorless fail-closed protections.
- Do not clear seen/dedupe state just because a comment is not discovered.
- First check whether Graph itself returns the comment.
- Do not interpret successful API mutation as proof that every public viewer can see the reply while the App is in Development mode.

### Webhooks

- Do not create a new Meta App because real webhooks are missing in Development mode.
- Do not weaken HMAC/signature verification.
- Do not confuse Dashboard Test webhook delivery with real-event eligibility.
- Do not make webhook delivery a release blocker for owner-operated polling v1.

### Infrastructure

- Do not modify multiple Railway variables during a canary.
- Do not mix brands in the same state namespace/service casually.
- Do not expose credentials in chat, GitHub, logs, screenshots, Airtable, or docs.
- Do not enable Content Pipeline / Hyper Crew / proactive publishing while debugging account connectivity.

---

## 12. Definition of done for a future account

A future 3-platform account is considered successfully onboarded only when all relevant checks pass.

```text
THREADS_IDENTITY=true
THREADS_READS=true
THREADS_LIVE_CANARY=true
THREADS_ANTI_LOOP=true

INSTAGRAM_IDENTITY=true
INSTAGRAM_READS=true
INSTAGRAM_LIVE_CANARY=true
INSTAGRAM_ANTI_LOOP=true

FACEBOOK_IDENTITY=true
FACEBOOK_READS=true
FACEBOOK_LIVE_CANARY=true
FACEBOOK_ANTI_LOOP=true

REDIS_HEALTHY=true
POSTGRES_HEALTHY=true
AIRTABLE_KB_HEALTHY=true
OPENAI_HEALTHY=true
NO_DUPLICATE_REPLIES=true
SECRETS_EXPOSED=false
```

If the App is still in Development mode, add:

```text
PUBLIC_FACEBOOK_VISIBILITY=NOT_GUARANTEED
REAL_META_WEBHOOKS=NOT_REQUIRED_FOR_POLLING_V1
```

---

## 13. Code paths to inspect first

Do not search the whole repository first. Start here.

```text
app/accounts/accountConfig.js

adapters/threadsAdapter.js
app/polling/threadsCommentPoller.js

adapters/instagramAdapter.js
app/providers/instagramProvider.js
app/polling/instagramCommentPoller.js
app/polling/instagramPollingStore.js

adapters/facebookAdapter.js
app/providers/facebookProvider.js
app/polling/facebookCommentPoller.js
app/polling/facebookPollingStore.js

app/community/createCommunityRuntime.js
app/community/createPlatformReplyGenerator.js
app/webhooks/metaWebhookRouter.js
app/webhooks/metaWebhookSignature.js
app/db/durableRepository.js
safety/pipeline.js

server-meta.js
server-meta-runtime.js
```

---

## 14. Existing detailed docs

Use these instead of rediscovering old work:

- `docs/CODEX_CONNECT_ASTEL_US_THREADS.md`
- `docs/instagram-astel-us-live-runbook.md`
- `docs/astel-us-onboarding.md`
- `docs/railway-hardening.md`

This runbook is the consolidated “next account” entry point.

---

## 15. Official reference families

Re-check current Meta docs before any future App Review/Live rollout because Meta requirements change.

- Threads API / tester authorization / reply management
- Instagram Platform comment moderation
- Instagram Platform Facebook Login flow
- Pages API
- Page comment moderation/replies
- Graph API Webhooks for Pages

Do not rely on old screenshots or stale permission assumptions for a future Live/App Review submission.
