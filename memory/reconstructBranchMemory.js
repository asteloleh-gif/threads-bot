const DEFAULT_MAX_MESSAGES = 8;
const DEFAULT_MAX_TOKENS = 1000;

// Conservative dependency-free estimator. API usage remains authoritative for billing.
function estimateTokens(text) {
  const value = String(text || "");
  if (!value) return 0;
  return Math.max(1, Math.ceil(value.length / 4));
}

async function reconstructBranchMemory({
  currentNode,
  getGraphNode,
  maxMessages = DEFAULT_MAX_MESSAGES,
  maxTokens = DEFAULT_MAX_TOKENS,
  estimate = estimateTokens,
} = {}) {
  if (!currentNode?.branchKey || currentNode.relationshipStatus !== "RESOLVED") {
    return { messages: [], estimatedTokens: 0, reason: "UNRESOLVED_BRANCH" };
  }
  if (typeof getGraphNode !== "function") throw new Error("getGraphNode is required");

  const selectedNewestFirst = [];
  const seen = new Set([String(currentNode.commentId)]);
  let cursorId = currentNode.parentId || null;
  let total = 0;

  while (cursorId && selectedNewestFirst.length < maxMessages) {
    const id = String(cursorId);
    if (seen.has(id)) break;
    seen.add(id);

    const node = await getGraphNode(id);
    if (!node) break;
    if (node.relationshipStatus !== "RESOLVED" || node.branchKey !== currentNode.branchKey) break;

    const text = String(node.text || "").trim();
    const confirmedBot = !!node.isBotGenerated && node.publishStatus === "PUBLISHED" && !!text;
    const userMessage = !node.isBotGenerated && !node.isOwner && !!text;

    if (confirmedBot || userMessage) {
      const tokens = estimate(text);
      if (total + tokens > maxTokens) break;
      selectedNewestFirst.push({
        role: confirmedBot ? "assistant" : "user",
        commentId: String(node.commentId),
        branchKey: node.branchKey,
        text,
        createdAt: node.createdAt || null,
        source: confirmedBot ? "CONFIRMED_PUBLISHED_REPLY" : "META_COMMENT",
        estimatedTokens: tokens,
      });
      total += tokens;
    }

    cursorId = node.parentId || null;
  }

  return {
    messages: selectedNewestFirst.reverse(),
    estimatedTokens: total,
    reason: "OK",
  };
}

module.exports = {
  DEFAULT_MAX_MESSAGES,
  DEFAULT_MAX_TOKENS,
  estimateTokens,
  reconstructBranchMemory,
};
