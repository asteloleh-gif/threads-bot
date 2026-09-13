const test = require("node:test");
const assert = require("node:assert/strict");
const { createContentRuntime } = require("../app/content/contentRuntime");
const { createPublishEngine } = require("../app/publishing/publishEngine");
const { runContentDryRun, requireApprovedHuman, requireDryRunPublishEngine } = require("../app/content/contentDryRun");
const { createContentReadModel } = require("../app/content/contentReadModel");

function ids(values) {
  const queue = [...values];
  return () => queue.shift() || `id-${queue.length}`;
}

function memoryContentRepository() {
  const briefs = new Map();
  const drafts = new Map();
  const approvals = new Map();
  return {
    async saveBrief({ briefId, accountKey, objective = null, status = "CREATED", brief, metadata = {} }) {
      briefs.set(String(briefId), {
        brief_id: String(briefId), account_key: String(accountKey), objective, status, brief,
        metadata: { ...metadata }, created_at: "2026-09-13T00:00:00.000Z", updated_at: "2026-09-13T00:00:00.000Z",
      });
      return { briefId: String(briefId) };
    },
    async getBrief(briefId) { return briefs.get(String(briefId)) || null; },
    async saveDraft({ draftId, accountKey, content, status = "DRAFT", source = null, scheduledAt = null, metadata = {} }) {
      drafts.set(String(draftId), {
        draft_id: String(draftId), account_key: String(accountKey), content, status, source,
        scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        metadata: { ...metadata }, created_at: "2026-09-13T00:00:00.000Z", updated_at: "2026-09-13T00:00:00.000Z",
      });
      return { draftId: String(draftId) };
    },
    async getDraft(draftId) { return drafts.get(String(draftId)) || null; },
    async setDraftStatus({ draftId, status, scheduledAt = null, metadata = {} }) {
      const row = drafts.get(String(draftId));
      if (!row) return null;
      row.status = String(status);
      if (scheduledAt) row.scheduled_at = new Date(scheduledAt).toISOString();
      row.metadata = { ...(row.metadata || {}), ...(metadata || {}) };
      row.updated_at = "2026-09-13T00:01:00.000Z";
      return row;
    },
    async saveApproval({ approvalId, accountKey, subjectType, subjectId, status = "PENDING", reviewer = null, source = null, decisionAt = null, metadata = {} }) {
      approvals.set(String(approvalId), {
        approval_id: String(approvalId), account_key: String(accountKey), subject_type: String(subjectType), subject_id: String(subjectId),
        status: String(status), reviewer, source, decision_at: decisionAt ? new Date(decisionAt).toISOString() : null,
        metadata: { ...metadata }, created_at: "2026-09-13T00:00:30.000Z", updated_at: "2026-09-13T00:00:30.000Z",
      });
      return { approvalId: String(approvalId) };
    },
    async getLatestApproval({ subjectType, subjectId }) {
      return [...approvals.values()].filter(row => row.subject_type === String(subjectType) && row.subject_id === String(subjectId)).at(-1) || null;
    },
    health: () => ({ connected: true }),
    isReady: () => true,
  };
}

function memoryPublishRepository() {
  const jobs = new Map();
  return {
    async enqueue(job) {
      jobs.set(job.id, { ...job, status: "PENDING", result: {}, errorCode: null });
      return { created: true, duplicate: false, id: job.id };
    },
    async claim(id, claimToken) {
      const job = jobs.get(id);
      if (!job || job.status !== "PENDING") return false;
      job.status = "PROCESSING";
      job.claimToken = claimToken;
      return true;
    },
    async get(id) { return jobs.get(id) || null; },
    async finish(id, claimToken, status, { result = {}, errorCode = null } = {}) {
      const job = jobs.get(id);
      if (!job || job.status !== "PROCESSING" || job.claimToken !== claimToken) return false;
      job.status = status;
      job.result = result;
      job.errorCode = errorCode;
      delete job.claimToken;
      return true;
    },
    async due() { return []; },
    async recoverExpired() { return 0; },
    isReady: () => true,
    health: () => ({ connected: true }),
  };
}

function quotaStore() {
  let ready = false;
  return {
    async init() { ready = true; return { ready: true }; },
    isReady: () => ready,
    async takeQuota(_kind, requested, limit) { return { granted: requested, remaining: Math.max(0, limit - requested) }; },
    async close() { ready = false; },
    health: () => ({ connected: ready }),
  };
}

function sequentialAiClient() {
  const values = [
    { objective: "Teach", audience: "builders", angle: "one practical idea", keyPoints: ["supported fact"], evidenceNotes: ["research item 1"], language: "en" },
    { text: "One practical, supported idea for builders.", language: "en" },
    { decision: "PASS", notes: "Supported by the brief", risks: [] },
  ];
  return {
    health: () => ({ configured: true, endpointHost: "api.openai.com" }),
    async completeJson() {
      return { status: "ok", value: values.shift(), usage: { prompt_tokens: 20, completion_tokens: 10 }, responseId: "test-response" };
    },
  };
}

function enabledEnv() {
  return {
    OPENAI_API_KEY: "injected-client",
    OPENAI_MODEL: "test-model",
    OPENAI_INPUT_USD_PER_1M: "1",
    OPENAI_OUTPUT_USD_PER_1M: "2",
  };
}

test("Block 5E full path reaches SIMULATED publish with explicit human approval and zero provider mutation", async () => {
  let externalPublishCalls = 0;
  const provider = {
    account: { enabled: true },
    platform: "threads",
    capabilities: { publishPosts: true },
    health: () => ({ configured: true }),
    async publishPost() { externalPublishCalls += 1; throw new Error("must not be called in dry-run"); },
  };
  const providerRegistry = { findForAccount: key => key === "leo:threads" ? provider : null };
  const hot = memoryPublishRepository();
  const publishEngine = createPublishEngine({ providerRegistry, repository: hot, enabled: true, dryRun: true });
  const contentRepository = memoryContentRepository();
  const telemetry = { runs: [], async recordAgentRun(run) { this.runs.push(run); return { runId: run.runId }; } };
  const runtime = createContentRuntime({
    enabled: true,
    allowLiveScheduling: false,
    postgresStore: { isReady: () => true, health: () => ({ connected: true }) },
    durable: telemetry,
    publishEngine,
    providerRegistry,
    quotaStore: quotaStore(),
    aiClient: sequentialAiClient(),
    contentRepository,
    env: enabledEnv(),
    uuid: ids(["workflow-1", "run-brief", "brief-1", "run-draft", "draft-1", "run-review", "approval-1"]),
  });

  assert.deepEqual(await runtime.init(), { status: "ok", reason: "READY" });
  const result = await runtime.runEndToEndDryRun({
    accountKey: "leo:threads",
    objective: "Teach one useful idea",
    research: [{ fact: "supported fact", source: "operator-supplied" }],
    language: "en",
    humanApproval: { decision: "APPROVED", reviewer: "operator-test" },
    scheduledAt: new Date("2026-09-13T12:00:00.000Z"),
  });

  assert.equal(result.status, "simulated");
  assert.deepEqual(result.stages.map(item => item.stage), ["research", "aiBrief", "aiDraft", "aiReview", "humanApproval", "scheduler", "simulatedPublish"]);
  assert.equal(result.workflow.draft.status, "SCHEDULED");
  assert.equal(result.workflow.approval.status, "APPROVED");
  assert.equal(result.workflow.publish.status, "SIMULATED");
  assert.equal(result.workflow.publish.result.wouldPublish, true);
  assert.equal(externalPublishCalls, 0);
  assert.equal(telemetry.runs.length, 3);
});

test("end-to-end content run refuses a live Publish Engine before any workflow operation", async () => {
  let calls = 0;
  const operations = {
    generateBrief: async () => { calls += 1; },
    generateDraft: async () => {},
    reviewDraft: async () => {},
    decideApproval: async () => {},
    scheduleApprovedDraft: async () => {},
    getWorkflowSnapshot: async () => {},
  };
  await assert.rejects(() => runContentDryRun({
    operations,
    publishEngine: { health: () => ({ enabled: true, dryRun: false }), processJob: async () => ({}) },
    input: { humanApproval: { decision: "APPROVED", reviewer: "human" } },
  }), /requires Publish Engine dry-run/);
  assert.equal(calls, 0);
});

test("end-to-end content run requires explicit human APPROVED decision", () => {
  assert.throws(() => requireApprovedHuman({ reviewer: "operator", decision: "REJECTED" }), /explicit APPROVED/);
  assert.throws(() => requireApprovedHuman({ decision: "APPROVED" }), /Human reviewer is required/);
});

test("dry-run gate requires Publish Engine enabled and dry-run", () => {
  assert.throws(() => requireDryRunPublishEngine({ health: () => ({ enabled: false, dryRun: true }), processJob() {} }), /must be enabled/);
  assert.doesNotThrow(() => requireDryRunPublishEngine({ health: () => ({ enabled: true, dryRun: true }), processJob() {} }));
});

test("operator workflow read model joins brief, draft, approval and simulated publish state", async () => {
  const repository = memoryContentRepository();
  await repository.saveBrief({ briefId: "b1", accountKey: "leo:threads", objective: "x", brief: { angle: "a" } });
  await repository.saveDraft({ draftId: "d1", accountKey: "leo:threads", content: { type: "text", text: "hello" }, status: "SCHEDULED", metadata: { briefId: "b1", publishJobId: "j1" } });
  await repository.saveApproval({ approvalId: "a1", accountKey: "leo:threads", subjectType: "draft", subjectId: "d1", status: "APPROVED", reviewer: "operator" });
  const readModel = createContentReadModel({
    repository,
    publishEngine: {
      async getJob(id) { return { id, accountKey: "leo:threads", status: "SIMULATED", content: { type: "text", text: "hello" }, result: { wouldPublish: true }, dedupeKey: "private-dedupe" }; },
      health: () => ({ enabled: true, dryRun: true }),
    },
  });
  const snapshot = await readModel.getWorkflowSnapshot({ draftId: "d1" });
  assert.equal(snapshot.brief.briefId, "b1");
  assert.equal(snapshot.approval.status, "APPROVED");
  assert.equal(snapshot.publish.status, "SIMULATED");
  assert.equal(snapshot.publish.dedupeKey, undefined);
  assert.equal(snapshot.gates.humanApprovalRequired, true);
});
