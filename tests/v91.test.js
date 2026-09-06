const test = require("node:test");
const assert = require("node:assert/strict");
const { routeComment, hasExplicitMention } = require("../router/conversationRouter");
const { loadPolicy } = require("../config/policy");

const owner = { ownerUserId: "leo-id", ownerUsername: "leoakastel", rootId: "post-1" };

function route(extra = {}) {
  return routeComment({
    ...owner,
    authorId: "user-a",
    authorUsername: "userA",
    parentId: "post-1",
    parentAuthorId: "leo-id",
    parentAuthorUsername: "leoakastel",
    text: "hello",
    ...extra,
  });
}

test("direct reply to owner is allowed", () => {
  assert.deepEqual(route(), { allow: true, reason: "DIRECT_REPLY_TO_OWNER" });
});

test("direct root comment is allowed even without parent author metadata", () => {
  assert.deepEqual(route({ parentAuthorId: null, parentAuthorUsername: null }), { allow: true, reason: "OWNER_ROOT_COMMENT" });
});

test("A to B is skipped", () => {
  assert.deepEqual(route({ parentId: "comment-b", parentAuthorId: "user-b", parentAuthorUsername: "userB" }), { allow: false, reason: "OTHER_USER_REPLY" });
});

test("explicit owner mention overrides A to B routing", () => {
  assert.deepEqual(route({ parentId: "comment-b", parentAuthorId: "user-b", parentAuthorUsername: "userB", text: "@leoakastel what do you think?" }), { allow: true, reason: "EXPLICIT_OWNER_MENTION" });
});

test("self-authored event is skipped", () => {
  assert.deepEqual(route({ authorId: "leo-id", authorUsername: "leoakastel" }), { allow: false, reason: "SELF_COMMENT" });
});

test("unknown nested relationship is skipped conservatively", () => {
  assert.deepEqual(route({ parentId: "comment-x", parentAuthorId: null, parentAuthorUsername: null }), { allow: false, reason: "UNKNOWN_PARENT" });
});

test("mention matching does not accept username prefix collisions", () => {
  assert.equal(hasExplicitMention("hey @leoakastel", "leoakastel"), true);
  assert.equal(hasExplicitMention("hey @leoakastel_fake", "leoakastel"), false);
});

test("policy defaults match frozen v9.1", () => {
  const p = loadPolicy({});
  assert.equal(p.normalReplyLimit, 3);
  assert.equal(p.cooldownSeconds, 20);
  assert.equal(p.conversationResetHours, 24);
  assert.equal(p.globalDailyLimit, 50);
  assert.equal(p.closingEnabled, true);
  assert.equal(p.closingAtReply, 3);
  assert.equal(p.redisRequired, true);
});

test("policy can be changed without changing router code", () => {
  const p = loadPolicy({ NORMAL_REPLY_LIMIT: "5", COOLDOWN_SECONDS: "30", GLOBAL_DAILY_LIMIT: "200", CLOSING_AT_REPLY: "5" });
  assert.equal(p.normalReplyLimit, 5);
  assert.equal(p.cooldownSeconds, 30);
  assert.equal(p.globalDailyLimit, 200);
  assert.equal(p.closingAtReply, 5);
});
