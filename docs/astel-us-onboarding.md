# Astel US onboarding — 2026-09-13

## Decision and safety state

Use a dedicated `copilot-astel-us` Railway service, project, Postgres and Redis.
The shared account loader supports one optional Instagram and Facebook account
per service. Identity is environment data; no copied application logic.
Keep every platform disabled until its own credentials and scopes are validated.
Then enable only dry-run. First real Instagram and Facebook replies each require
explicit approval; no autonomous posting, App Review submission or Live switch.

## Verified Meta inventory

App: Astel US Social Engine, `1991615571550659`, Development mode.
Business Portfolio: Олег Акастелов, `1069900484139703`.

| Facebook Page | Page ID | Instagram | IG User ID |
|---|---|---|---|
| Олег Акастелов | 656083597578810 | astel.us | 17841473220032439 |
| Astel E-COM | 407638319092200 | astel.u | 17841473267485723 |
| Leo Astel | 703391439515655 | leoakastel | 17841448996132476 |

Scope: all three Pages/Instagram assets displayed in this portfolio. This is not
proof that a future API token can access all three. Links were verified in Meta
Business Suite. Internal Business Manager Instagram asset IDs are different
from the IG User IDs above and must not be used as API account IDs.
Instagram App ID `947525348402771` is also not an IG User ID.

The signed-in person has full Page access and partial Instagram access including
content, community, messages and insights on astel.us. A corresponding Threads
profile is present, but the astel.us Threads API user ID/token is unverified.

## Permissions, review, tokens and webhooks

Dashboard Ready for testing (API calls 0): pages_show_list,
pages_read_engagement, pages_manage_engagement, pages_manage_posts,
instagram_basic, instagram_manage_comments, instagram_content_publish,
instagram_manage_engagement, instagram_business_manage_comments,
instagram_business_content_publish, instagram_business_manage_insights,
business_management, public_profile.

Dashboard Add to App Review request: pages_read_user_content,
pages_manage_metadata, instagram_business_basic, ads_read, ads_management,
instagram_manage_insights, instagram_business_manage_messages,
instagram_manage_messages, read_insights. These labels are app configuration,
not granted token scopes. Standard access development tests are limited to
eligible app-role users and their managed assets; Advanced access for other
users/assets requires review. Verify scopes and asset tasks on the actual token.

App Review UI: Not submitted. MCP history: no previous submissions/review.
MCP status UNSUBMITTED conflicts with internal is_approved and a requirements
message claiming a previous review is in progress. Do not infer approval or
rejection from those contradictory fields. Submission is currently blocked.
Privacy Policy missing; icon/category incomplete. Terms/Data Deletion UI showed
a generic facebook.com URL while the API returned null; neither establishes an
adequate application-specific disclosure or deletion process. Business and Tech
Provider verification are unverified; legal business fields are empty. Legal
information must come from the owner; do not invent it or submit verification.

The DevTools connector's user credential works for app reads. Its expiry and
operational Graph scopes are not exposed by the available tool. It is not proof
of a usable Page/Instagram publishing token. No IG/FB access-token variables were
present in the existing EN/RU Railway services. Operational token type, grants,
validity, data-access expiry and expiry therefore remain unverified.

App webhook subscriptions: none. Instagram setup callback is blank and no
token-generation account is connected there. Page-level subscribed_apps state
is unverified without a Page token. Required layers are app webhook registration
and subscription of the specific Page/IG asset, using the chosen login flow.
Catalog IG fields: comments, live_comments, mentions, message_edit,
message_reactions, messages, messaging_handover, messaging_postbacks,
messaging_referral, messaging_seen, standby, story_insights. Page comment events
use feed. Availability of a catalog field does not grant permission to use it.
The Instagram setup UI states app publication is required for delivery; real
Development-mode delivery remains an external validation gate.

## Capability gaps

The current IG adapter uses graph.facebook.com: choose Instagram API with
Facebook Login, using the linked Page credential, rather than mixing it with
Instagram Login business_* token grants.

- IG comment read/reply: validate instagram_basic, instagram_manage_comments,
  pages_read_engagement and required asset tasks on the Page token. Where Meta's
  Business Manager assignment conditions apply, check ads_read/ads_management.
- Page comment read/reply: validate pages_show_list, pages_read_engagement,
  pages_read_user_content and pages_manage_engagement on the correct Page token.
- IG publishing: instagram_content_publish plus basic/read engagement and
  applicable asset conditions; provider publishPosts is currently false.
- Page publishing: pages_manage_posts and proper Page task/token; provider
  publishPosts is currently false.
- Insights: instagram_manage_insights/read_insights as applicable; IG/FB
  provider insights are currently false. Existing analytics supports Threads.
- Webhooks: pages_manage_metadata plus required Page access; signed HTTPS
  callback, verify token and asset subscription. Never enable before signature
  validation and exact target routing pass.

Official references:
- https://developers.facebook.com/documentation/instagram-platform/comment-moderation
- https://developers.facebook.com/documentation/instagram-platform/content-publishing
- https://developers.facebook.com/documentation/instagram-platform/overview
- https://developers.facebook.com/documentation/pages-api
- https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-pages/

## Repository/deployment baseline

main 535aee2f218b12a19ff2ea7af294f61605adbd8e and ru-bot
 ecf93dd62312adf397a104ce21bc5956f789f954 have identical tree
23a69fad71686333af1a341618c4f797f379f0da despite divergent histories.
Baseline: 178 tests pass. Local runtime is Node 24.19.0/npm 11.17.0; repository
and CI pin Node 24.20.0/npm 11.19.0. Exact pinned CI remains a merge gate.
Both EN/RU deployments return HTTP 200, Postgres+Redis connected/required,
publishing disabled/dry-run, proactive disabled, content and Hyper Crew disabled.
Threads replies are already live on those existing services; do not change their
account credentials or dry-run state as part of US provisioning.

Block 5A–5E is already implemented. Block 6A shell also exists, disabled. Do not
rebuild Block 5 or extend Hyper Crew during this onboarding.

## Hardening and cutover

New IG/Page POST ingress requires HMAC-SHA256 over raw request bytes, with
INSTAGRAM_APP_SECRET/FACEBOOK_APP_SECRET or META_APP_SECRET. Missing secrets
return 503; bad signatures return 403. META_WEBHOOK_SIGNATURE_REQUIRED=true
also enforces signing for Threads. Existing Threads rollout remains compatible
unless its secret or the strict flag is set; migrate it separately with its own
app secret. GET verification tokens do not authenticate POST requests.

IG/Page adapters require configured ID == entry.id and ignore malformed arrays.
Secondary replies require durable event persistence in DATABASE_REQUIRED mode
and recheck database availability before a live mutation. Unknown post-mutation
store outcomes hold the reservation; they never roll back for an automatic
retry. Confirmed reply text is returned for durable persistence. Account dry-run
also overrides a live publish engine; disabled engines reject direct processing.

Before enabling: provision isolated dependencies and secrets; verify /health;
inspect token metadata without values; subscribe only astel.us; test signed
inbound IG comments/Page feed in dry-run; verify database, self guard, replay,
AI and no publish; prepare one explicit approved reply per platform. Dry-run
simulation is not evidence of real webhook delivery or token validity.

## SAFE NEXT ACTIONS

1. Review inventory and deploy the tested hardening with all US platforms disabled.
2. Provision isolated Postgres/Redis and service health/restart/predeploy policy.
3. Enter secrets directly in Railway; inspect only token metadata and scope names.
4. Complete role/asset grants and development OAuth; configure signed callbacks.
5. Enable dry-run only and validate real inbound events, replay and persistence.
6. Ask approval for one exact Instagram reply, then one exact Facebook reply.
7. Complete owner-provided legal policies/verification and prepare App Review.
8. Only with separate approval, submit review, switch Live or enable posting.
