function createMonitorService({ config, discovery, candidates, clock = () => Date.now() } = {}) {
  async function runOnce(monitor, { maxPostAgeMinutes = 720 } = {}) {
    if (!config?.enabled || config.mode === "OFF") {
      return { status: "skipped", reason: "FEATURE_DISABLED" };
    }
    if (!monitor?.enabled) return { status: "skipped", reason: "MONITOR_DISABLED" };
    if (!monitor.id || !monitor.query || !monitor.language) {
      return { status: "failed", reason: "INVALID_MONITOR" };
    }
    if (!candidates?.isReady?.()) return { status: "failed", reason: "STORE_UNAVAILABLE" };

    const result = await discovery.searchPosts({
      query: monitor.query,
      searchType: monitor.searchType || "RECENT",
      searchMode: monitor.searchMode || "KEYWORD",
      limit: monitor.limit || 25,
      since: monitor.since,
      until: monitor.until,
      after: monitor.after,
    });
    if (result.status !== "ok") return result;

    const accepted = [];
    let duplicates = 0;
    let stale = 0;
    let invalidTimestamp = 0;
    const oldestAllowed = clock() - maxPostAgeMinutes * 60 * 1000;

    for (const post of result.posts) {
      const createdAt = Date.parse(post.createdAt);
      if (!Number.isFinite(createdAt)) {
        invalidTimestamp += 1;
        continue;
      }
      if (createdAt < oldestAllowed) {
        stale += 1;
        continue;
      }
      const claim = await candidates.claim(post, { monitorId: monitor.id, language: monitor.language });
      if (claim.claimed) accepted.push({ ...post, monitorId: monitor.id, expectedLanguage: monitor.language });
      else if (claim.reason === "DUPLICATE") duplicates += 1;
      else return { status: "failed", reason: claim.reason || "STORE_ERROR" };
    }

    return {
      status: "ok",
      discovered: result.posts.length,
      accepted: accepted.length,
      duplicates,
      stale,
      invalidTimestamp,
      candidates: accepted,
      paging: result.paging,
    };
  }

  return { runOnce };
}

module.exports = { createMonitorService };
