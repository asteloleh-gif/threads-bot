function basicFilter(candidate, selfUsername) {
  const text = String(candidate?.text || "").trim();
  if (!candidate?.sourcePostId || text.length < 8 || text.length > 1500) return false;
  if (selfUsername && String(candidate.authorUsername || "").toLowerCase() === String(selfUsername).toLowerCase()) return false;
  if (/^(https?:\/\/\S+|[#@]\S+)$/i.test(text)) return false;
  return true;
}

function createCopilotRunner({ config, monitors, monitorService, state, ai, approval, threads, selfUsername, logger = console } = {}) {
  let searchTimer = null;
  let approvalTimer = null;
  let searchRunning = false;
  let approvalRunning = false;
  const usageTokens = usage => Math.max(0, Number(usage?.total_tokens || 0) || (Number(usage?.prompt_tokens || 0) + Number(usage?.completion_tokens || 0)));
  const usageCostMicrousd = usage => Math.max(0, Math.ceil(Number(usage?.prompt_tokens || 0) * 0.2 + Number(usage?.completion_tokens || 0) * 1.2));

  async function sendSearchReport(result) {
    if (typeof approval.report !== "function") return;
    const payload = {
      status: String(result?.status || "failed"),
      reason: String(result?.reason || ""),
      scanned: Number(result?.scanned || 0),
      fresh: Number(result?.fresh || 0),
      eligible: Number(result?.eligible || 0),
      evaluated: Number(result?.evaluated || 0),
      submitted: Number(result?.submitted || 0),
      aiTokens: Number(result?.aiTokens || 0),
      aiCostMicrousd: Number(result?.aiCostMicrousd || 0),
    };
    const sent = await approval.report(payload);
    if (sent.status !== "ok") logger.warn("Proactive report skipped", JSON.stringify({ reason: sent.reason || sent.status }));
  }

  async function processPending() {
    if (approvalRunning) return { status: "skipped", reason: "ALREADY_RUNNING" };
    approvalRunning = true;
    const summary = { checked: 0, published: 0, skipped: 0, waiting: 0, failed: 0 };
    try {
      for (const item of await state.listPending(50)) {
        summary.checked += 1;
        const remote = await approval.get(item.draftId);
        if (remote.status !== "ok") { summary.failed += 1; continue; }
        const decision = remote.decision;
        if (!decision) { summary.waiting += 1; continue; }
        if (decision.action === "superseded" && decision.replacementId) {
          const replacement = await approval.get(decision.replacementId);
          if (replacement.status !== "ok" || !replacement.draft?.text) { summary.failed += 1; continue; }
          await state.savePending({ ...item, draftId: replacement.draft.id, text: replacement.draft.text, language: replacement.draft.language });
          await state.finishPending(item.draftId, { status: "superseded", replacementId: replacement.draft.id });
          summary.waiting += 1;
          continue;
        }
        if (decision.action === "skipped") {
          await state.finishPending(item.draftId, { status: "skipped" });
          summary.skipped += 1;
          continue;
        }
        if (decision.action !== "approved") { summary.failed += 1; continue; }
        if (!(await state.claimPublish(item.draftId))) { summary.waiting += 1; continue; }
        const published = await threads.reply(remote.draft.postId, remote.draft.text);
        await state.finishPending(item.draftId, { status: published.status, publishedId: published.id || null });
        if (published.status === "published") summary.published += 1;
        else summary.failed += 1;
      }
      return { status: "ok", ...summary };
    } finally { approvalRunning = false; }
  }

  async function runSearch() {
    if (searchRunning) return { status: "skipped", reason: "ALREADY_RUNNING" };
    if (!config.enabled || config.mode !== "COPILOT") return { status: "skipped", reason: "COPILOT_DISABLED" };
    if (!approval.configured()) return { status: "failed", reason: "APPROVAL_NOT_CONFIGURED" };
    searchRunning = true;
    try {
      const found = [];
      const stats = { scanned: 0, fresh: 0 };
      for (const monitor of monitors) {
        const result = await monitorService.runOnce(monitor, { maxPostAgeMinutes: config.maxPostAgeMinutes });
        if (result.status === "ok") {
          stats.scanned += Number(result.discovered || 0);
          stats.fresh += Number(result.accepted || 0);
          found.push(...result.candidates);
        }
        else if (result.reason !== "MONITOR_DISABLED") logger.warn("Proactive monitor skipped", JSON.stringify({ monitorId: monitor.id, reason: result.reason || result.status }));
      }
      const filtered = found.filter(item => basicFilter(item, selfUsername));
      const base = { ...stats, discovered: stats.scanned, eligible: filtered.length, aiTokens: 0, aiCostMicrousd: 0 };
      const quota = await state.takeQuota("evaluations", Math.min(filtered.length, 25), config.dailyEvaluationLimit);
      const candidates = filtered.slice(0, quota.granted);
      if (!candidates.length) return { status: "ok", ...base, evaluated: 0, submitted: 0 };
      const ranked = await ai.rank(candidates);
      const rankTokens = usageTokens(ranked.usage);
      const rankCost = usageCostMicrousd(ranked.usage);
      if (ranked.status !== "ok") return { ...ranked, ...base, evaluated: candidates.length, submitted: 0, aiTokens: rankTokens, aiCostMicrousd: rankCost };
      const draftQuota = await state.takeQuota("drafts", 1, config.dailyDraftLimit);
      if (!draftQuota.granted || !ranked.ranked.length) return { status: "ok", ...base, evaluated: candidates.length, submitted: 0, aiTokens: rankTokens, aiCostMicrousd: rankCost };
      const best = ranked.ranked[0];
      const generated = await ai.draft(best.candidate, best.language);
      const aiTokens = rankTokens + usageTokens(generated.usage);
      const aiCostMicrousd = rankCost + usageCostMicrousd(generated.usage);
      if (generated.status !== "ok") return { ...generated, ...base, evaluated: candidates.length, submitted: 0, aiTokens, aiCostMicrousd };
      const submitted = await approval.submit({
        postId: String(best.candidate.sourcePostId),
        language: generated.language,
        sourceText: best.candidate.text,
        permalink: best.candidate.permalink || "",
        text: generated.text,
      });
      if (submitted.status !== "ok") return { ...submitted, ...base, evaluated: candidates.length, submitted: 0, aiTokens, aiCostMicrousd };
      const saved = await state.savePending({
        draftId: submitted.id,
        postId: String(best.candidate.sourcePostId),
        language: generated.language,
        text: generated.text,
        permalink: best.candidate.permalink || "",
      });
      if (!saved) return { status: "failed", reason: "PENDING_STORE_ERROR", ...base, evaluated: candidates.length, submitted: 0, aiTokens, aiCostMicrousd };
      return { status: "ok", ...base, evaluated: candidates.length, submitted: 1, aiTokens, aiCostMicrousd, draftId: submitted.id };
    } finally { searchRunning = false; }
  }

  async function start() {
    if (!config.enabled || config.mode !== "COPILOT") return { status: "skipped", reason: "COPILOT_DISABLED" };
    const init = await state.init();
    if (!init.ready) return { status: "failed", reason: init.reason };
    await processPending();
    const first = await runSearch();
    await sendSearchReport(first);
    searchTimer = setInterval(() => runSearch().then(async result => {
      logger.log("Proactive search cycle", JSON.stringify(result));
      await sendSearchReport(result);
    }).catch(error => logger.error("Proactive search error", error?.message || String(error))), config.pollIntervalSeconds * 1000);
    approvalTimer = setInterval(() => processPending().then(result => {
      if (result.published || result.skipped || result.failed) logger.log("Proactive approval cycle", JSON.stringify(result));
    }).catch(error => logger.error("Proactive approval error", error?.message || String(error))), config.approvalPollSeconds * 1000);
    searchTimer.unref?.();
    approvalTimer.unref?.();
    return first;
  }

  async function close() {
    if (searchTimer) clearInterval(searchTimer);
    if (approvalTimer) clearInterval(approvalTimer);
    await state.close();
  }

  return { start, close, runSearch, processPending };
}

module.exports = { createCopilotRunner, basicFilter };
