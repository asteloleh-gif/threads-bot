const test = require("node:test");
const assert = require("node:assert/strict");
const { loadProactiveConfig, defaultMonitors } = require("../config/proactive");
const { createApprovalClient } = require("../proactive/approvalClient");
const { createProactiveAiService } = require("../proactive/aiService");
const { createCopilotRunner, basicFilter, inspectCandidate, scheduleSlot } = require("../proactive/copilotRunner");

function response(status, body, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: name => headers[name] || null }, async json() { return body; } };
}

test("proactive limits default to six-ish daily cycles and one-account half budget", () => {
  const config = loadProactiveConfig({ PROACTIVE_ENABLED: "true", PROACTIVE_MODE: "COPILOT", PROACTIVE_ACCOUNT: "ru" });
  assert.equal(config.pollIntervalSeconds, 14400);
  assert.equal(config.dailyEvaluationLimit, 150);
  assert.equal(config.dailyDraftLimit, 10);
  assert.equal(config.dailyAiTokenLimit, 50000);
  assert.equal(config.monthlyAiCostMicrousdLimit, 1000000);
  assert.equal(defaultMonitors("ru").length, 8);
  assert.equal(defaultMonitors("en").length, 8);
});

test("Texas schedule exposes only the four human approval windows", () => {
  const config = loadProactiveConfig({ PROACTIVE_ENABLED: "true", PROACTIVE_MODE: "COPILOT", PROACTIVE_ACCOUNT: "ru", PROACTIVE_SCHEDULE_HOURS: "8,12,16,20", PROACTIVE_TIMEZONE: "America/Chicago" });
  assert.deepEqual(config.scheduleHours, [8, 12, 16, 20]);
  assert.equal(config.scheduleTimezone, "America/Chicago");
  assert.equal(scheduleSlot(Date.parse("2026-09-12T13:02:00Z"), config.scheduleTimezone, config.scheduleHours), "2026-09-12:08");
  assert.equal(scheduleSlot(Date.parse("2026-09-12T14:00:00Z"), config.scheduleTimezone, config.scheduleHours), null);
});

test("approval client fails closed without credentials and never puts secret in URL or body", async () => {
  assert.equal((await createApprovalClient().submit({})).reason, "APPROVAL_NOT_CONFIGURED");
  const calls = [];
  const secret = "s".repeat(32);
  const client = createApprovalClient({ baseUrl: "https://telegram.test", account: "ru", secret,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response(201, { id: "a".repeat(32) }); } });
  assert.equal((await client.submit({ postId: "1", text: "draft" })).status, "ok");
  assert.equal((await client.report({ scanned: 3 })).status, "ok");
  assert.equal(calls[0].options.headers.authorization, `Bearer ${secret}`);
  assert.doesNotMatch(calls[0].url + calls[0].options.body, new RegExp(secret));
  assert.equal(calls[1].url, "https://telegram.test/api/copilot/reports");
});

test("AI service reserves hard token and monthly cost budgets before calls", async () => {
  const quotas = [];
  const state = { async takeQuota(kind, requested, limit, options) { quotas.push({ kind, requested, limit, options }); return { granted: requested }; } };
  const service = createProactiveAiService({ apiKey: "key", state,
    config: { dailyAiTokenLimit: 50000, monthlyAiCostMicrousdLimit: 1000000 },
    fetchImpl: async () => response(200, { choices: [{ message: { content: JSON.stringify({ items: [{ id: "1", score: 90, language: "en" }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) });
  const result = await service.rank([{ sourcePostId: "1", text: "A useful ecommerce observation with enough context." }]);
  assert.equal(result.status, "ok");
  assert.equal(result.ranked.length, 1);
  assert.equal(quotas[0].kind, "ai-tokens");
  assert.equal(quotas[0].limit, 50000);
  assert.equal(quotas[1].kind, "ai-cost-microusd");
  assert.equal(quotas[1].limit, 1000000);
  assert.deepEqual(quotas[1].options, { scope: "month" });
});

test("cycle report includes actual token cost calculated from input/output usage", async () => {
  const reports = [];
  const runner = createCopilotRunner({
    config: { enabled: true, mode: "COPILOT", maxPostAgeMinutes: 60, dailyEvaluationLimit: 10, dailyDraftLimit: 10 },
    monitors: [{ id: "m", enabled: true }], selfUsername: "leo",
    monitorService: { async runOnce() { return { status: "ok", discovered: 1, accepted: 1, candidates: [{ sourcePostId: "1", text: "A useful ecommerce post", authorUsername: "maker" }] }; } },
    state: { async takeQuota(_kind, requested) { return { granted: requested }; }, async savePending() { return true; }, async init() { return { ready: true }; }, async listPending() { return []; } },
    ai: {
      async rank(candidates) { return { status: "ok", ranked: [{ candidate: candidates[0], language: "en" }], usage: { prompt_tokens: 2000, completion_tokens: 100, total_tokens: 2100 } }; },
      async draft() { return { status: "ok", text: "Useful reply", language: "en", usage: { prompt_tokens: 300, completion_tokens: 50, total_tokens: 350 } }; },
    },
    approval: { configured() { return true; }, async submit() { return { status: "ok", id: "a".repeat(32) }; }, async report(value) { reports.push(value); return { status: "ok" }; } },
    threads: {},
  });
  const result = await runner.runSearch();
  assert.equal(result.aiTokens, 2450);
  assert.equal(result.aiCostMicrousd, 640);
});

test("basic filters reject self, empty and link-only candidates", () => {
  assert.equal(basicFilter({ sourcePostId: "1", text: "https://example.com" }, "leo"), false);
  assert.equal(basicFilter({ sourcePostId: "1", text: "A sufficiently useful public post", authorUsername: "Leo" }, "leo"), false);
  assert.equal(basicFilter({ sourcePostId: "1", text: "A sufficiently useful public post", authorUsername: "maker" }, "leo"), true);
  assert.equal(basicFilter({ sourcePostId: "1", text: "Good idea", authorUsername: "maker" }, "leo"), true);
  assert.equal(inspectCandidate({ sourcePostId: "1", text: "" }, "leo").reason, "EMPTY_TEXT");
  assert.equal(basicFilter({ sourcePostId: "1", text: "", authorUsername: "maker", media: { kind: "image" } }, "leo"), true);
});

test("runner hydrates an image-only candidate before GPT and Telegram submission", async () => {
  const logs = [];
  let rankedCandidate = null;
  const runner = createCopilotRunner({
    config: { enabled: true, mode: "COPILOT", maxPostAgeMinutes: 60, dailyEvaluationLimit: 10, dailyDraftLimit: 10 },
    monitors: [{ id: "m", enabled: true }], selfUsername: "leo",
    monitorService: { async runOnce() { return { status: "ok", discovered: 1, accepted: 1, candidates: [{ sourcePostId: "1", text: "", mediaType: "IMAGE", authorUsername: "maker" }] }; } },
    mediaReader: { async getPostDetails() { return { ok: true, data: { id: "1", text: "", media_type: "IMAGE", media_url: "https://example.com/image.jpg", alt_text: "A small business dashboard" } }; } },
    vision: { isEnabled() { return true; }, inspectTrustedThreadsMedia(data) { return { kind: "image", mediaType: data.media_type, imageUrl: data.media_url, altText: data.alt_text }; }, async moderateImage() { return { ok: true, flagged: false }; } },
    state: { async takeQuota(_kind, requested) { return { granted: requested }; }, async savePending() { return true; } },
    ai: { async rank(candidates) { rankedCandidate = candidates[0]; return { status: "ok", ranked: [{ candidate: candidates[0], language: "en" }], usage: null }; }, async draft() { return { status: "ok", text: "What changed after you built this dashboard?", language: "en", usage: null }; } },
    approval: { configured() { return true; }, async submit() { return { status: "ok", id: "c".repeat(32) }; } },
    threads: {}, logger: { log(...args) { logs.push(args.join(" ")); }, warn() {}, error() {} },
  });
  const result = await runner.runSearch();
  assert.equal(result.eligible, 1);
  assert.equal(result.submitted, 1);
  assert.equal(rankedCandidate.media.kind, "image");
  assert.match(logs.join("\n"), /Proactive candidate hydrated/);
});

test("runner publishes only after explicit approval and exactly once", async () => {
  const pending = [{ draftId: "a".repeat(32), postId: "123", text: "draft", language: "en" }];
  let claimed = false;
  let replies = 0;
  const runner = createCopilotRunner({
    config: { enabled: true, mode: "COPILOT" }, monitors: [], monitorService: {}, ai: {}, selfUsername: "leo",
    state: {
      async listPending() { return pending; },
      async claimPublish() { if (claimed) return false; claimed = true; return true; },
      async finishPending() { pending.length = 0; return true; },
    },
    approval: { async get() { return { status: "ok", draft: { postId: "123", text: "approved text" }, decision: { action: "approved" } }; } },
    threads: { async reply(postId, text) { replies += 1; assert.equal(postId, "123"); assert.equal(text, "approved text"); return { status: "published", id: "reply-1" }; } },
  });
  assert.equal((await runner.processPending()).published, 1);
  assert.equal((await runner.processPending()).published, 0);
  assert.equal(replies, 1);
});

test("runner never publishes undecided drafts", async () => {
  let replies = 0;
  const runner = createCopilotRunner({
    config: { enabled: true, mode: "COPILOT" }, monitors: [], monitorService: {}, ai: {}, selfUsername: "leo",
    state: { async listPending() { return [{ draftId: "b".repeat(32) }]; } },
    approval: { async get() { return { status: "ok", draft: { postId: "123", text: "draft" }, decision: null }; } },
    threads: { async reply() { replies += 1; } },
  });
  assert.equal((await runner.processPending()).waiting, 1);
  assert.equal(replies, 0);
});
