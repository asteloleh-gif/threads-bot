const test = require("node:test");
const assert = require("node:assert/strict");
const { isHumanLockMarker, contextualClosingRule } = require("../policy/replyBehavior");
const { createHumanLockStore } = require("../safety/humanLockStore");

test("v9.1.1d: // at start (after whitespace) is a human lock marker", () => {
  assert.equal(isHumanLockMarker("// Send me your catalog"), true);
  assert.equal(isHumanLockMarker("  // беру ветку"), true);
  assert.equal(isHumanLockMarker("hello // not a marker"), false);
  assert.equal(isHumanLockMarker("/ not enough"), false);
});

test("v9.1.1d: human lock store exposes branch-scoped fail-closed API", () => {
  const store = createHumanLockStore({ redisUrl: "redis://example.invalid:6379", ttlSeconds: 86400 });
  assert.equal(typeof store.init, "function");
  assert.equal(typeof store.lock, "function");
  assert.equal(typeof store.isLocked, "function");
  assert.equal(store.isReady(), false);
  assert.equal(store.health().ttlSeconds, 86400);
});

test("v9.1.2: final budget reply does not mechanically force DM", () => {
  const rule = contextualClosingRule({ isFinalBudgetReply: true });
  assert.match(rule, /НЕ отправляй в DM автоматически/);
  assert.match(rule, /только если это действительно полезно по контексту/);
  assert.match(rule, /не повторяй CTA/);
});

test("v9.1.2: non-final replies also avoid unnecessary DM CTA", () => {
  const rule = contextualClosingRule({ isFinalBudgetReply: false });
  assert.match(rule, /Не отправляй пользователя в личные сообщения без контекстной необходимости/);
  assert.match(rule, /не повторяй CTA/);
});
