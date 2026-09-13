const test = require("node:test");
const assert = require("node:assert/strict");
const { createHyperCrewOrchestrator } = require("../app/orchestration/hyperCrewOrchestrator");
const { validateCrewGraph, DEFAULT_CONTENT_CREW_GRAPH } = require("../app/orchestration/crewGraph");

function durableStub({ fail = false } = {}) {
  const runs = [];
  return {
    runs,
    isReady: () => true,
    async recordAgentRun(run) {
      if (fail) throw new Error("telemetry unavailable");
      runs.push({ ...run });
      return { runId: run.runId };
    },
  };
}

function runtimeStub({ reviewDecision = "PASS", ready = true } = {}) {
  const calls = [];
  let forbiddenCalls = 0;
  return {
    calls,
    get forbiddenCalls() { return forbiddenCalls; },
    health: () => ({ enabled: true, ready }),
    async generateBrief(input) {
      calls.push(["generateBrief", input]);
      return { status: "ok", workflowStatus: "CREATED", workflowId: "workflow-1", briefId: "brief-1" };
    },
    async generateDraft(input) {
      calls.push(["generateDraft", input]);
      return { status: "ok", workflowStatus: "DRAFT", draftId: "draft-1" };
    },
    async reviewDraft(input) {
      calls.push(["reviewDraft", input]);
      if (reviewDecision === "PASS") {
        return {
          status: "ok",
          workflowStatus: "AWAITING_APPROVAL",
          approvalId: "approval-1",
          review: { decision: "PASS", notes: "ok", risks: [] },
        };
      }
      return {
        status: "ok",
        workflowStatus: reviewDecision === "REVISE" ? "REVISE" : "REJECTED",
        review: { decision: reviewDecision, notes: "stop", risks: [] },
      };
    },
    async decideApproval() { forbiddenCalls += 1; throw new Error("must never auto-approve"); },
    async scheduleApprovedDraft() { forbiddenCalls += 1; throw new Error("must never auto-schedule"); },
  };
}

test("Hyper Crew graph has a non-autonomous human approval hard gate and owns no external mutation", () => {
  assert.equal(validateCrewGraph(DEFAULT_CONTENT_CREW_GRAPH), true);
  const approval = DEFAULT_CONTENT_CREW_GRAPH.find(node => node.id === "human-approval");
  assert.equal(approval.kind, "hard-gate");
  assert.equal(approval.autonomous, false);
  assert.equal(DEFAULT_CONTENT_CREW_GRAPH.some(node => node.externalMutation === true), false);
});

test("Hyper Crew graph rejects autonomous external mutation ownership", () => {
  assert.throws(() => validateCrewGraph([
    { id: "research", kind: "agent", dependsOn: [], externalMutation: true },
    { id: "human-approval", kind: "hard-gate", autonomous: false, dependsOn: ["research"], externalMutation: false },
  ]), /cannot own external mutation/);
});

test("disabled Hyper Crew initializes without touching Content Runtime or durable state", async () => {
  const runtime = runtimeStub();
  const durable = durableStub();
  const crew = createHyperCrewOrchestrator({ enabled: false, contentRuntime: runtime, durable });
  assert.deepEqual(await crew.init(), { status: "skipped", reason: "HYPER_CREW_DISABLED" });
  assert.equal(crew.health().enabled, false);
  assert.equal(crew.health().ready, false);
  assert.equal(runtime.calls.length, 0);
  assert.equal(durable.runs.length, 0);
});

test("enabled Hyper Crew fails closed unless Content Runtime is already ready", async () => {
  const crew = createHyperCrewOrchestrator({
    enabled: true,
    contentRuntime: runtimeStub({ ready: false }),
    durable: durableStub(),
  });
  await assert.rejects(() => crew.init(), /CONTENT_RUNTIME_NOT_READY/);
  assert.equal(crew.health().ready, false);
});

test("Hyper Crew coordinates research, strategist, writer and reviewer then stops at human approval", async () => {
  const runtime = runtimeStub();
  const durable = durableStub();
  const crew = createHyperCrewOrchestrator({
    enabled: true,
    contentRuntime: runtime,
    durable,
    uuid: () => "crew-run-1",
    now: () => new Date("2026-09-13T17:00:00.000Z"),
  });
  await crew.init();
  const result = await crew.runToApproval({
    accountKey: "LeoAkastel:Threads",
    objective: "Teach one supported idea",
    research: [{ fact: "supported", source: "operator" }],
    language: "en",
  });

  assert.equal(result.status, "AWAITING_HUMAN_APPROVAL");
  assert.equal(result.workflowId, "workflow-1");
  assert.equal(result.briefId, "brief-1");
  assert.equal(result.draftId, "draft-1");
  assert.equal(result.approvalId, "approval-1");
  assert.deepEqual(runtime.calls.map(([name]) => name), ["generateBrief", "generateDraft", "reviewDraft"]);
  assert.equal(runtime.forbiddenCalls, 0);
  assert.equal(runtime.calls[0][1].accountKey, "leoakastel:threads");
  assert.equal(runtime.calls[0][1].metadata.crewRunId, "crew-run-1");
  assert.deepEqual(result.stages.map(stage => stage.node), [
    "research",
    "content-strategist",
    "copywriter",
    "content-reviewer",
    "human-approval",
  ]);
  assert.equal(result.stages.at(-1).status, "WAITING");
  assert.equal(durable.runs.at(-1).status, "AWAITING_HUMAN_APPROVAL");
  assert.equal(durable.runs.at(-1).workflowId, "workflow-1");
  assert.equal(durable.runs.at(-1).metadata.humanApprovalAutonomous, false);
  assert.equal(durable.runs.at(-1).metadata.externalMutationOwnedByCrew, false);
});

test("review REVISE stops Hyper Crew before any approval or scheduling action", async () => {
  const runtime = runtimeStub({ reviewDecision: "REVISE" });
  const durable = durableStub();
  const crew = createHyperCrewOrchestrator({ enabled: true, contentRuntime: runtime, durable, uuid: () => "crew-run-2" });
  await crew.init();
  const result = await crew.runToApproval({ accountKey: "leo:threads", objective: "draft", research: [] });

  assert.equal(result.status, "STOPPED");
  assert.equal(result.stoppedAt, "content-reviewer");
  assert.equal(result.reviewDecision, "REVISE");
  assert.equal(runtime.forbiddenCalls, 0);
  assert.equal(durable.runs.at(-1).status, "STOPPED");
});

test("durable orchestration telemetry failure halts the crew before the next agent stage", async () => {
  const runtime = runtimeStub();
  const crew = createHyperCrewOrchestrator({
    enabled: true,
    contentRuntime: runtime,
    durable: durableStub({ fail: true }),
    uuid: () => "crew-run-3",
  });
  await crew.init();
  await assert.rejects(
    () => crew.runToApproval({ accountKey: "leo:threads", objective: "draft", research: [] }),
    /telemetry unavailable/,
  );
  assert.deepEqual(runtime.calls.map(([name]) => name), ["generateBrief"]);
  assert.equal(runtime.forbiddenCalls, 0);
});
