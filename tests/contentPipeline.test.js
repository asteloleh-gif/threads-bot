const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createContentPipeline,
  DRAFT_STATUS,
  APPROVAL_STATUS,
} = require("../app/content/contentPipeline");
const { createContentRepository } = require("../app/content/contentRepository");

function memoryRepository() {
  const briefs = new Map();
  const drafts = new Map();
  const approvals = new Map();
  return {
    briefs,
    drafts,
    approvals,
    health: () => ({ connected: true }),
    async saveBrief(input) {
      briefs.set(input.briefId, {
        brief_id: input.briefId,
        account_key: input.accountKey,
        objective: input.objective,
        status: input.status,
        brief: input.brief,
        metadata: input.metadata || {},
      });
      return { briefId: input.briefId };
    },
    async getBrief(id) { return briefs.get(id) || null; },
    async saveDraft(input) {
      drafts.set(input.draftId, {
        draft_id: input.draftId,
        account_key: input.accountKey,
        content: input.content,
        status: input.status,
        source: input.source,
        scheduled_at: input.scheduledAt || null,
        metadata: input.metadata || {},
      });
      return { draftId: input.draftId };
    },
    async getDraft(id) { return drafts.get(id) || null; },
    async setDraftStatus({ draftId, status, scheduledAt = null, metadata = {} }) {
      const draft = drafts.get(draftId);
      if (!draft) return null;
      draft.status = status;
      if (scheduledAt) draft.scheduled_at = new Date(scheduledAt).toISOString();
      draft.metadata = { ...(draft.metadata || {}), ...(metadata || {}) };
      return draft;
    },
    async saveApproval(input) {
      approvals.set(input.approvalId, {
        approval_id: input.approvalId,
        account_key: input.accountKey,
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        status: input.status,
        reviewer: input.reviewer || null,
        source: input.source || null,
        decision_at: input.decisionAt || null,
        metadata: input.metadata || {},
        created_at: approvals.get(input.approvalId)?.created_at || new Date().toISOString(),
      });
      return { approvalId: input.approvalId };
    },
    async getLatestApproval({ subjectType, subjectId }) {
      return Array.from(approvals.values()).reverse().find(item => item.subject_type === subjectType && item.subject_id === subjectId) || null;
    },
  };
}

function fakePublishEngine() {
  const calls = [];
  return {
    calls,
    health: () => ({ enabled: false, dryRun: true }),
    async enqueue(input) {
      calls.push(input);
      return { created: true, id: "job-1", job: { id: "job-1", ...input } };
    },
  };
}

function ids(values) {
  const queue = [...values];
  return () => queue.shift();
}

test("content pipeline creates a durable research brief and normalized draft", async () => {
  const repository = memoryRepository();
  const publishEngine = fakePublishEngine();
  const pipeline = createContentPipeline({
    repository,
    publishEngine,
    uuid: ids(["brief-1", "draft-1"]),
  });

  const brief = await pipeline.createBrief({
    accountKey: "LEO:THREADS",
    objective: "Test a strong hook",
    research: [{ source: "analytics", finding: "short hooks win" }],
    brief: { angle: "business" },
  });
  assert.equal(brief.accountKey, "leo:threads");
  assert.equal(repository.briefs.get("brief-1").brief.research.length, 1);

  const draft = await pipeline.createDraft({ briefId: "brief-1", content: "  hello world  " });
  assert.equal(draft.status, DRAFT_STATUS.DRAFT);
  assert.deepEqual(draft.content, { type: "text", text: "hello world" });
  assert.equal(repository.drafts.get("draft-1").metadata.briefId, "brief-1");
});

test("draft generation can be delegated through an injected generator", async () => {
  const repository = memoryRepository();
  const publishEngine = fakePublishEngine();
  const pipeline = createContentPipeline({
    repository,
    publishEngine,
    uuid: ids(["brief-1", "draft-1"]),
    draftGenerator: async ({ brief }) => ({ type: "text", text: `generated:${brief.objective}` }),
  });
  await pipeline.createBrief({ accountKey: "leo:threads", objective: "growth", brief: {} });
  const draft = await pipeline.createDraft({ briefId: "brief-1" });
  assert.equal(draft.content.text, "generated:growth");
});

test("review PASS creates a pending human approval and blocks direct scheduling", async () => {
  const repository = memoryRepository();
  const publishEngine = fakePublishEngine();
  const pipeline = createContentPipeline({
    repository,
    publishEngine,
    uuid: ids(["brief-1", "draft-1", "approval-1"]),
  });
  await pipeline.createBrief({ accountKey: "leo:threads", brief: {} });
  await pipeline.createDraft({ briefId: "brief-1", content: "post" });
  const reviewed = await pipeline.reviewDraft({ draftId: "draft-1", decision: "PASS", notes: "clean" });
  assert.equal(reviewed.status, DRAFT_STATUS.AWAITING_APPROVAL);
  assert.equal(repository.approvals.get("approval-1").status, APPROVAL_STATUS.PENDING);
  await assert.rejects(
    () => pipeline.scheduleApprovedDraft({ draftId: "draft-1" }),
    /Human approval is required/,
  );
  assert.equal(publishEngine.calls.length, 0);
});

test("review REVISE and REJECT never create approval requests", async () => {
  for (const [decision, expected] of [["REVISE", DRAFT_STATUS.NEEDS_REVISION], ["REJECT", DRAFT_STATUS.REJECTED]]) {
    const repository = memoryRepository();
    const publishEngine = fakePublishEngine();
    const pipeline = createContentPipeline({ repository, publishEngine, uuid: ids(["brief", "draft"]) });
    await pipeline.createBrief({ accountKey: "leo:threads", brief: {} });
    await pipeline.createDraft({ briefId: "brief", content: "post" });
    const result = await pipeline.reviewDraft({ draftId: "draft", decision });
    assert.equal(result.status, expected);
    assert.equal(repository.approvals.size, 0);
  }
});

test("human approval transitions a reviewed draft to APPROVED", async () => {
  const repository = memoryRepository();
  const publishEngine = fakePublishEngine();
  const pipeline = createContentPipeline({
    repository,
    publishEngine,
    uuid: ids(["brief-1", "draft-1", "approval-1"]),
    now: () => new Date("2026-09-13T15:00:00.000Z"),
  });
  await pipeline.createBrief({ accountKey: "leo:threads", brief: {} });
  await pipeline.createDraft({ briefId: "brief-1", content: "post" });
  await pipeline.reviewDraft({ draftId: "draft-1", decision: "PASS" });
  const approved = await pipeline.decideApproval({
    draftId: "draft-1",
    decision: "APPROVED",
    reviewer: "Oleg",
  });
  assert.equal(approved.status, DRAFT_STATUS.APPROVED);
  assert.equal(repository.approvals.get("approval-1").reviewer, "Oleg");
  assert.equal(repository.approvals.get("approval-1").status, APPROVAL_STATUS.APPROVED);
});

test("scheduling requires confirmed human approval and enqueues exactly one publish job", async () => {
  const repository = memoryRepository();
  const publishEngine = fakePublishEngine();
  const pipeline = createContentPipeline({
    repository,
    publishEngine,
    uuid: ids(["brief-1", "draft-1", "approval-1"]),
    now: () => new Date("2026-09-13T15:00:00.000Z"),
  });
  await pipeline.createBrief({ accountKey: "leo:threads", brief: {} });
  await pipeline.createDraft({ briefId: "brief-1", content: "approved post" });
  await pipeline.reviewDraft({ draftId: "draft-1", decision: "PASS" });
  await pipeline.decideApproval({ draftId: "draft-1", decision: "APPROVED", reviewer: "Oleg" });
  const scheduled = await pipeline.scheduleApprovedDraft({
    draftId: "draft-1",
    scheduledAt: "2026-09-14T12:00:00.000Z",
  });
  assert.equal(scheduled.status, DRAFT_STATUS.SCHEDULED);
  assert.equal(scheduled.jobId, "job-1");
  assert.equal(publishEngine.calls.length, 1);
  assert.equal(publishEngine.calls[0].dedupeKey, "draft:draft-1");
  assert.equal(publishEngine.calls[0].metadata.approvalId, "approval-1");
  assert.equal(repository.drafts.get("draft-1").status, DRAFT_STATUS.SCHEDULED);
});

test("rejected human approval cannot be scheduled", async () => {
  const repository = memoryRepository();
  const publishEngine = fakePublishEngine();
  const pipeline = createContentPipeline({ repository, publishEngine, uuid: ids(["brief", "draft", "approval"]) });
  await pipeline.createBrief({ accountKey: "leo:threads", brief: {} });
  await pipeline.createDraft({ briefId: "brief", content: "post" });
  await pipeline.reviewDraft({ draftId: "draft", decision: "PASS" });
  await pipeline.decideApproval({ draftId: "draft", decision: "REJECTED", reviewer: "Oleg" });
  await assert.rejects(() => pipeline.scheduleApprovedDraft({ draftId: "draft" }), /Human approval is required/);
  assert.equal(publishEngine.calls.length, 0);
});

test("content repository fails closed before Postgres is ready", async () => {
  const repository = createContentRepository({
    store: {
      isReady: () => false,
      health: () => ({ connected: false }),
      query: async () => { throw new Error("should not query"); },
    },
  });
  assert.equal(repository.health().connected, false);
  await assert.rejects(
    () => repository.saveBrief({ accountKey: "leo:threads", brief: {} }),
    /Content repository unavailable/,
  );
});
