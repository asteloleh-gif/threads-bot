const crypto = require("node:crypto");
const { detectMetaPlatform } = require("./metaWebhookRouter");

// Instagram and Page ingress always requires authentication. Threads retains
// its existing rollout until its app secret is provisioned; supplying a secret
// or META_WEBHOOK_SIGNATURE_REQUIRED=true enforces it there too.
function createMetaWebhookSignature({ env = process.env } = {}) {
  return function authenticate(req, res, next) {
    const platform = detectMetaPlatform(req.body);
    const prefix = platform === "facebook" ? "FACEBOOK" : platform === "instagram" ? "INSTAGRAM" : "THREADS";
    const secret = env[`${prefix}_APP_SECRET`] || env.META_APP_SECRET;
    const required = platform === "instagram" || platform === "facebook" ||
      String(env.META_WEBHOOK_SIGNATURE_REQUIRED).toLowerCase() === "true" || Boolean(secret);
    if (!required) return next();
    if (!secret) return res.sendStatus(503);
    const signature = req.get("x-hub-signature-256") || "";
    if (!/^sha256=[a-f0-9]{64}$/i.test(signature) || !Buffer.isBuffer(req.rawBody)) return res.sendStatus(403);
    const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest();
    const actual = Buffer.from(signature.slice(7), "hex");
    if (!crypto.timingSafeEqual(actual, expected)) return res.sendStatus(403);
    return next();
  };
}

function captureMetaRawBody(req, _res, buffer) {
  req.rawBody = Buffer.from(buffer);
}

module.exports = { createMetaWebhookSignature, captureMetaRawBody };
