const express = require("express");

function createContentControlRouter({ control } = {}) {
  if (!control) throw new Error("Content control router requires control service");
  const router = express.Router();

  router.use((req, res, next) => {
    if (!control.authenticate(req.get("authorization"))) {
      res.set("Cache-Control", "no-store");
      return res.status(401).json({ status: "unauthorized" });
    }
    res.set("Cache-Control", "no-store");
    return next();
  });

  router.get("/status", (_req, res) => {
    res.status(200).json({ status: "ok", control: control.health() });
  });

  async function execute(req, res, operation, input) {
    const result = await control.run({
      operation,
      idempotencyKey: req.get("idempotency-key"),
      input,
    });
    return res.status(result.httpStatus).json(result.body);
  }

  router.post("/briefs/generate", async (req, res) => {
    return execute(req, res, "generateBrief", {
      accountKey: req.body?.accountKey,
      objective: req.body?.objective,
      research: req.body?.research,
      analytics: req.body?.analytics,
      brand: req.body?.brand,
      language: req.body?.language,
      metadata: req.body?.metadata,
    });
  });

  router.post("/briefs/:briefId/drafts/generate", async (req, res) => {
    return execute(req, res, "generateDraft", {
      briefId: req.params.briefId,
      constraints: req.body?.constraints,
      language: req.body?.language,
      metadata: req.body?.metadata,
    });
  });

  router.post("/drafts/:draftId/review", async (req, res) => {
    return execute(req, res, "reviewDraft", {
      draftId: req.params.draftId,
      policy: req.body?.policy,
      metadata: req.body?.metadata,
    });
  });

  router.post("/drafts/:draftId/approval", async (req, res) => {
    return execute(req, res, "decideApproval", {
      draftId: req.params.draftId,
      decision: req.body?.decision,
      reviewer: req.body?.reviewer,
      source: req.body?.source || "content-control-api",
      metadata: req.body?.metadata,
    });
  });

  router.post("/drafts/:draftId/schedule", async (req, res) => {
    return execute(req, res, "scheduleApprovedDraft", {
      draftId: req.params.draftId,
      scheduledAt: req.body?.scheduledAt,
      metadata: req.body?.metadata,
    });
  });

  return router;
}

module.exports = { createContentControlRouter };
