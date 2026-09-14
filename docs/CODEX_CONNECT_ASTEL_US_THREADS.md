# Codex task: connect `astel.us` Threads to `copilot-astel-us`

Execute this task autonomously. Do not create a new Meta app. Do not alter the working `threads-bot-ru` service. Do not change Instagram/Facebook configuration except to leave it untouched.

## Goal

Connect the Threads profile `astel.us` to the existing Railway service `copilot-astel-us` in **controlled dry-run mode**. The Meta app may remain unpublished. Use the Threads Tester path and the official Threads API. The backend already contains an official polling ingress fallback, so app-level Threads webhooks are not required for this test.

## Known infrastructure

- GitHub repo: `asteloleh-gif/threads-bot`
- Railway project: `astel-us`
- Railway service: `copilot-astel-us`
- Production callback/domain: `https://copilot-astel-us-production.up.railway.app`
- Meta parent app: `Astel US Social Engine`
- Meta App ID: `1991615571550659`
- Target Threads profile: `astel.us`
- Threads polling fallback merged in PR #53 / main commit `d40a54577a2e5f07c1ad578be5de86c85c734e95`
- Existing safety stack: Redis + Postgres + self-guard + dedupe + cooldown + idempotency

## Hard safety constraints

- Keep `BOT_DRY_RUN=true` for the entire task.
- Do not enable real public replies.
- Keep `PUBLISH_ENGINE_ENABLED=false`.
- Keep `CONTENT_PIPELINE_ENABLED=false`.
- Keep `HYPER_CREW_ENABLED=false`.
- Keep `PROACTIVE_ENABLED=false`.
- Do not publish the Meta app.
- Do not start Business Verification, Access Verification, Tech Provider Verification, or App Review.
- Do not create a new Meta app.
- Never print, paste into chat, commit, or log any access token, app secret, or OpenAI key.
- Never put a token in a Git URL, source file, issue, PR, or screenshot note.

## Meta / Threads setup

1. Open the existing Meta app `Astel US Social Engine` and its Threads use case.
2. Verify the Threads permissions required for this owned/tester account are available for testing:
   - `threads_basic`
   - `threads_content_publish`
   - `threads_read_replies`
   - `threads_manage_replies`
3. Ensure the Threads profile `astel.us` is added as a **Threads Tester**. If an invite is pending, sign in as `astel.us` and accept it under Threads account settings / Website permissions.
4. Obtain an authorization code/access token for `astel.us` using the official Threads authorization flow or the dashboard's supported tester token flow. Request only the four scopes above.
5. Exchange a short-lived token for a long-lived Threads token immediately. Do not leave a one-hour token in Railway.
6. Verify the token read-only against the official Threads API:
   - profile identity for `me`;
   - recent owned Threads posts;
   - if a post has replies, fetch its flattened conversation.
7. Confirm the returned profile is exactly `astel.us`. Capture the Threads user ID, but do not expose the token.

## Railway setup

In `astel-us` → `copilot-astel-us`, preserve all unrelated variables and set/update only what is required:

- `THREADS_ACCESS_TOKEN=<long-lived token>`
- `THREADS_USER_ID=<verified astel.us Threads user id>`
- `THREADS_USERNAME=astel.us`
- `BOT_ENABLED=true`
- `BOT_DRY_RUN=true`
- `THREADS_POLLING_ENABLED=true`
- `THREADS_POLLING_INTERVAL_MS=60000`
- `THREADS_POLLING_POSTS_LIMIT=10`
- `THREADS_POLLING_REPLIES_LIMIT=50`
- `THREADS_POLLING_FULL_SCAN_EVERY=10`

Do not modify `THREADS_VERIFY_TOKEN`; it already exists and is not needed for polling.

Check whether `OPENAI_API_KEY` exists in `copilot-astel-us`. If it is missing, copy the existing OpenAI API key from the user's working `threads-bot-ru` Railway service into `copilot-astel-us` **without displaying the secret anywhere**. Do not rotate or create a new OpenAI key unless copying the existing secret is impossible. If Railway/browser permissions prevent a secret-safe copy, stop at that exact point and report it as the only remaining blocker.

## Deployment verification

Allow Railway to redeploy once after the variables are complete. Verify:

- deployment status = SUCCESS;
- pre-deploy tests pass;
- Postgres connected;
- Redis safety connected;
- Threads token manager connected;
- runtime shows `threadsEnabled=true`;
- runtime shows `threadsDryRun=true`;
- `Threads polling startup` reports `STARTED`;
- first polling cycle either primes visible posts/replies or gives an exact Meta API reason if reads fail.

The first polling pass MUST prime historical replies and MUST NOT process them as new replies.

## Controlled read-only proof

Do not create a public post or public reply. Use API reads only. Confirm:

- `astel.us` identity is readable;
- recent owned posts are readable;
- conversation/reply reads are allowed with `threads_read_replies`;
- no token appears in logs;
- no external reply mutation occurs because `BOT_DRY_RUN=true`.

If app publication/webhook configuration is blocked, ignore it for this task. Polling is the intended ingress while the app remains unpublished.

## Stop conditions

Stop and report, without making broader changes, if any of these occur:

- Meta refuses tester authorization for `astel.us`;
- the requested tester scopes cannot be granted;
- long-lived token exchange fails;
- profile identity does not equal `astel.us`;
- Railway cannot receive the token without exposing it;
- `OPENAI_API_KEY` cannot be copied secret-to-secret;
- Meta requires a destructive or verification action not listed above.

## Final report

Return only:

- Threads tester: yes/no
- Long-lived token: yes/no
- Threads user ID: configured/not configured
- API identity: ok/fail
- Recent posts read: count or fail reason
- Conversation read: ok/not applicable/fail reason
- Railway deploy: SUCCESS/fail
- Threads polling: STARTED/fail
- BOT_DRY_RUN: true/false
- OPENAI_API_KEY: present/missing (never reveal value)
- Remaining blocker: exact text or `NONE`

Do not perform a real public reply. The next step after a clean report is one human-created test comment followed by log verification while dry-run remains enabled.
