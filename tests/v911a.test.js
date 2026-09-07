const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveParentForRouting } = require("../router/parentResolver");
const { routeComment } = require("../router/conversationRouter");

const OWNER_ID = "leo-id";
const OWNER_USERNAME = "leoakastel";

function makeThreads({ lookupResult, lookupError } = {}) {
  let lookupCalls = 0;
  return {
    getParentId(c) { return c.parentId || null; },
    async resolveParentAuthor(c) {
      lookupCalls += 1;
      if (lookupError) throw lookupError;
      return lookupResult || {
        parentId: c.parentId || null,
        parentAuthorId: null,
        parentAuthorUsername: null,
        source: "lookup-failed",
      };
    },
    get lookupCalls() { return lookupCalls; },
  };
}

function makeSafety(knownIds = []) {
  const known = new Set(knownIds.map(String));
  return {
    async isBotGeneratedId(id) { return known.has(String(id)); },
  };
}

test("v9.1.1a: known bot parent resolves locally and bypasses Meta lookup", async () => {
  const threads = makeThreads({ lookupError: new Error("Meta 500 / code 100") });
  const safety = makeSafety(["bot-reply-1"]);

  const parent = await resolveParentForRouting(
    { id: "user-comment-2", parentId: "bot-reply-1" },
    {
      safety,
      threads,
      ownerUsername: OWNER_USERNAME,
      ownerUserId: OWNER_ID,
      lookupEnabled: true,
    }
  );

  assert.equal(parent.parentId, "bot-reply-1");
  assert.equal(parent.parentAuthorId, OWNER_ID);
  assert.equal(parent.parentAuthorUsername, OWNER_USERNAME);
  assert.equal(parent.source, "redis-bot-id");
  assert.equal(threads.lookupCalls, 0);

  const route = routeComment({
    authorId: "user-a",
    authorUsername: "userA",
    ownerUserId: OWNER_ID,
    ownerUsername: OWNER_USERNAME,
    rootId: "root-1",
    parentId: parent.parentId,
    parentAuthorId: parent.parentAuthorId,
    parentAuthorUsername: parent.parentAuthorUsername,
    text: "how is going?",
  });

  assert.deepEqual(route, { allow: true, reason: "DIRECT_REPLY_TO_OWNER" });
});

test("v9.1.1a: unknown parent still falls back to existing Meta resolver", async () => {
  const threads = makeThreads({
    lookupResult: {
      parentId: "other-user-comment",
      parentAuthorId: "user-b",
      parentAuthorUsername: "userB",
      source: "api",
    },
  });
  const safety = makeSafety();

  const parent = await resolveParentForRouting(
    { id: "comment-c", parentId: "other-user-comment" },
    { safety, threads, ownerUsername: OWNER_USERNAME, ownerUserId: OWNER_ID }
  );

  assert.equal(threads.lookupCalls, 1);
  const route = routeComment({
    authorId: "user-a",
    authorUsername: "userA",
    ownerUserId: OWNER_ID,
    ownerUsername: OWNER_USERNAME,
    rootId: "root-1",
    parentId: parent.parentId,
    parentAuthorId: parent.parentAuthorId,
    parentAuthorUsername: parent.parentAuthorUsername,
    text: "reply to B",
  });

  assert.deepEqual(route, { allow: false, reason: "OTHER_USER_REPLY" });
});

test("v9.1.1a: unresolved nested parent remains fail-conservative", async () => {
  const threads = makeThreads();
  const safety = makeSafety();

  const parent = await resolveParentForRouting(
    { id: "comment-x", parentId: "unknown-parent" },
    { safety, threads, ownerUsername: OWNER_USERNAME, ownerUserId: OWNER_ID }
  );

  const route = routeComment({
    authorId: "user-a",
    authorUsername: "userA",
    ownerUserId: OWNER_ID,
    ownerUsername: OWNER_USERNAME,
    rootId: "root-1",
    parentId: parent.parentId,
    parentAuthorId: parent.parentAuthorId,
    parentAuthorUsername: parent.parentAuthorUsername,
    text: "nested reply",
  });

  assert.deepEqual(route, { allow: false, reason: "UNKNOWN_PARENT" });
});

test("v9.1.1a: Redis lookup error fails closed instead of calling Meta", async () => {
  const threads = makeThreads({
    lookupResult: {
      parentId: "bot-reply-2",
      parentAuthorId: OWNER_ID,
      parentAuthorUsername: OWNER_USERNAME,
      source: "api",
    },
  });
  const safety = {
    async isBotGeneratedId() { throw new Error("Redis unavailable"); },
  };

  await assert.rejects(
    resolveParentForRouting(
      { id: "comment-y", parentId: "bot-reply-2" },
      { safety, threads, ownerUsername: OWNER_USERNAME, ownerUserId: OWNER_ID }
    ),
    /Redis unavailable/
  );
  assert.equal(threads.lookupCalls, 0);
});
