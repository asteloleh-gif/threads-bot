const test = require("node:test");
const assert = require("node:assert/strict");
const { createContentControl } = require("../app/content/contentControl");

const TOKEN = "0123456789abcdef0123456789abcdef";

function store() {
  const records = new Map();
  let ready = false;
  return {
    async init() { ready = true; return { ready: true }; },
    isReady: () => ready,
    async begin(operation, key) {
      const id = `${operation}:${key}`;
      if (records.has(id)) return { claimed: false, reason: "DUPLICATE", existing: records.get(id) };
      records.set(id, { status: "PROCESSING" });
      return { claimed: true };
    },
    async complete(operation, key, result) { records.set(`${operation}:${key}`, { status: "COMPLETED", result }); return true; },
    async fail(operation, key, reason) { records.set(`${operation}:${key}`, { status: "FAILED", reason }); return true; },
    async close() { ready = false; },
    health: () => ({ connected: ready }),
  };
}

function runtime() {
  let dryRuns = 0;
  return {
    get dryRuns() { return dryRuns; },
    health: () => ({ enabled: true, ready: true, e2eDryRun: { available: true, publishEngineDryRun: true } }),
    async getBrief(id) { return id === "b1" ? { briefId: id, status: "CREATED" } : null; },
    async getDraft(id) { return id === "d1" ? { draftId: id, status: "SCHEDULED" } : null; },
    async getWorkflowSnapshot({ draftId }) {
      if (draftId !== "d1") throw new Error("Draft not found");
      return { draft: { draftId, status: "SCHEDULED" }, publish: { status: "SIMULATED" } };
    },
    async runEndToEndDryRun(input) { dryRuns += 1; return { status: "simulated", accountKey: input.accountKey, jobId: "j1" }; },
    async generateBrief() { return { status: "ok" }; },
    async generateDraft() { return { status: "ok" }; },
    async reviewDraft() { return { status: "ok" }; },
    async decideApproval() { return { status: "APPROVED" }; },
    async scheduleApprovedDraft() { return { status: "SCHEDULED" }; },
  };
}

test("private operator reads are authenticated, read-only and do not require idempotency keys", async () => {
  const rt = runtime();
  const control = createContentControl({ enabled: true, token: TOKEN, runtime: rt, store: store() });
  await control.init();

  const brief = await control.read({ resource: "brief", input: { briefId: "b1" } });
  const workflow = await control.read({ resource: "workflow", input: { draftId: "d1" } });
  const missing = await control.read({ resource: "brief", input: { briefId: "missing" } });

  assert.equal(control.authenticate(`Bearer ${TOKEN}`), true);
  assert.equal(brief.httpStatus, 200);
  assert.equal(brief.body.status, "CREATED");
  assert.equal(workflow.httpStatus, 200);
  assert.equal(workflow.body.publish.status, "SIMULATED");
  assert.equal(missing.httpStatus, 404);
});

test("private end-to-end dry-run remains a mutation and is idempotent", async () => {
  const rt = runtime();
  const control = createContentControl({ enabled: true, token: TOKEN, runtime: rt, store: store() });
  await control.init();

  const first = await control.run({ operation: "runEndToEndDryRun", idempotencyKey: "e2e-1", input: { accountKey: "leo:threads" } });
  const replay = await control.run({ operation: "runEndToEndDryRun", idempotencyKey: "e2e-1", input: { accountKey: "leo:threads" } });

  assert.equal(first.httpStatus, 200);
  assert.equal(first.body.status, "simulated");
  assert.equal(replay.httpStatus, 200);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(rt.dryRuns, 1);
});
