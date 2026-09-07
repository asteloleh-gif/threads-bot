const test = require("node:test");
const assert = require("node:assert/strict");

const { createThreadsAdapter } = require("../adapters/threadsAdapter");
const { resolveParentForRouting } = require("../router/parentResolver");
const { routeComment } = require("../router/conversationRouter");
const { deriveGraphNode, GRAPH_STATUS } = require("../graph/conversationGraph");

const OWNER_ID = "27979923121676296";
const OWNER_USERNAME = "leoakastel";

test("v9.1.1c.1: moderate webhook preserves target_id on reply event", () => {
  const threads = createThreadsAdapter({ accessToken: null, userId: OWNER_ID });
  const events = threads.parseWebhook({
    app_id: "app-1",
    target_id: "owner-reply-post-1",
    topic: "moderate",
    values: [{
      field: "replies",
      value: {
        id: "external-comment-1",
        text: "I manufacture carbon fiber parts",
        username: "supplier",
        root_post: { id: "upstream-root-1" },
        replied_to: { id: "owner-reply-post-1" },
      },
    }],
  });

  assert.equal(events.length, 1);
  assert.equal(threads.getWebhookTargetId(events[0]), "owner-reply-post-1");
  assert.equal(threads.getParentId(events[0]), "owner-reply-post-1");
  assert.equal(threads.getRootPostId(events[0]), "upstream-root-1");
});

test("v9.1.1c.1: webhook target owner media bypasses failing parent lookup when owner post is itself a reply", async () => {
  let lookupCalls = 0;
  const threads = {
    getParentId: c => c.parentId,
    getWebhookTargetId: c => c.targetId,
    async resolveParentAuthor() {
      lookupCalls += 1;
      return { parentId: "owner-reply-post-1", parentAuthorId: null, parentAuthorUsername: null, source: "lookup-failed" };
    },
  };
  const safety = {
    async isBotGeneratedId() { return false; },
  };

  const parent = await resolveParentForRouting(
    { id: "external-comment-1", parentId: "owner-reply-post-1", targetId: "owner-reply-post-1" },
    { safety, threads, ownerUsername: OWNER_USERNAME, ownerUserId: OWNER_ID }
  );

  assert.equal(lookupCalls, 0);
  assert.deepEqual(parent, {
    parentId: "owner-reply-post-1",
    parentAuthorId: OWNER_ID,
    parentAuthorUsername: OWNER_USERNAME,
    source: "webhook-target-owner",
  });

  const route = routeComment({
    authorId: "supplier-id",
    authorUsername: "supplier",
    ownerUserId: OWNER_ID,
    ownerUsername: OWNER_USERNAME,
    rootId: "upstream-root-1",
    parentId: parent.parentId,
    parentAuthorId: parent.parentAuthorId,
    parentAuthorUsername: parent.parentAuthorUsername,
    text: "I manufacture carbon fiber parts",
  });
  assert.deepEqual(route, { allow: true, reason: "DIRECT_REPLY_TO_OWNER" });
});

test("v9.1.1c.1: owner target relationship resolves Graph branch even when root_post differs from replied_to", () => {
  const node = deriveGraphNode({
    commentId: "external-comment-1",
    parentId: "owner-reply-post-1",
    rootId: "upstream-root-1",
    authorId: "supplier-id",
    username: "supplier",
    text: "I manufacture carbon fiber parts",
    parentAuthorId: OWNER_ID,
    parentAuthorUsername: OWNER_USERNAME,
    ownerUserId: OWNER_ID,
    ownerUsername: OWNER_USERNAME,
  });

  assert.equal(node.relationshipStatus, GRAPH_STATUS.RESOLVED);
  assert.equal(node.branchKey, "root:upstream-root-1|branch:external-comment-1");
});

test("v9.1.1c.1: mismatched webhook target does not grant owner relationship", async () => {
  let lookupCalls = 0;
  const threads = {
    getParentId: c => c.parentId,
    getWebhookTargetId: c => c.targetId,
    async resolveParentAuthor(c) {
      lookupCalls += 1;
      return { parentId: c.parentId, parentAuthorId: null, parentAuthorUsername: null, source: "lookup-failed" };
    },
  };
  const safety = {
    async isBotGeneratedId() { return false; },
  };

  const parent = await resolveParentForRouting(
    { parentId: "some-other-parent", targetId: "owner-target" },
    { safety, threads, ownerUsername: OWNER_USERNAME, ownerUserId: OWNER_ID }
  );

  assert.equal(lookupCalls, 1);
  assert.equal(parent.source, "lookup-failed");
  assert.equal(parent.parentAuthorId, null);
});
