const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  detectCurrentCommentLanguage,
  buildLanguageLock,
} = require("../app/community/replyLanguage");
const {
  selectPersonaRecords,
  formatPersonaContext,
} = require("../app/community/personaMemoryContext");

test("current comment language wins over branch history", () => {
  assert.equal(detectCurrentCommentLanguage("but you own audi q7 🤡"), "en");
  assert.equal(detectCurrentCommentLanguage("а у тебя же ауди?"), "ru");
  assert.equal(detectCurrentCommentLanguage("це твоя машина?"), "uk");
  assert.equal(detectCurrentCommentLanguage("这是你的车吗？"), "zh");

  const lock = buildLanguageLock("but you own audi q7 🤡");
  assert.equal(lock.code, "en");
  assert.match(lock.instruction, /OUTPUT LANGUAGE LOCK: English/);
  assert.match(lock.instruction, /history.*must never change this/i);
});

test("persona retrieval keeps rules and selects only relevant public-safe memories", () => {
  const records = [
    { fields: { Key: "reply_style_casual", Value: "Keep replies short and natural.", Type: "style", Confidence: "high", "Public Safe": true, Active: true, Tags: ["style"] } },
    { fields: { Key: "language_match", Value: "Answer in current comment language.", Type: "context_rule", Confidence: "high", "Public Safe": true, Active: true, Tags: ["language"] } },
    { fields: { Key: "vehicle_turo_reply_example", Value: "If Audi in the post is known to be Turo, say it is a Turo car.", Type: "example", Confidence: "high", "Public Safe": true, Active: true, Tags: ["vehicle"] } },
    { fields: { Key: "coffee_preference", Value: "Black coffee only.", Type: "preference", Confidence: "high", "Public Safe": true, Active: true, Tags: ["coffee"] } },
    { fields: { Key: "private_fact", Value: "Never expose me.", Type: "fact", Confidence: "high", "Public Safe": false, Active: true, Tags: ["vehicle"] } },
    { fields: { Key: "inactive_fact", Value: "Audi old note.", Type: "fact", Confidence: "high", "Public Safe": true, Active: false, Tags: ["vehicle"] } },
  ];

  const selected = selectPersonaRecords(records, "а у тебя же ауди?", { maxSelected: 8 });
  const keys = selected.map(item => item.key);
  assert.ok(keys.includes("reply_style_casual"));
  assert.ok(keys.includes("language_match"));
  assert.ok(keys.includes("vehicle_turo_reply_example"));
  assert.ok(!keys.includes("coffee_preference"));
  assert.ok(!keys.includes("private_fact"));
  assert.ok(!keys.includes("inactive_fact"));

  const formatted = formatPersonaContext(selected);
  assert.match(formatted, /RELEVANT PERSONA MEMORY/);
  assert.match(formatted, /examples as verified facts/i);
});

test("dry-run secondary community keeps dedupe in an isolated safety namespace", () => {
  const source = fs.readFileSync(path.join(__dirname, "../app/community/createCommunityRuntime.js"), "utf8");
  assert.match(source, /const safetyNamespace = dryRunMode \? `\$\{ns\}:dryrun` : ns;/);
  assert.ok((source.match(/namespace: safetyNamespace/g) || []).length >= 2);

  const start = source.indexOf("if (safety.isDryRun())");
  assert.notEqual(start, -1);
  const end = source.indexOf("if (!(await safety.verifyBranchLease", start);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);
  assert.match(block, /await safety\.commitSuccess\(reservation, null, null\)/);
  assert.doesNotMatch(block, /await safety\.rollback\(reservation\)/);
});
