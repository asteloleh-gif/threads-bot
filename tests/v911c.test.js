const test = require("node:test");
const assert = require("node:assert/strict");
const { reconstructBranchMemory, estimateTokens } = require("../memory/reconstructBranchMemory");
const { componentEstimates, usageFromResponse } = require("../telemetry/aiUsage");

function graph(nodes) { const map = new Map(nodes.map(n => [n.commentId, n])); return id => Promise.resolve(map.get(String(id)) || null); }
function node(overrides = {}) { return { commentId: "c", parentId: null, rootId: "r", authorId: "u", username: "user", text: "hello", isOwner: false, isBotGenerated: false, branchKey: "root:r|branch:u1", relationshipStatus: "RESOLVED", createdAt: new Date().toISOString(), publishStatus: null, ...overrides }; }

test("v9.1.1c: same branch reconstructs user + confirmed published bot history", async () => {
  const u1 = node({ commentId: "u1", parentId: "r", text: "carbon fiber" });
  const b1 = node({ commentId: "b1", parentId: "u1", authorId: "leo", isOwner: true, isBotGenerated: true, text: "What type?", publishStatus: "PUBLISHED" });
  const u2 = node({ commentId: "u2", parentId: "b1", text: "automotive" });
  const current = node({ commentId: "u3", parentId: "u2", text: "BMW and Porsche" });
  const out = await reconstructBranchMemory({ currentNode: current, getGraphNode: graph([u1, b1, u2]) });
  assert.deepEqual(out.messages.map(m => [m.role, m.text]), [["user", "carbon fiber"], ["assistant", "What type?"], ["user", "automotive"]]);
});

test("v9.1.1c: sibling branch never leaks into memory", async () => {
  const foreign = node({ commentId: "x", branchKey: "root:r|branch:other", text: "electronics" });
  const current = node({ commentId: "u2", parentId: "x", text: "BMW" });
  const out = await reconstructBranchMemory({ currentNode: current, getGraphNode: graph([foreign]) });
  assert.equal(out.messages.length, 0);
});

test("v9.1.1c: failed or ambiguous bot text is excluded", async () => {
  const failed = node({ commentId: "b1", parentId: "u1", isOwner: true, isBotGenerated: true, text: "draft failed", publishStatus: "AMBIGUOUS" });
  const user = node({ commentId: "u1", parentId: "r", text: "hello" });
  const current = node({ commentId: "u2", parentId: "b1", text: "again" });
  const out = await reconstructBranchMemory({ currentNode: current, getGraphNode: graph([failed, user]) });
  assert.deepEqual(out.messages.map(m => m.text), ["hello"]);
});

test("v9.1.1c: current comment is not duplicated into history", async () => {
  const current = node({ commentId: "u2", parentId: "u1", text: "current" });
  const prior = node({ commentId: "u1", parentId: "r", text: "prior" });
  const out = await reconstructBranchMemory({ currentNode: current, getGraphNode: graph([prior, current]) });
  assert.deepEqual(out.messages.map(m => m.text), ["prior"]);
});

test("v9.1.1c: pending relationship produces no memory", async () => {
  const current = node({ relationshipStatus: "PENDING_RELATIONSHIP", branchKey: null });
  const out = await reconstructBranchMemory({ currentNode: current, getGraphNode: graph([]) });
  assert.equal(out.reason, "UNRESOLVED_BRANCH"); assert.equal(out.messages.length, 0);
});

test("v9.1.1c: message limit keeps newest history in chronological order", async () => {
  const nodes = []; let parent = "r";
  for (let i = 1; i <= 10; i++) { const n = node({ commentId: `u${i}`, parentId: parent, text: `m${i}` }); nodes.push(n); parent = n.commentId; }
  const current = node({ commentId: "current", parentId: parent, text: "now" });
  const out = await reconstructBranchMemory({ currentNode: current, getGraphNode: graph(nodes), maxMessages: 3, maxTokens: 1000 });
  assert.deepEqual(out.messages.map(m => m.text), ["m8", "m9", "m10"]);
});

test("v9.1.1c: token cap truncates history safely", async () => {
  const u1 = node({ commentId: "u1", parentId: "r", text: "a".repeat(80) });
  const u2 = node({ commentId: "u2", parentId: "u1", text: "b".repeat(80) });
  const current = node({ commentId: "u3", parentId: "u2", text: "now" });
  const out = await reconstructBranchMemory({ currentNode: current, getGraphNode: graph([u1, u2]), maxTokens: 25 });
  assert.equal(out.messages.length, 1); assert.equal(out.messages[0].text, "b".repeat(80));
});

test("v9.1.1c: telemetry component estimates are separated", () => {
  const e = componentEstimates({ systemPrompt: "system", knowledgeBase: "knowledge", memory: [{ text: "history" }], currentComment: "comment" });
  assert.ok(e.systemTokensEstimated > 0); assert.ok(e.kbTokensEstimated > 0); assert.ok(e.memoryTokensEstimated > 0); assert.ok(e.currentCommentTokensEstimated > 0);
});

test("v9.1.1c: OpenAI usage parser captures cached tokens", () => {
  const u = usageFromResponse({ usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } });
  assert.deepEqual(u, { inputTokensActual: 100, outputTokensActual: 20, cachedInputTokensActual: 40 });
});

test("v9.1.1c: token estimator is deterministic", () => {
  assert.equal(estimateTokens("12345678"), 2);
});
