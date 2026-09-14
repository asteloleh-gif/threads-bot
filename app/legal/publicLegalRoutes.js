const express = require("express");

const UPDATED = "September 14, 2026";

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Astel Social Engine</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;line-height:1.55;color:#171717}h1,h2{line-height:1.2}a{color:#155eef}code{background:#f2f4f7;padding:2px 5px;border-radius:4px}.muted{color:#667085}</style>
</head>
<body><h1>${title}</h1><p class="muted">Astel Social Engine · Last updated ${UPDATED}</p>${body}</body>
</html>`;
}

function createPublicLegalRouter() {
  const router = express.Router();

  router.get("/privacy", (_req, res) => {
    res.type("html").send(page("Privacy Policy", `
<p>Astel Social Engine is a first-party social-media automation service used by the operator of the Instagram professional account <strong>@astel.us</strong> and associated Meta assets.</p>
<h2>Data we process</h2>
<p>When the service is connected to Meta APIs it may process account identifiers, usernames, media identifiers, comment and reply identifiers, comment text, timestamps, webhook metadata, access credentials, generated-reply metadata, and operational safety/audit records.</p>
<h2>Why we process it</h2>
<p>We use this data only to operate account management, comment moderation and replies, deduplication, rate limiting, abuse prevention, reliability, debugging and audit functions requested by the account operator.</p>
<h2>Storage and sharing</h2>
<p>Operational records may be stored in Redis and PostgreSQL used by the service. Access credentials are treated as secrets. We do not sell personal data or use it for third-party advertising. We do not share it with advertisers.</p>
<h2>Retention and deletion</h2>
<p>Operational data is kept only as needed for the service, safety, debugging and legal obligations. To request deletion of data associated with an Instagram interaction, follow the instructions on the <a href="/data-deletion">Data Deletion</a> page.</p>
<h2>Third-party platform</h2>
<p>Use of Instagram, Facebook and Threads is also governed by Meta's own terms and privacy policies.</p>
<h2>Contact</h2>
<p>For privacy or deletion requests, contact the operator through the Instagram account <strong>@astel.us</strong>.</p>`));
  });

  router.get("/terms", (_req, res) => {
    res.type("html").send(page("Terms of Use", `
<p>Astel Social Engine is an internal/first-party tool used to manage social accounts controlled by its operator. It is not offered as a public consumer service at this stage.</p>
<h2>Acceptable use</h2>
<p>The service may be used only with accounts and assets the operator is authorized to manage and in compliance with Meta platform terms, applicable laws and platform rate limits.</p>
<h2>Automation</h2>
<p>Automated actions are subject to safety controls, dry-run gates, deduplication and rate limits. The operator remains responsible for content and actions published through connected social accounts.</p>
<h2>Availability</h2>
<p>The service is provided on an as-available basis and may be changed, paused or disabled for maintenance, safety or platform-policy reasons.</p>
<h2>Contact</h2>
<p>Questions about these terms can be directed to the operator through <strong>@astel.us</strong>.</p>`));
  });

  router.get("/data-deletion", (_req, res) => {
    res.type("html").send(page("Data Deletion Instructions", `
<p>You can stop future access by removing the Astel Social Engine connection from your Instagram/Meta account settings.</p>
<h2>Request deletion from Astel Social Engine</h2>
<ol>
<li>Contact the operator through the Instagram account <strong>@astel.us</strong>.</li>
<li>State that you are requesting deletion of data associated with your Instagram interaction and provide enough non-sensitive information to identify the interaction, such as the Instagram username and approximate date.</li>
<li>The operator will verify the request and remove data that the service is permitted and able to delete, subject to limited security, fraud-prevention, audit or legal retention requirements.</li>
</ol>
<p>Do not send passwords, access tokens or other account secrets with a deletion request.</p>`));
  });

  return router;
}

module.exports = { createPublicLegalRouter };
