const crypto = require("crypto");

function createContentRepository({ store } = {}) {
  if (!store) throw new Error("Content repository requires Postgres store");

  function assertReady() {
    if (!store.isReady?.()) throw new Error("Content repository unavailable");
  }

  async function saveBrief({ briefId = crypto.randomUUID(), accountKey, objective = null, status = "CREATED", brief, metadata = {} } = {}) {
    if (!accountKey || !brief) throw new Error("Content brief requires accountKey and brief");
    assertReady();
    await store.query(
      `INSERT INTO content_briefs(brief_id, account_key, objective, status, brief, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,NOW())
       ON CONFLICT (brief_id) DO UPDATE SET
         objective = EXCLUDED.objective,
         status = EXCLUDED.status,
         brief = EXCLUDED.brief,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [String(briefId), String(accountKey), objective, String(status), JSON.stringify(brief), JSON.stringify(metadata || {})],
    );
    return { briefId: String(briefId) };
  }

  async function getBrief(briefId) {
    if (!briefId) return null;
    assertReady();
    const result = await store.query(
      `SELECT brief_id, account_key, objective, status, brief, metadata, created_at, updated_at
       FROM content_briefs WHERE brief_id = $1 LIMIT 1`,
      [String(briefId)],
    );
    return result.rows?.[0] || null;
  }

  async function saveDraft({ draftId = crypto.randomUUID(), accountKey, content, status = "DRAFT", source = null, scheduledAt = null, metadata = {} } = {}) {
    if (!accountKey || !content) throw new Error("Draft requires accountKey and content");
    assertReady();
    await store.query(
      `INSERT INTO drafts(draft_id, account_key, content, status, source, scheduled_at, metadata, updated_at)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7::jsonb,NOW())
       ON CONFLICT (draft_id) DO UPDATE SET
         content = EXCLUDED.content,
         status = EXCLUDED.status,
         source = EXCLUDED.source,
         scheduled_at = EXCLUDED.scheduled_at,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [
        String(draftId),
        String(accountKey),
        JSON.stringify(content),
        String(status),
        source,
        scheduledAt ? new Date(scheduledAt).toISOString() : null,
        JSON.stringify(metadata || {}),
      ],
    );
    return { draftId: String(draftId) };
  }

  async function getDraft(draftId) {
    if (!draftId) return null;
    assertReady();
    const result = await store.query(
      `SELECT draft_id, account_key, content, status, source, scheduled_at, metadata, created_at, updated_at
       FROM drafts WHERE draft_id = $1 LIMIT 1`,
      [String(draftId)],
    );
    return result.rows?.[0] || null;
  }

  async function setDraftStatus({ draftId, status, scheduledAt = null, metadata = {} } = {}) {
    if (!draftId || !status) throw new Error("Draft status update requires draftId and status");
    assertReady();
    const result = await store.query(
      `UPDATE drafts SET
         status = $2,
         scheduled_at = COALESCE($3, scheduled_at),
         metadata = metadata || $4::jsonb,
         updated_at = NOW()
       WHERE draft_id = $1
       RETURNING draft_id, account_key, content, status, source, scheduled_at, metadata, created_at, updated_at`,
      [String(draftId), String(status), scheduledAt ? new Date(scheduledAt).toISOString() : null, JSON.stringify(metadata || {})],
    );
    return result.rows?.[0] || null;
  }

  async function saveApproval({ approvalId = crypto.randomUUID(), accountKey, subjectType, subjectId, status = "PENDING", reviewer = null, source = null, decisionAt = null, metadata = {} } = {}) {
    if (!accountKey || !subjectType || !subjectId) throw new Error("Approval requires accountKey and subject");
    assertReady();
    await store.query(
      `INSERT INTO approvals(approval_id, account_key, subject_type, subject_id, status, reviewer, source, decision_at, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW())
       ON CONFLICT (approval_id) DO UPDATE SET
         status = EXCLUDED.status,
         reviewer = EXCLUDED.reviewer,
         source = EXCLUDED.source,
         decision_at = EXCLUDED.decision_at,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [
        String(approvalId), String(accountKey), String(subjectType), String(subjectId), String(status),
        reviewer, source, decisionAt ? new Date(decisionAt).toISOString() : null, JSON.stringify(metadata || {}),
      ],
    );
    return { approvalId: String(approvalId) };
  }

  async function getLatestApproval({ subjectType, subjectId } = {}) {
    if (!subjectType || !subjectId) return null;
    assertReady();
    const result = await store.query(
      `SELECT approval_id, account_key, subject_type, subject_id, status, reviewer, source, decision_at, metadata, created_at, updated_at
       FROM approvals
       WHERE subject_type = $1 AND subject_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [String(subjectType), String(subjectId)],
    );
    return result.rows?.[0] || null;
  }

  function health() {
    return {
      connected: Boolean(store.isReady?.()),
      store: store.health?.() || null,
    };
  }

  return {
    saveBrief,
    getBrief,
    saveDraft,
    getDraft,
    setDraftStatus,
    saveApproval,
    getLatestApproval,
    isReady: () => Boolean(store.isReady?.()),
    health,
  };
}

module.exports = { createContentRepository };
