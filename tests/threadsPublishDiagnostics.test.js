const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeMetaError } = require("../adapters/threadsAdapter");

test("Threads publish diagnostics keep useful Meta fields and never expose secrets", () => {
  const safe = sanitizeMetaError({
    message: "Publish failed access_token=SECRET123&foo=bar Bearer TOKEN456",
    type: "OAuthException",
    code: 24,
    error_subcode: 2207001,
    error_user_title: "Cannot publish",
    error_user_msg: "Try again later",
    fbtrace_id: "trace-123",
    access_token: "DO_NOT_LOG",
    debug_info: { token: "DO_NOT_LOG_EITHER" },
  });

  assert.deepEqual(safe, {
    message: "Publish failed access_token=[REDACTED]&foo=bar Bearer [REDACTED]",
    type: "OAuthException",
    code: 24,
    error_subcode: 2207001,
    error_user_title: "Cannot publish",
    error_user_msg: "Try again later",
    fbtrace_id: "trace-123",
  });

  assert.equal(JSON.stringify(safe).includes("SECRET123"), false);
  assert.equal(JSON.stringify(safe).includes("TOKEN456"), false);
  assert.equal(JSON.stringify(safe).includes("DO_NOT_LOG"), false);
});
