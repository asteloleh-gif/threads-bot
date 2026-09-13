const test = require("node:test");
const assert = require("node:assert/strict");

test("unified Meta entrypoint loads without starting network listeners", () => {
  const entry = require("../server-meta");
  assert.equal(typeof entry.start, "function");
  assert.equal(typeof entry.metaWebhookRouter.dispatch, "function");
  assert.equal(typeof entry.metaWebhookRouter.verify, "function");
  assert.equal(typeof entry.handleThreadsWebhook, "function");
  assert.equal(typeof entry.handleSecondaryWebhook, "function");
  assert.equal(entry.app?.listen instanceof Function, true);
});
