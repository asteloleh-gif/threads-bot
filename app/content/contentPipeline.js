const crypto = require("crypto");

const DRAFT_STATUS = Object.freeze({
  DRAFT: "DRAFT",
  NEEDS_REVISION: "NEEDS_REVISION",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  SCHEDULED: "SCHEDULED",
});

const APPROVAL_STATUS = Object.freeze({
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
});

function normalizeContent(content) {
  if (typeof content === "string") content = { type: "text", text: content };
  if (!content || typeof content !== "object") throw new Error("Draft content is required");
  const type = String(content.type || "text").trim().toLowerCase();
  if (type !== "text") throw new Error(`Unsupported draft content type: ${type}`);
  const text = String(content.text || "").trim();
  if (!text) throw new Error("Draft text is required");
  return { type, text };
}

function normalizeReviewDecision(value) {
  const decision = String(value || "").trim().toUpperCase();
  if (!["PASS", "REVISE", "REJECT"].includes(decision)) {
    throw new Error("Review decision must be PASS, REVISE, or REJECT");
  }
  return decision;
}

function normalizeApprovalDecision(value) {
  const decision = String(value || "").trim().toUpperCase();
  if (![APPROVAL_STATUS.APPROVED, APPROVAL_STATUS.REJECTED].includes(decision)) {
    throw new Error("Approval decision must be APPROVED or REJECTED");
  }
  return decision;
}

function createContentPipeline({
  repository,
  publishEngine,
  draftGenerator = null,
  reviewer = null,
  now = () => new Date(),
  uuid = () => crypto.randomUUID(),
} = {}) {
  if (!repository) throw new Error("Content pipeline requires repository");
  if (!publishEngine || typeof publishEngine.enqueue !== "function") {
    throw new Error("Content pipeline requires publish engine");
  }

  async function createBrief({ accountKey, objective = null, research = [], brief = {}, metadata = {} } = {}) {
    const normalizedAccountKey = String(accountKey || "").trim().toLowerCase();
    if (!normalizedAccountKey) throw new Error("Content brief accountKey is required");
    const briefId = uuid();
    const payload = {
      objective: objective == null ? null : String(objective),
      research: Array.isArray(research) ? research : [research],
      ...brief,
    };
    await repository.saveBrief({
      briefId,
      accountKey: normalizedAccountKey,
      objective,
      status: "CREATED",
      brief: payload,
      metadata,
    });
    return { briefId, accountKey: normalizedAccountKey, status: "CREATED", brief: payload };
  }

  async function createDraft({ briefId, content = null, source = "content-pipeline", metadata = {} } = {}) {
    const brief = await repository.getBrief(briefId);
    if (!brief) throw new Error("Content brief not found");

    let generated = content;
    if (generated == null) {
      if (typeof draftGenerator !== "function") throw new Error("Draft generator is not configured");
      generated = await draftGenerator({ brief, accountKey: brief.account_key });
    }
    const normalized = normalizeContent(generated);
    const draftId = uuid();
    await repository.saveDraft({
      draftId,
      accountKey: brief.account_key,
      content: normalized,
      status: DRAFT_STATUS.DRAFT,
      source,
      metadata: { ...metadata, briefId: String(briefId) },
    });
    return { draftId, accountKey: brief.account_key, status: DRAFT_STATUS.DRAFT, content: normalized };
  }

  async function reviewDraft({ draftId, decision = null, notes = null, metadata = {} } = {}) {
    const draft = await repository.getDraft(draftId);
    if (!draft) throw new Error("Draft not found");

    let reviewDecision = decision;
    let reviewNotes = notes;
    if (typeof reviewer === "function") {
      const result = await reviewer({ draft });
      reviewDecision = result?.decision;
      reviewNotes = result?.notes ?? reviewNotes;
    }
    reviewDecision = normalizeReviewDecision(reviewDecision);

    if (reviewDecision === "REVISE") {
      const updated = await repository.setDraftStatus({
        draftId,
        status: DRAFT_STATUS.NEEDS_REVISION,
        metadata: { ...metadata, review: { decision: reviewDecision, notes: reviewNotes || null, at: now().toISOString() } },
      });
      return { draftId, status: DRAFT_STATUS.NEEDS_REVISION, draft: updated };
    }

    if (reviewDecision === "REJECT") {
      const updated = await repository.setDraftStatus({
        draftId,
        status: DRAFT_STATUS.REJECTED,
        metadata: { ...metadata, review: { decision: reviewDecision, notes: reviewNotes || null, at: now().toISOString() } },
      });
      return { draftId, status: DRAFT_STATUS.REJECTED, draft: updated };
    }

    const approvalId = uuid();
    const updated = await repository.setDraftStatus({
      draftId,
      status: DRAFT_STATUS.AWAITING_APPROVAL,
      metadata: { ...metadata, review: { decision: reviewDecision, notes: reviewNotes || null, at: now().toISOString() } },
    });
    await repository.saveApproval({
      approvalId,
      accountKey: draft.account_key,
      subjectType: "draft",
      subjectId: draftId,
      status: APPROVAL_STATUS.PENDING,
      source: "content-review",
      metadata: { reviewDecision, notes: reviewNotes || null },
    });
    return { draftId, approvalId, status: DRAFT_STATUS.AWAITING_APPROVAL, draft: updated };
  }

  async function decideApproval({ draftId, decision, reviewer: humanReviewer, source = "human", metadata = {} } = {}) {
    const reviewerName = String(humanReviewer || "").trim();
    if (!reviewerName) throw new Error("Human reviewer is required");
    const normalizedDecision = normalizeApprovalDecision(decision);
    const draft = await repository.getDraft(draftId);
    if (!draft) throw new Error("Draft not found");
    const approval = await repository.getLatestApproval({ subjectType: "draft", subjectId: draftId });
    if (!approval) throw new Error("Draft has no approval request");
    if (String(approval.status) !== APPROVAL_STATUS.PENDING) throw new Error("Approval request is not pending");

    const decisionAt = now().toISOString();
    await repository.saveApproval({
      approvalId: approval.approval_id,
      accountKey: draft.account_key,
      subjectType: "draft",
      subjectId: draftId,
      status: normalizedDecision,
      reviewer: reviewerName,
      source,
      decisionAt,
      metadata,
    });
    const status = normalizedDecision === APPROVAL_STATUS.APPROVED
      ? DRAFT_STATUS.APPROVED
      : DRAFT_STATUS.REJECTED;
    const updated = await repository.setDraftStatus({
      draftId,
      status,
      metadata: { approval: { status: normalizedDecision, reviewer: reviewerName, source, decisionAt } },
    });
    return { draftId, approvalId: approval.approval_id, status, draft: updated };
  }

  async function scheduleApprovedDraft({ draftId, scheduledAt = now(), metadata = {} } = {}) {
    const draft = await repository.getDraft(draftId);
    if (!draft) throw new Error("Draft not found");
    const approval = await repository.getLatestApproval({ subjectType: "draft", subjectId: draftId });
    if (!approval || String(approval.status) !== APPROVAL_STATUS.APPROVED) {
      throw new Error("Human approval is required before scheduling");
    }
    if (String(draft.status) !== DRAFT_STATUS.APPROVED) {
      throw new Error(`Draft is not schedulable from status ${draft.status}`);
    }

    const schedule = new Date(scheduledAt);
    if (Number.isNaN(schedule.getTime())) throw new Error("Invalid scheduledAt");
    const enqueued = await publishEngine.enqueue({
      accountKey: draft.account_key,
      content: normalizeContent(draft.content),
      scheduledAt: schedule,
      dedupeKey: `draft:${draftId}`,
      metadata: {
        ...metadata,
        draftId: String(draftId),
        briefId: draft.metadata?.briefId || null,
        approvalId: approval.approval_id,
      },
    });
    const jobId = enqueued?.job?.id || enqueued?.id || null;
    const updated = await repository.setDraftStatus({
      draftId,
      status: DRAFT_STATUS.SCHEDULED,
      scheduledAt: schedule,
      metadata: { publishJobId: jobId },
    });
    return { draftId, status: DRAFT_STATUS.SCHEDULED, jobId, publish: enqueued, draft: updated };
  }

  function health() {
    return {
      repository: repository.health?.() || null,
      publish: publishEngine.health?.() || null,
      draftGeneratorConfigured: typeof draftGenerator === "function",
      reviewerConfigured: typeof reviewer === "function",
      humanApprovalRequired: true,
    };
  }

  return {
    createBrief,
    createDraft,
    reviewDraft,
    decideApproval,
    scheduleApprovedDraft,
    health,
  };
}

module.exports = {
  createContentPipeline,
  DRAFT_STATUS,
  APPROVAL_STATUS,
  normalizeContent,
};
