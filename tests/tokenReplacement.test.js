const test = require("node:test");
const assert = require("node:assert/strict");
const { createThreadsTokenManager, TOKEN_KEY } = require("../auth/threadsTokenManager");

test("configured replacement supersedes old Redis token once and preserves later refreshes", async () => {
  const values = new Map([[TOKEN_KEY, "old-scope-token"]]);
  const clientFactory = () => ({
    on() {}, async connect() {}, isOpen: true, async quit() {},
    async get(key) { return values.get(key); },
    async set(key, value) { values.set(key, value); },
    multi() {
      const writes = [];
      return { set(key, value) { writes.push([key, value]); return this; },
        async exec() { for (const [key, value] of writes) values.set(key, value); } };
    },
  });
  async function boot(initialToken) {
    const manager = createThreadsTokenManager({ initialToken, redisUrl: "redis://test", clientFactory });
    try { await manager.init(); return manager.getToken(); } finally { await manager.close(); }
  }
  assert.equal(await boot("new-scope-token"), "new-scope-token");
  values.set(TOKEN_KEY, "automatically-refreshed");
  assert.equal(await boot("new-scope-token"), "automatically-refreshed");
  assert.equal(await boot("next-manual-replacement"), "next-manual-replacement");
});
