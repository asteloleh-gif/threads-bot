function basicFilter(candidate, selfUsername) {
  const text = String(candidate?.text || "").trim();
  if (!candidate?.sourcePostId || text.length < 20 || text.length > 1500) return false;
  if (selfUsername && String(candidate.authorUsername || "").toLowerCase() === String(selfUsername).toLowerCase()) return false;
  if (/^(https?:\/\/\S+|[#@]\S+)$/i.test(text)) return false;
  return true;
}

function createCopilotRunner({ config, monitors, monitorService, state, ai, approval, threads, selfUsername, logger = console } = {}) {
  let searchTimer = null;
  let approvalTimer = null;
  let searchRunning = false;
  let approvalRunning = false;

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
      for (const monitor of monitors) {
        const result = await monitorService.runOnce(monitor, { maxPostAgeMinutes: config.maxPostAgeMinutes });
        if (result.status === "ok") found.push(...result.candidates);
        else if (result.reason !== "MONITOR_DISABLED") logger.warn("Proactive monitor skipped", JSON.stringify({ monitorId: monitor.id, reason: result.reason || result.status }));
      }
      const filtered = found.filter(item => basicFilter(item, selfUsername));
      const quota = await state.takeQuota("evaluations", Math.min(filtered.length, 25), config.dailyEvaluationLimit);
      const candidates = filtered.slice(0, quota.granted);
      if (!candidates.length) return { status: "ok", discovered: found.length, evaluated: 0, submitted: 0 };
      const ranked = await ai.rank(candidates);
      if (ranked.status !== "ok") return ranked;
      const draftQuota = await state.takeQuota("drafts", 1, config.dailyDraftLimit);
      if (!draftQuota.granted || !ranked.ranked.length) return { status: "ok", discovered: found.length, evaluated: candidates.length, submitted: 0 };
      const best = ranked.ranked[0];
      const generated = await ai.draft(best.candidate, best.language);
      if (generated.status !== "ok") return generated;
      const submitted = await approval.submit({
        postId: String(best.candidate.sourcePostId),
        language: generated.language,
        sourceText: best.candidate.text,
        permalink: best.candidate.permalink || "",
        text: generated.text,
      });
      if (submitted.status !== "ok") return submitted;
      const saved = await state.savePending({
        draftId: submitted.id,
        postId: String(best.candidate.sourcePostId),
        language: generated.language,
        text: generated.text,
        permalink: best.candidate.permalink || "",
      });
      if (!saved) return { status: "failed", reason: "PENDING_STORE_ERROR" };
      return { status: "ok", discovered: found.length, evaluated: candidates.length, submitted: 1, draftId: submitted.id };
    } finally { searchRunning = false; }
  }

  async function start() {
    if (!config.enabled || config.mode !== "COPILOT") return { status: "skipped", reason: "COPILOT_DISABLED" };
    const init = await state.init();
    if (!init.ready) return { status: "failed", reason: init.reason };
    await processPending();
    const first = await runSearch();
    searchTimer = setInterval(() => runSearch().then(result => logger.log("Proactive search cycle", JSON.stringify(result))).catch(error => logger.error("Proactive search error", error?.message || String(error))), config.pollIntervalSeconds * 1000);
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
