const crypto = require("crypto");
const { DEFAULT_CONTENT_CREW_GRAPH, validateCrewGraph, publicCrewGraph } = require("./crewGraph");

function summarizeStage(stage) {
  return {
    node: stage.node,
    status: stage.status,
    reason: stage.reason || null,
  };
}

function createHyperCrewOrchestrator({
  enabled = false,
  contentRuntime,
  durable,
  graph = DEFAULT_CONTENT_CREW_GRAPH,
  uuid = () => crypto.randomUUID(),
  now = () => new Date(),
} = {}) {
  if (!contentRuntime) throw new Error("Hyper Crew requires Content Runtime");
  if (!durable || typeof durable.recordAgentRun !== "function") {
    throw new Error("Hyper Crew requires durable agent telemetry");
  }
  validateCrewGraph(graph);

  let ready = false;
  let lastError = null;
  let lastRun = null;

  async function init() {
    if (!enabled) return { status: "skipped", reason: "HYPER_CREW_DISABLED" };
    const content = contentRuntime.health?.() || {};
    if (!content.enabled || !content.ready) {
      lastError = "CONTENT_RUNTIME_NOT_READY";
      throw new Error(lastError);
    }
    if (typeof durable.isReady === "function" && !durable.isReady()) {
      lastError = "DURABLE_STORE_NOT_READY";
      throw new Error(lastError);
    }
    ready = true;
    lastError = null;
    return { status: "ok", reason: "READY" };
  }

  function requireReady() {
    if (!enabled) throw new Error("Hyper Crew is disabled");
    if (!ready) throw new Error("Hyper Crew is not ready");
  }

  async function recordCrewRun({ runId, accountKey, workflowId, status, stages, reason = null, startedAt }) {
    const finished = ["AWAITING_HUMAN_APPROVAL", "STOPPED", "FAILED"].includes(status);
    await durable.recordAgentRun({
      runId,
      accountKey,
      workflowId: workflowId || runId,
      node: "hyper-crew-orchestrator",
      model: null,
      status,
      metadata: {
        kind: "hyper-crew-orchestrator",
        graphVersion: "content-v1",
        reason,
        stages: stages.map(summarizeStage),
        humanApprovalAutonomous: false,
        externalMutationOwnedByCrew: false,
      },
      startedAt,
      finishedAt: finished ? now() : null,
    });
  }

  async function runToApproval({
    accountKey,
    objective,
    research = [],
    analytics = null,
    brand = null,
    language = "auto",
    constraints = {},
    policy = null,
    metadata = {},
  } = {}) {
    requireReady();
    const normalizedAccount = String(accountKey || "").trim().toLowerCase();
    const normalizedObjective = String(objective || "").trim();
    if (!normalizedAccount) throw new Error("Hyper Crew requires accountKey");
    if (!normalizedObjective) throw new Error("Hyper Crew requires objective");
    if (!Array.isArray(research)) throw new Error("Hyper Crew research must be an array");

    const runId = uuid();
    const startedAt = now();
    const stages = [{ node: "research", status: "READY", reason: research.length ? "SUPPLIED" : "EMPTY_INPUT" }];
    let workflowId = null;

    try {
      const brief = await contentRuntime.generateBrief({
        accountKey: normalizedAccount,
        objective: normalizedObjective,
        research,
        analytics,
        brand,
        language,
        metadata: { ...metadata, crewRunId: runId, orchestrator: "hyper-crew-v1" },
      });
      workflowId = brief?.workflowId || null;
      if (brief?.status !== "ok" || !brief.briefId) {
        stages.push({ node: "content-strategist", status: "STOPPED", reason: brief?.reason || brief?.status || "BRIEF_FAILED" });
        await recordCrewRun({ runId, accountKey: normalizedAccount, workflowId, status: "STOPPED", stages, reason: "BRIEF_FAILED", startedAt });
        lastRun = { runId, workflowId, status: "STOPPED", stoppedAt: "content-strategist" };
        return { ...lastRun, stages };
      }
      stages.push({ node: "content-strategist", status: "DONE" });
      await recordCrewRun({ runId, accountKey: normalizedAccount, workflowId, status: "RUNNING", stages, startedAt });

      const draft = await contentRuntime.generateDraft({
        briefId: brief.briefId,
        constraints,
        language,
        metadata: { ...metadata, crewRunId: runId, orchestrator: "hyper-crew-v1" },
      });
      if (draft?.status !== "ok" || !draft.draftId) {
        stages.push({ node: "copywriter", status: "STOPPED", reason: draft?.reason || draft?.status || "DRAFT_FAILED" });
        await recordCrewRun({ runId, accountKey: normalizedAccount, workflowId, status: "STOPPED", stages, reason: "DRAFT_FAILED", startedAt });
        lastRun = { runId, workflowId, status: "STOPPED", stoppedAt: "copywriter", briefId: brief.briefId };
        return { ...lastRun, stages };
      }
      stages.push({ node: "copywriter", status: "DONE" });
      await recordCrewRun({ runId, accountKey: normalizedAccount, workflowId, status: "RUNNING", stages, startedAt });

      const review = await contentRuntime.reviewDraft({
        draftId: draft.draftId,
        policy,
        metadata: { ...metadata, crewRunId: runId, orchestrator: "hyper-crew-v1" },
      });
      const decision = review?.review?.decision || null;
      if (review?.status !== "ok" || decision !== "PASS" || review?.workflowStatus !== "AWAITING_APPROVAL" || !review?.approvalId) {
        stages.push({ node: "content-reviewer", status: "STOPPED", reason: decision || review?.reason || review?.status || "REVIEW_NOT_PASS" });
        await recordCrewRun({ runId, accountKey: normalizedAccount, workflowId, status: "STOPPED", stages, reason: "REVIEW_NOT_PASS", startedAt });
        lastRun = {
          runId,
          workflowId,
          status: "STOPPED",
          stoppedAt: "content-reviewer",
          briefId: brief.briefId,
          draftId: draft.draftId,
          reviewDecision: decision,
        };
        return { ...lastRun, stages };
      }

      stages.push({ node: "content-reviewer", status: "DONE" });
      stages.push({ node: "human-approval", status: "WAITING", reason: "EXPLICIT_HUMAN_DECISION_REQUIRED" });
      await recordCrewRun({
        runId,
        accountKey: normalizedAccount,
        workflowId,
        status: "AWAITING_HUMAN_APPROVAL",
        stages,
        reason: "EXPLICIT_HUMAN_DECISION_REQUIRED",
        startedAt,
      });
      lastRun = {
        runId,
        workflowId,
        status: "AWAITING_HUMAN_APPROVAL",
        briefId: brief.briefId,
        draftId: draft.draftId,
        approvalId: review.approvalId,
        reviewDecision: decision,
      };
      return { ...lastRun, stages };
    } catch (error) {
      lastError = error?.message || String(error);
      stages.push({ node: "orchestrator", status: "FAILED", reason: "ORCHESTRATION_ERROR" });
      try {
        await recordCrewRun({
          runId,
          accountKey: normalizedAccount,
          workflowId,
          status: "FAILED",
          stages,
          reason: "ORCHESTRATION_ERROR",
          startedAt,
        });
      } catch (telemetryError) {
        lastError = `ORCHESTRATION_AND_TELEMETRY_FAILED: ${telemetryError?.message || String(telemetryError)}`;
      }
      throw error;
    }
  }

  async function close() {
    ready = false;
  }

  function health() {
    return {
      enabled: Boolean(enabled),
      ready: Boolean(ready),
      lastError,
      lastRun,
      graph: publicCrewGraph(graph),
      humanApprovalAutonomous: false,
      externalMutationOwnedByCrew: false,
      content: contentRuntime.health?.() || null,
    };
  }

  return {
    init,
    close,
    runToApproval,
    health,
  };
}

module.exports = { createHyperCrewOrchestrator };
