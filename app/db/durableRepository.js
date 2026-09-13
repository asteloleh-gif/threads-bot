const crypto = require("crypto");

function json(value, fallback) {
  return value == null ? fallback : value;
}

function createDurableRepository({ store } = {}) {
  if (!store) throw new Error("Durable repository requires Postgres store");

  async function syncAccounts(accounts = []) {
    if (!store.isReady()) return { synced: 0, skipped: true };
    return store.transaction(async client => {
      let synced = 0;
      for (const account of accounts) {
        const brandKey = String(account.brand || account.username || "default").toLowerCase();
        await client.query(
          `INSERT INTO brands(brand_key, name, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (brand_key) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()`,
          [brandKey, account.brand || account.username || brandKey],
        );
        await client.query(
          `INSERT INTO social_accounts(
             account_key, brand_key, platform, username, platform_user_id, language, enabled, dry_run, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
           ON CONFLICT (account_key) DO UPDATE SET
             brand_key = EXCLUDED.brand_key,
             platform = EXCLUDED.platform,
             username = EXCLUDED.username,
             platform_user_id = EXCLUDED.platform_user_id,
             language = EXCLUDED.language,
             enabled = EXCLUDED.enabled,
             dry_run = EXCLUDED.dry_run,
             updated_at = NOW()`,
          [
            String(account.key),
            brandKey,
            String(account.platform),
            String(account.username),
            account.userId ? String(account.userId) : null,
            String(account.language || "auto"),
            account.enabled !== false,
            account.dryRun !== false,
          ],
        );
        synced += 1;
      }
      return { synced, skipped: false };
    });
  }

  async function recordSocialEvent(event) {
    if (!event?.accountKey || !event?.sourceId) return { stored: false, reason: "INVALID_EVENT" };
    const occurredAt = event.timestamp ? new Date(event.timestamp) : null;
    await store.query(
      `INSERT INTO comments(
         account_key, source_id, root_id, parent_id, author_id, author_username, text, surface, occurred_at, metadata, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NOW())
       ON CONFLICT (account_key, source_id) DO UPDATE SET
         root_id = EXCLUDED.root_id,
         parent_id = EXCLUDED.parent_id,
         author_id = EXCLUDED.author_id,
         author_username = EXCLUDED.author_username,
         text = EXCLUDED.text,
         surface = EXCLUDED.surface,
         occurred_at = COALESCE(EXCLUDED.occurred_at, comments.occurred_at),
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [
        String(event.accountKey),
        String(event.sourceId),
        event.rootId ? String(event.rootId) : null,
        event.parentId ? String(event.parentId) : null,
        event.author?.id ? String(event.author.id) : null,
        event.author?.username ? String(event.author.username) : null,
        String(event.text || ""),
        event.surface ? String(event.surface) : null,
        occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt.toISOString() : null,
        JSON.stringify(json(event.metadata, {})),
      ],
    );
    return { stored: true };
  }

  async function recordReply({ accountKey, sourceCommentId, replyId = null, status, text = null, publishedAt = null, metadata = {} } = {}) {
    if (!accountKey || !sourceCommentId || !status) return { stored: false, reason: "INVALID_REPLY" };
    await store.query(
      `INSERT INTO replies(account_key, source_comment_id, platform_reply_id, status, text, published_at, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (account_key, platform_reply_id) WHERE platform_reply_id IS NOT NULL
       DO UPDATE SET status = EXCLUDED.status, text = EXCLUDED.text, published_at = EXCLUDED.published_at, metadata = EXCLUDED.metadata`,
      [
        String(accountKey),
        String(sourceCommentId),
        replyId ? String(replyId) : null,
        String(status),
        text == null ? null : String(text),
        publishedAt ? new Date(publishedAt).toISOString() : null,
        JSON.stringify(json(metadata, {})),
      ],
    );
    return { stored: true };
  }

  async function saveDraft({ draftId = crypto.randomUUID(), accountKey, content, status = "DRAFT", source = null, scheduledAt = null, metadata = {} } = {}) {
    if (!accountKey || !content) throw new Error("Draft requires accountKey and content");
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
      [String(draftId), String(accountKey), JSON.stringify(content), String(status), source, scheduledAt ? new Date(scheduledAt).toISOString() : null, JSON.stringify(json(metadata, {}))],
    );
    return { draftId: String(draftId) };
  }

  async function recordPublishEnqueued(job) {
    if (!job?.id || !job?.accountKey) throw new Error("Publish run requires id and accountKey");
    await store.query(
      `INSERT INTO publish_runs(job_id, account_key, draft_id, status, scheduled_at, metadata, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       ON CONFLICT (job_id) DO UPDATE SET
         account_key = EXCLUDED.account_key,
         draft_id = EXCLUDED.draft_id,
         status = EXCLUDED.status,
         scheduled_at = EXCLUDED.scheduled_at,
         metadata = EXCLUDED.metadata,
         updated_at = EXCLUDED.updated_at`,
      [
        String(job.id),
        String(job.accountKey),
        job.metadata?.draftId ? String(job.metadata.draftId) : null,
        String(job.status || "PENDING"),
        job.scheduledAt ? new Date(job.scheduledAt).toISOString() : null,
        JSON.stringify(json(job.metadata, {})),
        job.createdAt ? new Date(job.createdAt).toISOString() : new Date().toISOString(),
        job.updatedAt ? new Date(job.updatedAt).toISOString() : new Date().toISOString(),
      ],
    );
    return { stored: true };
  }

  async function recordPublishState({ jobId, status, result = {}, errorCode = null, startedAt = null, finishedAt = null } = {}) {
    if (!jobId || !status) throw new Error("Publish state requires jobId and status");
    const platformPostId = result?.id || result?.publishedId || null;
    await store.query(
      `UPDATE publish_runs SET
         status = $2,
         started_at = COALESCE($3, started_at),
         finished_at = COALESCE($4, finished_at),
         platform_post_id = COALESCE($5, platform_post_id),
         error_code = $6,
         result = $7::jsonb,
         updated_at = NOW()
       WHERE job_id = $1`,
      [
        String(jobId),
        String(status),
        startedAt ? new Date(startedAt).toISOString() : null,
        finishedAt ? new Date(finishedAt).toISOString() : null,
        platformPostId ? String(platformPostId) : null,
        errorCode ? String(errorCode) : null,
        JSON.stringify(json(result, {})),
      ],
    );
    return { stored: true };
  }

  async function upsertPost({ accountKey, platformPostId, contentType = "text", text = null, status = "PUBLISHED", permalink = null, publishedAt = null, metadata = {} } = {}) {
    if (!accountKey || !platformPostId) throw new Error("Post requires accountKey and platformPostId");
    await store.query(
      `INSERT INTO posts(account_key, platform_post_id, content_type, text, status, permalink, published_at, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,NOW())
       ON CONFLICT (account_key, platform_post_id) WHERE platform_post_id IS NOT NULL
       DO UPDATE SET content_type = EXCLUDED.content_type, text = EXCLUDED.text, status = EXCLUDED.status,
         permalink = EXCLUDED.permalink, published_at = EXCLUDED.published_at, metadata = EXCLUDED.metadata, updated_at = NOW()`,
      [String(accountKey), String(platformPostId), String(contentType), text == null ? null : String(text), String(status), permalink, publishedAt ? new Date(publishedAt).toISOString() : null, JSON.stringify(json(metadata, {}))],
    );
    return { stored: true };
  }

  async function recordAnalyticsSnapshot({ accountKey, entityType, entityId, metrics, capturedAt = new Date(), metadata = {} } = {}) {
    if (!accountKey || !entityType || !entityId || !metrics) throw new Error("Analytics snapshot is incomplete");
    await store.query(
      `INSERT INTO analytics_snapshots(account_key, entity_type, entity_id, metrics, captured_at, metadata)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb)`,
      [String(accountKey), String(entityType), String(entityId), JSON.stringify(metrics), new Date(capturedAt).toISOString(), JSON.stringify(json(metadata, {}))],
    );
    return { stored: true };
  }

  async function saveContentBrief({ briefId = crypto.randomUUID(), accountKey, objective = null, status = "CREATED", brief, metadata = {} } = {}) {
    if (!accountKey || !brief) throw new Error("Content brief requires accountKey and brief");
    await store.query(
      `INSERT INTO content_briefs(brief_id, account_key, objective, status, brief, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,NOW())
       ON CONFLICT (brief_id) DO UPDATE SET objective = EXCLUDED.objective, status = EXCLUDED.status,
         brief = EXCLUDED.brief, metadata = EXCLUDED.metadata, updated_at = NOW()`,
      [String(briefId), String(accountKey), objective, String(status), JSON.stringify(brief), JSON.stringify(json(metadata, {}))],
    );
    return { briefId: String(briefId) };
  }

  async function recordAgentRun(input = {}) {
    const runId = String(input.runId || crypto.randomUUID());
    await store.query(
      `INSERT INTO agent_runs(run_id, account_key, workflow_id, node, model, status, input_tokens, output_tokens,
         cached_input_tokens, cost_microusd, latency_ms, metadata, started_at, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)
       ON CONFLICT (run_id) DO UPDATE SET status = EXCLUDED.status, input_tokens = EXCLUDED.input_tokens,
         output_tokens = EXCLUDED.output_tokens, cached_input_tokens = EXCLUDED.cached_input_tokens,
         cost_microusd = EXCLUDED.cost_microusd, latency_ms = EXCLUDED.latency_ms,
         metadata = EXCLUDED.metadata, finished_at = EXCLUDED.finished_at`,
      [runId, input.accountKey || null, input.workflowId || null, input.node || null, input.model || null,
        String(input.status || "UNKNOWN"), input.inputTokens ?? null, input.outputTokens ?? null,
        input.cachedInputTokens ?? null, input.costMicrousd ?? null, input.latencyMs ?? null,
        JSON.stringify(json(input.metadata, {})), input.startedAt ? new Date(input.startedAt).toISOString() : null,
        input.finishedAt ? new Date(input.finishedAt).toISOString() : null],
    );
    return { runId };
  }

  async function saveExperiment(input = {}) {
    const experimentId = String(input.experimentId || crypto.randomUUID());
    if (!input.accountKey || !input.name) throw new Error("Experiment requires accountKey and name");
    await store.query(
      `INSERT INTO experiments(experiment_id, account_key, name, status, hypothesis, variants, result, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,NOW())
       ON CONFLICT (experiment_id) DO UPDATE SET status = EXCLUDED.status, hypothesis = EXCLUDED.hypothesis,
         variants = EXCLUDED.variants, result = EXCLUDED.result, metadata = EXCLUDED.metadata, updated_at = NOW()`,
      [experimentId, String(input.accountKey), String(input.name), String(input.status || "DRAFT"), input.hypothesis || null,
        JSON.stringify(json(input.variants, [])), JSON.stringify(json(input.result, {})), JSON.stringify(json(input.metadata, {}))],
    );
    return { experimentId };
  }

  async function recordApproval(input = {}) {
    const approvalId = String(input.approvalId || crypto.randomUUID());
    if (!input.accountKey || !input.subjectType || !input.subjectId) throw new Error("Approval requires accountKey and subject");
    await store.query(
      `INSERT INTO approvals(approval_id, account_key, subject_type, subject_id, status, reviewer, source, decision_at, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW())
       ON CONFLICT (approval_id) DO UPDATE SET status = EXCLUDED.status, reviewer = EXCLUDED.reviewer,
         source = EXCLUDED.source, decision_at = EXCLUDED.decision_at, metadata = EXCLUDED.metadata, updated_at = NOW()`,
      [approvalId, String(input.accountKey), String(input.subjectType), String(input.subjectId), String(input.status || "PENDING"),
        input.reviewer || null, input.source || null, input.decisionAt ? new Date(input.decisionAt).toISOString() : null,
        JSON.stringify(json(input.metadata, {}))],
    );
    return { approvalId };
  }

  return {
    syncAccounts,
    recordSocialEvent,
    recordReply,
    saveDraft,
    recordPublishEnqueued,
    recordPublishState,
    upsertPost,
    recordAnalyticsSnapshot,
    saveContentBrief,
    recordAgentRun,
    saveExperiment,
    recordApproval,
    isReady: () => store.isReady(),
    health: () => store.health(),
  };
}

module.exports = { createDurableRepository };
