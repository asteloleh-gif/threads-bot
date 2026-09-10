const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
const mediaReader = fs.readFileSync(path.join(__dirname, "../vision/threadsMediaReader.js"), "utf8");
const guardSource = fs.readFileSync(path.join(__dirname, "../vision/visionGuard.js"), "utf8");
const { inspectTrustedThreadsMedia, isHttpsUrl, createVisionGuard } = require("../vision/visionGuard");

test("v9.2 reads image metadata only from the trusted Threads Graph object", () => {
  assert.match(mediaReader, /media_type/);
  assert.match(mediaReader, /media_url/);
  assert.match(mediaReader, /alt_text/);
  assert.match(mediaReader, /tokenManager\?\.getToken/);
  assert.match(mediaReader, /graph\.threads\.net\/v1\.0/);
  assert.doesNotMatch(mediaReader, /console\.(?:log|warn|error)\([^\n]*media_url/);
});

test("v9.2 accepts only HTTPS image media and rejects unsupported media", () => {
  assert.equal(isHttpsUrl("https://example.com/a.jpg"), true);
  assert.equal(isHttpsUrl("http://example.com/a.jpg"), false);
  assert.equal(inspectTrustedThreadsMedia({ media_type: "IMAGE", media_url: "https://example.com/a.jpg" }).kind, "image");
  assert.equal(inspectTrustedThreadsMedia({ media_type: "VIDEO", media_url: "https://example.com/a.mp4" }).kind, "unsupported");
  assert.equal(inspectTrustedThreadsMedia({ media_type: "IMAGE", media_url: "file:///etc/passwd" }).kind, "blocked");
});

test("v9.2 hard-locks image detail to low regardless of requested value", () => {
  const guard = createVisionGuard({ enabled: true, apiKey: "test", detail: "original" });
  assert.equal(guard.detail, "low");
  const media = inspectTrustedThreadsMedia({ media_type: "IMAGE", media_url: "https://example.com/a.jpg" });
  const content = guard.buildUserContent("Фолд Сяоми", media);
  assert.equal(content[1].image_url.detail, "low");
});

test("v9.2 uses free multimodal moderation and fails closed on image errors", () => {
  assert.match(guardSource, /omni-moderation-latest/);
  assert.match(server, /VISION_MODERATION_UNAVAILABLE/);
  assert.match(server, /VISION_MODERATION_BLOCKED/);
  assert.match(server, /VISION_MEDIA_BLOCKED/);
  assert.match(server, /VISION_UNSUPPORTED_MEDIA_SHORT_COMMENT/);
});

test("v9.2 keeps internal AI tooling private without explicit false denials", () => {
  assert.doesNotMatch(server, /Если спрашивают, сам ли Leo отвечает: да, отвечает Leo/);
  assert.doesNotMatch(server, /с частью ответов на комментарии помогает AI-ассистент/);
  assert.match(server, /не раскрывай и не обсуждай внутренние способы ведения аккаунта/i);
  assert.match(server, /не подтверждай и не отрицай использование AI/i);
  assert.match(server, /Никогда не говори «я не бот»/);
  assert.match(server, /Никогда не утверждай, что конкретный автоматический ответ был вручную напечатан Leo/);
});

test("v9.2 uses visual and branch context before asking a clarification", () => {
  assert.match(server, /Короткий комментарий сам по себе НЕ означает/);
  assert.match(server, /изображение текущего комментария, parent\/ветку разговора и базу знаний/);
  assert.match(server, /смысл всё ещё реально неоднозначен/);
});

test("v9.2 permits image-only webhook comments to reach media resolution", () => {
  assert.match(server, /if \(!commentId \|\| !author \|\| !rootId\)/);
  assert.doesNotMatch(server, /if \(!commentId \|\| !text \|\| !author \|\| !rootId\)/);
  assert.match(server, /EMPTY_COMMENT_NO_SUPPORTED_MEDIA/);
});
