function publicBrief(row) {
  if (!row) return null;
  return {
    briefId: row.brief_id,
    accountKey: row.account_key,
    objective: row.objective ?? null,
    status: row.status,
    brief: row.brief || {},
    metadata: row.metadata || {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function publicDraft(row) {
  if (!row) return null;
  return {
    draftId: row.draft_id,
    accountKey: row.account_key,
    content: row.content || {},
    status: row.status,
    source: row.source || null,
    scheduledAt: row.scheduled_at || null,
    metadata: row.metadata || {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function publicApproval(row) {
  if (!row) return null;
  return {
    approvalId: row.approval_id,
    accountKey: row.account_key,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    status: row.status,
    reviewer: row.reviewer || null,
    source: row.source || null,
    decisionAt: row.decision_at || null,
    metadata: row.metadata || {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function publicPublishJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    accountKey: job.accountKey,
    status: job.status,
    content: job.content || {},
    scheduledAt: job.scheduledAt || null,
    metadata: job.metadata || {},
    result: job.result || {},
    errorCode: job.errorCode || null,
    createdAt: job.createdAt || null,
    updatedAt: job.updatedAt || null,
  };
}

function createContentReadModel({ repository, publishEngine } = {}) {
  if (!repository || typeof repository.getBrief !== "function" || typeof repository.getDraft !== "function") {
    throw new Error("Content read model requires content repository");
  }
  if (!publishEngine || typeof publishEngine.getJob !== "function") {
    throw new Error("Content read model requires Publish Engine read access");
  }

  async function getBrief(briefId) {
    return publicBrief(await repository.getBrief(briefId));
  }

  async function getDraft(draftId) {
    return publicDraft(await repository.getDraft(draftId));
  }

  async function getWorkflowSnapshot({ draftId } = {}) {
    const draftRow = await repository.getDraft(draftId);
    if (!draftRow) throw new Error("Draft not found");
    const briefId = draftRow.metadata?.briefId || null;
    const approvalRow = await repository.getLatestApproval({ subjectType: "draft", subjectId: draftId });
    const publishJobId = draftRow.metadata?.publishJobId || null;

    const [briefRow, publishJob] = await Promise.all([
      briefId ? repository.getBrief(briefId) : null,
      publishJobId ? publishEngine.getJob(publishJobId) : null,
    ]);

    return {
      brief: publicBrief(briefRow),
      draft: publicDraft(draftRow),
      approval: publicApproval(approvalRow),
      publish: publicPublishJob(publishJob),
      gates: {
        humanApprovalRequired: true,
        publishing: publishEngine.health?.() || null,
      },
    };
  }

  return {
    getBrief,
    getDraft,
    getWorkflowSnapshot,
    health: () => ({
      repository: repository.health?.() || null,
      publishing: publishEngine.health?.() || null,
      readOnly: true,
    }),
  };
}

module.exports = {
  createContentReadModel,
  publicBrief,
  publicDraft,
  publicApproval,
  publicPublishJob,
};
