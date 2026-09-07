const test = require("node:test");
const assert = require("node:assert/strict");

const { deriveGraphNode, GRAPH_STATUS, makeBranchKey } = require("../graph/conversationGraph");
const { resolveParentForRouting } = require("../router/parentResolver");
const { routeComment } = require("../router/conversationRouter");

const OWNER_ID = "leo-id";
const OWNER_USERNAME = "leoakastel";

function baseNode(overrides = {}) {
  return {
    commentId: "c1",
    parentId: "root-1",
    rootId: "root-1",
    authorId: "user-a",
    username: "userA",
    text: "hello",
    ownerUserId: OWNER_ID,
    ownerUsername: OWNER_USERNAME,
    parentAuthorId: OWNER_ID,
    parentAuthorUsername: OWNER_USERNAME,
    ...overrides,
  };
}

test("v9.1.1b: direct root comment starts a branch", () => {
  const node = deriveGraphNode(baseNode());
  assert.equal(node.relationshipStatus, GRAPH_STATUS.RESOLVED);
  assert.equal(node.branchKey, makeBranchKey("root-1", "c1"));
});

test("v9.1.1b: child inherits parent branch", () => {
  const parentNode = deriveGraphNode(baseNode());
  const child = deriveGraphNode(baseNode({
    commentId: "c2",
    parentId: "c1",
    parentNode,
    parentAuthorId: "user-a",
    parentAuthorUsername: "userA",
  }));
  assert.equal(child.relationshipStatus, GRAPH_STATUS.RESOLVED);
  assert.equal(child.branchKey, parentNode.branchKey);
});

test("v9.1.1b: two branches by same user under same root stay isolated", () => {
  const a = deriveGraphNode(baseNode({ commentId: "a1" }));
  const b = deriveGraphNode(baseNode({ commentId: "b1" }));
  assert.notEqual(a.branchKey, b.branchKey);
  assert.equal(a.rootId, b.rootId);
  assert.equal(a.authorId, b.authorId);
});

test("v9.1.1b: child-before-parent becomes PENDING_RELATIONSHIP", () => {
  const child = deriveGraphNode(baseNode({
    commentId: "child-1",
    parentId: "missing-parent",
    parentAuthorId: null,
    parentAuthorUsername: null,
    parentNode: null,
  }));
  assert.equal(child.branchKey, null);
  assert.equal(child.relationshipStatus, GRAPH_STATUS.PENDING_RELATIONSHIP);
});

test("v9.1.1b: graph routing can resolve known parent without Meta lookup", async () => {
  let metaCalls = 0;
  const graphParent = {
    commentId: "parent-1",
    authorId: OWNER_ID,
    username: OWNER_USERNAME,
    branchKey: makeBranchKey("root-1", "user-head"),
  };
  const safety = {
    async isBotGeneratedId() { return false; },
    async getGraphNode(id) { return id === "parent-1" ? graphParent : null; },
    async recordGraphNode(input) { return { ...input, branchKey: graphParent.branchKey, relationshipStatus: GRAPH_STATUS.RESOLVED }; },
    isSelfAuthored() { return false; },
  };
  const threads = {
    getParentId(c) { return c.parentId; },
    getCommentId(c) { return c.id; },
    getRootPostId() { return "root-1"; },
    getAuthorId() { return "user-a"; },
    getAuthorUsername() { return "userA"; },
    getCommentText() { return "follow up"; },
    async resolveParentAuthor() { metaCalls += 1; throw new Error("should not call Meta"); },
  };

  const parent = await resolveParentForRouting(
    { id: "child-2", parentId: "parent-1" },
    {
      safety,
      threads,
      ownerUsername: OWNER_USERNAME,
      ownerUserId: OWNER_ID,
      graphRoutingEnabled: true,
    }
  );

  assert.equal(parent.source, "conversation-graph");
  assert.equal(metaCalls, 0);
  const route = routeComment({
    authorId: "user-a",
    authorUsername: "userA",
    ownerUserId: OWNER_ID,
    ownerUsername: OWNER_USERNAME,
    rootId: "root-1",
    parentId: parent.parentId,
    parentAuthorId: parent.parentAuthorId,
    parentAuthorUsername: parent.parentAuthorUsername,
    text: "follow up",
  });
  assert.deepEqual(route, { allow: true, reason: "DIRECT_REPLY_TO_OWNER" });
});

test("v9.1.1b: shadow mode keeps existing Meta fallback", async () => {
  let metaCalls = 0;
  const safety = {
    async isBotGeneratedId() { return false; },
    async getGraphNode() { return { authorId: OWNER_ID, username: OWNER_USERNAME }; },
  };
  const threads = {
    getParentId(c) { return c.parentId; },
    async resolveParentAuthor(c) {
      metaCalls += 1;
      return { parentId: c.parentId, parentAuthorId: "user-b", parentAuthorUsername: "userB", source: "api" };
    },
  };

  const parent = await resolveParentForRouting(
    { id: "child-3", parentId: "parent-2" },
    { safety, threads, ownerUsername: OWNER_USERNAME, ownerUserId: OWNER_ID, graphRoutingEnabled: false }
  );

  assert.equal(metaCalls, 1);
  assert.equal(parent.source, "api");
});
