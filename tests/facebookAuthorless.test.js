const test = require("node:test");
const assert = require("node:assert/strict");
const { createFacebookProvider } = require("../app/providers/facebookProvider");
const { createCommunityRuntime } = require("../app/community/createCommunityRuntime");
const { deriveGraphNode } = require("../graph/conversationGraph");
const { reconstructBranchMemory } = require("../memory/reconstructBranchMemory");

const policy = {
  normalReplyLimit: 3, cooldownSeconds: 0, conversationResetHours: 24,
  globalDailyLimit: 50, redisRequired: true, parentLookupEnabled: false,
  closingEnabled: false,
};

function fixture({ dryRun = true, replyResult = { status: "published", id: "bot-1" }, getContext = async () => "" } = {}) {
  const account = {
    key: "astel.us:facebook", platform: "facebook", username: "Олег Акастелов",
    userId: "page-1", accessToken: "fixture-token", enabled: true, dryRun,
  };
  const provider = createFacebookProvider({
    account,
    fetchImpl: async () => ({ ok: false, status: 404, async json() { return { error: { code: 100 } }; } }),
  });
  const calls = { gpt: 0, publish: 0, reservations: 0, memory: [], contexts: 0 };
  provider.reply = async () => { calls.publish += 1; return replyResult; };
  const runtime = createCommunityRuntime({
    provider, policy, getContext: async (...args) => { calls.contexts += 1; return getContext(...args); },
    generateReply: async (_text, _context, options) => {
      calls.gpt += 1;
      calls.memory.push(options.memory);
      return { text: "controlled reply" };
    },
  });
  const nodes = new Map();
  const sources = new Map();
  const botIds = new Set();
  const leases = new Map();
  const safety = runtime.safety;
  Object.assign(safety, {
    isEnabled: () => true,
    isReady: () => true,
    isDryRun: () => dryRun,
    isSelfAuthored: ({ authorId, authorUsername }) => authorId === account.userId || authorUsername === account.username,
    isBotGeneratedId: async id => botIds.has(id),
    getSourceStatus: async id => sources.get(id) || null,
    getGraphNode: async id => nodes.get(id) || null,
    recordGraphNode: async input => {
      const previous = nodes.get(input.commentId);
      const node = deriveGraphNode({
        ...previous, ...input,
        parentNode: input.parentId ? nodes.get(input.parentId) : null,
      });
      nodes.set(node.commentId, node);
      return node;
    },
    getUserKey: ({ authorId, authorUsername }) => authorId ? `id:${authorId}` : authorUsername ? `username:${authorUsername}` : null,
    getConversationKey: ({ userKey, rootId }) => userKey && rootId ? `${userKey}|thread:${rootId}` : null,
    reserve: async ({ commentId, conversationKey }) => {
      if (sources.has(commentId)) return { allowed: false, reason: "DUPLICATE" };
      calls.reservations += 1;
      const reservation = { allowed: true, reservationId: `lease-${commentId}`, commentId, conversationKey, replyNumber: 1 };
      sources.set(commentId, "RESERVED");
      return reservation;
    },
    acquireBranchLease: async (key, token) => {
      if (leases.has(key)) return false;
      leases.set(key, token);
      return true;
    },
    verifyBranchLease: async (key, token) => leases.get(key) === token,
    releaseBranchLease: async (key, token) => { if (leases.get(key) === token) leases.delete(key); },
    getBranchMemory: async id => {
      const node = nodes.get(id);
      return reconstructBranchMemory({ currentNode: node, getGraphNode: async key => nodes.get(key) || null });
    },
    commitSuccess: async (reservation, id, text) => {
      sources.set(reservation.commentId, "PUBLISHED");
      if (id) {
        botIds.add(id);
        const source = nodes.get(reservation.commentId);
        await safety.recordGraphNode({
          commentId: id, parentId: source.commentId, rootId: source.rootId,
          authorId: account.userId, username: account.username, text,
          isOwner: true, isBotGenerated: true, publishStatus: "PUBLISHED",
        });
      }
      return true;
    },
    rollback: async reservation => { sources.delete(reservation.commentId); return true; },
    markAmbiguous: async reservation => { sources.set(reservation.commentId, "AMBIGUOUS"); return true; },
  });
  Object.assign(runtime.humanLocks, { isReady: () => true, isLocked: async () => false });

  function event(id, { parentId = "page-1_post", author = null, rootId = "page-1_post" } = {}) {
    const native = { id, message: "Question?", parent_id: parentId, created_time: "2026-09-16T00:00:00Z" };
    if (author) native.from = author;
    return provider.normalizePolledComment(native, rootId);
  }
  return { runtime, provider, calls, nodes, sources, botIds, event, account };
}

test("authorless Facebook root uses owner post and branch identity for dry-run once", async () => {
  const f = fixture();
  const e = f.event("external-1");
  assert.deepEqual(await f.runtime.handleComment(e), { status: "dry-run", reason: "WOULD_REPLY" });
  assert.equal(f.calls.gpt, 1);
  assert.equal(f.calls.publish, 0);
  assert.equal(f.nodes.get("external-1").authorId, null);
  assert.equal(f.calls.memory[0].length, 0);
  assert.equal((await f.runtime.handleComment(e)).reason, "DUPLICATE");
  assert.equal(f.calls.reservations, 1);
});

test("authorless Facebook follow-up inherits resolved branch and prior conversation memory", async () => {
  const f = fixture({ dryRun: false });
  const root = f.event("external-1");
  assert.equal((await f.runtime.handleComment(root)).status, "published");
  f.provider.reply = async () => { f.calls.publish += 1; return { status: "published", id: "bot-2" }; };
  const followUp = f.event("external-2", { parentId: "bot-1" });
  assert.equal((await f.runtime.handleComment(followUp)).status, "published");
  assert.equal(f.nodes.get("external-2").branchKey, f.nodes.get("external-1").branchKey);
  assert.deepEqual(f.calls.memory[1].map(m => m.role), ["user", "assistant"]);
  assert.equal(f.calls.gpt, 2);
  assert.equal(f.calls.publish, 2);
});

test("authorless Facebook rejects unknown relationship and untrusted ingress before GPT", async () => {
  const f = fixture();
  assert.equal((await f.runtime.handleComment(f.event("orphan", { parentId: "missing" }))).reason, "AUTHORLESS_UNTRUSTED");
  const e = { ...f.event("webhook"), metadata: { targetPageId: "page-1", webhookField: "feed" } };
  assert.equal((await f.runtime.handleComment(e)).reason, "AUTHORLESS_UNTRUSTED");
  assert.equal(f.calls.gpt, 0);
  assert.equal(f.calls.publish, 0);
});

test("known Page author and authorless known bot reply never reach GPT", async () => {
  const f = fixture();
  assert.equal((await f.runtime.handleComment(f.event("manual", { author: { id: "page-1", name: "Олег Акастелов" } }))).reason, "SELF_COMMENT");
  f.botIds.add("bot-1");
  assert.equal((await f.runtime.handleComment(f.event("bot-1"))).reason, "BOT_GENERATED_OBJECT");
  f.botIds.delete("bot-1");
  await f.runtime.safety.recordGraphNode({
    commentId: "bot-1", parentId: "page-1_post", rootId: "page-1_post",
    isOwner: true, isBotGenerated: true, authorId: "page-1",
  });
  assert.equal((await f.runtime.handleComment(f.event("bot-1"))).reason, "BOT_GENERATED_OBJECT");
  assert.equal(f.calls.gpt, 0);
  assert.equal(f.calls.publish, 0);
});

test("simultaneous duplicate Facebook source obtains one reservation and one publish", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ dryRun: false, getContext: async () => gate });
  const e = f.event("double-click");
  const first = f.runtime.handleComment(e);
  const second = f.runtime.handleComment(e);
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(r => r.status).sort(), ["ignored", "published"]);
  assert.equal(f.calls.reservations, 1);
  assert.equal(f.calls.gpt, 1);
  assert.equal(f.calls.publish, 1);
});

test("different simultaneous comments in one branch cannot both publish while lease is held", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ dryRun: false, getContext: async () => gate });
  await f.runtime.safety.recordGraphNode({ commentId: "root", parentId: "page-1_post", rootId: "page-1_post", text: "first" });
  const a = f.event("a", { parentId: "root" });
  const b = f.event("b", { parentId: "root" });
  const first = f.runtime.handleComment(a);
  const second = f.runtime.handleComment(b);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results.filter(r => r.status === "published").length, 1);
  assert.equal(results.filter(r => r.reason === "BRANCH_BUSY").length, 1);
  assert.equal(f.calls.publish, 1);
});

test("ambiguous Facebook mutation holds source and is not blindly retried", async () => {
  const f = fixture({ dryRun: false, replyResult: { status: "ambiguous", reason: "NETWORK_OUTCOME_UNKNOWN" } });
  const e = f.event("ambiguous");
  assert.equal((await f.runtime.handleComment(e)).status, "ambiguous");
  assert.equal((await f.runtime.handleComment(e)).reason, "DUPLICATE");
  assert.equal(f.calls.publish, 1);
  assert.equal(f.calls.gpt, 1);
});

test("author-present Facebook retains existing routing; Instagram still rejects missing author", async () => {
  const f = fixture();
  assert.equal((await f.runtime.handleComment(f.event("known", { author: { id: "visitor", name: "Visitor" } }))).status, "dry-run");
  const instagram = fixture();
  instagram.provider.platform = "instagram";
  assert.equal((await instagram.runtime.handleComment(instagram.event("missing"))).reason, "INVALID_PAYLOAD");
  assert.equal(instagram.calls.gpt, 0);
});
