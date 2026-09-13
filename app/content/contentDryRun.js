function requireApprovedHuman(input = {}) {
  const reviewer = String(input.reviewer || "").trim();
  const decision = String(input.decision || "").trim().toUpperCase();
  if (!reviewer) throw new Error("Human reviewer is required");
  if (decision !== "APPROVED") throw new Error("End-to-end dry-run requires explicit APPROVED human decision");
  return { reviewer, decision, source: input.source || "content-e2e-dry-run", metadata: input.metadata || {} };
}

function requireDryRunPublishEngine(publishEngine) {
  const health = publishEngine?.health?.() || {};
  if (!health.enabled) throw new Error("Publish Engine must be enabled for end-to-end dry-run");
  if (!health.dryRun) throw new Error("End-to-end content run requires Publish Engine dry-run");
  if (typeof publishEngine.processJob !== "function") throw new Error("Publish Engine processJob is unavailable");
  return health;
}

async function runContentDryRun({
  operations,
  publishEngine,
  input = {},
  now = () => new Date(),
} = {}) {
  const required = ["generateBrief", "generateDraft", "reviewDraft", "decideApproval", "scheduleApprovedDraft", "getWorkflowSnapshot"];
  for (const name of required) {
    if (typeof operations?.[name] !== "function") throw new Error(`Content dry-run requires operation ${name}`);
  }
  requireDryRunPublishEngine(publishEngine);
  const approvalInput = requireApprovedHuman(input.humanApproval || {});
  const stages = [];
  const metadata = { ...(input.metadata || {}), e2eDryRun: true };

  stages.push({
    stage: "research",
    status: "supplied",
    items: Array.isArray(input.research) ? input.research.length : (input.research == null ? 0 : 1),
  });

  const brief = await operations.generateBrief({
    accountKey: input.accountKey,
    objective: input.objective,
    research: input.research || [],
    analytics: input.analytics || null,
    brand: input.brand || null,
    language: input.language || "auto",
    metadata,
  });
  stages.push({ stage: "aiBrief", status: brief?.status || "unknown", briefId: brief?.briefId || null });
  if (brief?.status !== "ok" || !brief.briefId) {
    return { status: "stopped", stoppedAt: "aiBrief", stages, result: brief || null };
  }

  const draft = await operations.generateDraft({
    briefId: brief.briefId,
    constraints: input.constraints || {},
    language: input.language || "auto",
    metadata,
  });
  stages.push({ stage: "aiDraft", status: draft?.status || "unknown", draftId: draft?.draftId || null });
  if (draft?.status !== "ok" || !draft.draftId) {
    return { status: "stopped", stoppedAt: "aiDraft", stages, result: draft || null };
  }

  const review = await operations.reviewDraft({
    draftId: draft.draftId,
    policy: input.policy || null,
    metadata,
  });
  stages.push({
    stage: "aiReview",
    status: review?.status || "unknown",
    decision: review?.review?.decision || null,
    workflowStatus: review?.workflowStatus || null,
  });
  if (review?.status !== "ok" || review?.review?.decision !== "PASS" || review?.workflowStatus !== "AWAITING_APPROVAL") {
    return { status: "stopped", stoppedAt: "aiReview", stages, result: review || null };
  }

  const approval = await operations.decideApproval({
    draftId: draft.draftId,
    decision: approvalInput.decision,
    reviewer: approvalInput.reviewer,
    source: approvalInput.source,
    metadata: { ...metadata, ...(approvalInput.metadata || {}) },
  });
  stages.push({ stage: "humanApproval", status: approval?.status || "unknown", approvalId: approval?.approvalId || null });
  if (approval?.status !== "APPROVED") {
    return { status: "stopped", stoppedAt: "humanApproval", stages, result: approval || null };
  }

  const scheduledAt = input.scheduledAt || now();
  const scheduled = await operations.scheduleApprovedDraft({
    draftId: draft.draftId,
    scheduledAt,
    metadata,
  });
  stages.push({ stage: "scheduler", status: scheduled?.status || "unknown", jobId: scheduled?.jobId || null });
  if (scheduled?.status !== "SCHEDULED" || !scheduled.jobId) {
    return { status: "stopped", stoppedAt: "scheduler", stages, result: scheduled || null };
  }

  // Target only the job created by this workflow. We deliberately do not call tick(),
  // because a generic scheduler tick could process unrelated queued jobs.
  const simulated = await publishEngine.processJob(scheduled.jobId);
  stages.push({ stage: "simulatedPublish", status: simulated?.status || "unknown", jobId: scheduled.jobId });
  if (simulated?.status !== "simulated") {
    return { status: "failed", stoppedAt: "simulatedPublish", stages, result: simulated || null };
  }

  const workflow = await operations.getWorkflowSnapshot({ draftId: draft.draftId });
  return {
    status: "simulated",
    briefId: brief.briefId,
    draftId: draft.draftId,
    approvalId: approval.approvalId || review.approvalId || null,
    jobId: scheduled.jobId,
    stages,
    workflow,
  };
}

module.exports = {
  runContentDryRun,
  requireApprovedHuman,
  requireDryRunPublishEngine,
};
