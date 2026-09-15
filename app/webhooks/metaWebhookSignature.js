const crypto = require("node:crypto");
const { detectMetaPlatform } = require("./metaWebhookRouter");

// Instagram and Page ingress always requires authentication. Threads retains
// its existing rollout until its app secret is provisioned; supplying a secret
// or META_WEBHOOK_SIGNATURE_REQUIRED=true enforces it there too.
function createMetaWebhookSignature({ env = process.env } = {}) {
  return function authenticate(req, res, next) {
    const platform = detectMetaPlatform(req.body);
    const prefix = platform === "facebook" ? "FACEBOOK" : platform === "instagram" ? "INSTAGRAM" : "THREADS";
    const platformSecretKey = `${prefix}_APP_SECRET`;
    const secret = env[platformSecretKey] || env.META_APP_SECRET;
    const secretSource = env[platformSecretKey] ? platformSecretKey : env.META_APP_SECRET ? "META_APP_SECRET" : "NONE";
    const required = platform === "instagram" || platform === "facebook" ||
      String(env.META_WEBHOOK_SIGNATURE_REQUIRED).toLowerCase() === "true" || Boolean(secret);
    if (!required) return next();
    if (!secret) return res.sendStatus(503);

    const signature = req.get("x-hub-signature-256") || "";
    const signaturePresent = /^sha256=[a-f0-9]{64}$/i.test(signature);
    const rawBodyPresent = Buffer.isBuffer(req.rawBody);

    if (!signaturePresent || !rawBodyPresent) {
      console.warn("Meta webhook signature rejected", JSON.stringify({
        platform,
        signaturePresent,
        rawBodyPresent,
        secretSource,
        signatureMatch: null,
      }));
      return res.sendStatus(403);
    }

    const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest();
    const actual = Buffer.from(signature.slice(7), "hex");
    const signatureMatch = crypto.timingSafeEqual(actual, expected);

    if (!signatureMatch) {
      console.warn("Meta webhook signature rejected", JSON.stringify({
        platform,
        signaturePresent: true,
        rawBodyPresent: true,
        secretSource,
        signatureMatch: false,
      }));
      return res.sendStatus(403);
    }

    return next();
  };
}

function captureMetaRawBody(req, _res, buffer) {
  req.rawBody = Buffer.from(buffer);
}

module.exports = { createMetaWebhookSignature, captureMetaRawBody };
