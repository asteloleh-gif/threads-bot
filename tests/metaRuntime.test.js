const test = require("node:test");
const assert = require("node:assert/strict");

test("composed Meta runtime loads platform pollers without starting listeners", () => {
  const runtime = require("../server-meta-runtime");
  assert.equal(typeof runtime.start, "function");
  assert.equal(Array.isArray(runtime.instagramPollers), true);
  assert.equal(Array.isArray(runtime.facebookPollers), true);
  assert.equal(Array.isArray(runtime.threadsPollers), true);
  assert.equal(typeof runtime.app, "function");
});
