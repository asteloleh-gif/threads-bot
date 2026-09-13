function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function detectMetaPlatform(body = {}) {
  const object = normalize(body?.object);
  if (object === "instagram") return "instagram";
  if (object === "page") return "facebook";
  if (object === "threads") return "threads";

  // Legacy Threads webhook payloads in the current service do not always carry
  // an `object` discriminator. Keep that compatibility without allowing an
  // unknown explicit Meta object to fall through to Threads accidentally.
  if (object) return null;
  if (Array.isArray(body?.values)) return "threads";

  const changes = (body?.entry || []).flatMap(entry => entry?.changes || []);
  if (changes.some(change => change?.field === "replies")) return "threads";
  if (changes.some(change => change?.field === "comments")) return "threads";
  return null;
}

function createMetaWebhookRouter({ providerRegistry, handlers = {} } = {}) {
  if (!providerRegistry || typeof providerRegistry.list !== "function") {
    throw new Error("Meta webhook router requires a provider registry");
  }

  function providersFor(platform) {
    return providerRegistry.list().filter(provider =>
      provider?.platform === platform && provider?.account?.enabled !== false
    );
  }

  function verify(query = {}) {
    const mode = query["hub.mode"];
    const token = String(query["hub.verify_token"] || "");
    const challenge = query["hub.challenge"];
    if (mode !== "subscribe" || !token || challenge == null) return { ok: false };

    const accepted = providerRegistry.list().some(provider => {
      const configured = String(provider?.account?.verifyToken || "");
      return configured && configured === token;
    });
    return accepted ? { ok: true, challenge: String(challenge) } : { ok: false };
  }

  async function dispatch(body = {}) {
    const platform = detectMetaPlatform(body);
    if (!platform) {
      return { status: "ignored", reason: "UNRECOGNIZED_WEBHOOK", platform: null, parsed: 0, dispatched: 0, unhandled: 0 };
    }

    const providers = providersFor(platform);
    if (!providers.length) {
      return { status: "ignored", reason: "NO_ENABLED_PROVIDER", platform, parsed: 0, dispatched: 0, unhandled: 0 };
    }

    let parsed = 0;
    let dispatched = 0;
    let unhandled = 0;

    for (const provider of providers) {
      const nativeEvents = provider.parseWebhook(body) || [];
      for (const native of nativeEvents) {
        const event = typeof provider.normalizeWebhookEvent === "function"
          ? provider.normalizeWebhookEvent(native)
          : native;
        if (!event) continue;
        parsed += 1;

        const handler = handlers[platform];
        if (typeof handler !== "function") {
          unhandled += 1;
          continue;
        }

        await handler({ platform, provider, event, native });
        dispatched += 1;
      }
    }

    return { status: "ok", platform, parsed, dispatched, unhandled };
  }

  return { detectPlatform: detectMetaPlatform, providersFor, verify, dispatch };
}

module.exports = { detectMetaPlatform, createMetaWebhookRouter };
