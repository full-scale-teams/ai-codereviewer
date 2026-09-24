"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  toFindings,
  dedupe,
  countBySeverity,
  buildSummary,
} = require("../lib/findings");
const { parseFindings } = require("../lib/reviewer");

function unit(lines) {
  return {
    path: "app/Services/ReportService.php",
    commentableLines: new Set(lines),
  };
}

function finding(overrides) {
  return Object.assign(
    { path: "a.php", line: 1, severity: "major", body: "something" },
    overrides
  );
}

test("toFindings keeps comments anchored to added lines", () => {
  const result = toFindings(unit([12, 13]), [
    { lineNumber: 12, severity: "blocker", reviewComment: "Unbounded query." },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].line, 12);
  assert.equal(result[0].severity, "blocker");
  assert.equal(result[0].path, "app/Services/ReportService.php");
  assert.match(result[0].body, /Blocker/);
  assert.match(result[0].body, /Unbounded query\./);
});

test("toFindings drops a line the model invented", () => {
  // This is what protects the whole review: GitHub 422s a comment it cannot
  // anchor, and a batch review fails entirely on one bad entry.
  const result = toFindings(unit([12, 13]), [
    { lineNumber: 999, severity: "major", reviewComment: "Not a real line." },
    { lineNumber: 13, severity: "minor", reviewComment: "This one is fine." },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].line, 13);
});

test("dedupe keeps the most severe comment per line, whichever order they arrive in", () => {
  // Both orderings matter: "last wins" and "first wins" each look correct on
  // one of them, and only one of the two is the behaviour we want.
  for (const severities of [
    ["minor", "blocker"],
    ["blocker", "minor"],
  ]) {
    const result = dedupe([
      finding({
        line: 10,
        severity: severities[0],
        body: `${severities[0]} note`,
      }),
      finding({
        line: 10,
        severity: severities[1],
        body: `${severities[1]} note`,
      }),
      finding({ line: 11, severity: "major", body: "major note" }),
    ]);

    assert.equal(
      result.length,
      2,
      `collapsed to one comment for ${severities}`
    );
    assert.equal(result[0].line, 10);
    assert.equal(
      result[0].severity,
      "blocker",
      `kept the blocker for ${severities}`
    );
    assert.match(result[0].body, /blocker note/);
  }
});

test("dedupe sorts worst-first so MAX_COMMENTS truncates the least important", () => {
  const result = dedupe([
    finding({ line: 3, severity: "minor" }),
    finding({ line: 1, severity: "major" }),
    finding({ line: 2, severity: "blocker" }),
  ]);

  assert.deepEqual(
    result.map((item) => item.severity),
    ["blocker", "major", "minor"]
  );
});

test("dedupe does not merge the same line in different files", () => {
  const result = dedupe([
    finding({ path: "a.php", line: 10, severity: "major" }),
    finding({ path: "b.vue", line: 10, severity: "major" }),
  ]);

  assert.equal(result.length, 2);
});

test("countBySeverity lists only the severities present", () => {
  assert.equal(
    countBySeverity([
      finding({ severity: "blocker" }),
      finding({ severity: "blocker" }),
      finding({ severity: "minor" }),
    ]),
    "2 blocker · 1 minor"
  );
});

test("buildSummary reports a clean run without claiming issues", () => {
  const body = buildSummary({
    model: "gpt-4o",
    endpoint: "responses",
    headSha: "abcdef1234567890",
    filesReviewed: 3,
    skippedFiles: [],
    findings: [],
    unanchored: [],
  });

  assert.match(body, /No issues found across \*\*3 files\*\* at `abcdef1`/);
  assert.match(body, /gpt-4o/);
  assert.doesNotMatch(body, /Blocker/);
});

test("buildSummary counts issues and singularises correctly", () => {
  const body = buildSummary({
    model: "gpt-4o",
    endpoint: "responses",
    headSha: "abcdef1234567890",
    filesReviewed: 1,
    skippedFiles: [],
    findings: [finding({ severity: "blocker" })],
    unanchored: [],
  });

  assert.match(body, /\*\*1 issue\*\* across \*\*1 file\*\*/);
  assert.match(body, /1 blocker/);
});

test("buildSummary never contains the trigger phrase, so it cannot re-trigger itself", () => {
  const body = buildSummary({
    model: "gpt-4o",
    endpoint: "responses",
    headSha: "abcdef1234567890",
    filesReviewed: 2,
    skippedFiles: ["dist/app.js"],
    findings: [finding({})],
    unanchored: [finding({ line: 7, body: "line 7\nnote" })],
  });

  assert.doesNotMatch(body, /@openai review/i);
  assert.match(body, /dist\/app\.js/);
  assert.match(body, /MAX_FILES/);
  // A multi-line finding is flattened so it stays on one bullet.
  assert.match(body, /`a\.php:7` — line 7 note/);
});

test("parseFindings accepts a well-formed model response", () => {
  const result = parseFindings(
    '{"reviews":[{"lineNumber":12,"severity":"blocker","reviewComment":"Boom."}]}'
  );

  assert.deepEqual(result, [
    { lineNumber: 12, severity: "blocker", reviewComment: "Boom." },
  ]);
});

test("parseFindings treats unusable output as no findings rather than throwing", () => {
  assert.deepEqual(parseFindings(""), []);
  assert.deepEqual(parseFindings("I could not review this."), []);
  assert.deepEqual(parseFindings("{}"), []);
  assert.deepEqual(parseFindings('{"reviews":"nope"}'), []);
});

test("parseFindings drops malformed entries but keeps good ones", () => {
  const result = parseFindings(
    JSON.stringify({
      reviews: [
        { lineNumber: "not a number", severity: "major", reviewComment: "x" },
        { lineNumber: 0, severity: "major", reviewComment: "x" },
        { lineNumber: 5, severity: "major", reviewComment: "   " },
        { lineNumber: 8, severity: "major", reviewComment: "Keep me." },
      ],
    })
  );

  assert.deepEqual(result, [
    { lineNumber: 8, severity: "major", reviewComment: "Keep me." },
  ]);
});

test("parseFindings falls back to the lowest severity when it is unrecognised", () => {
  const result = parseFindings(
    '{"reviews":[{"lineNumber":3,"severity":"catastrophic","reviewComment":"x"}]}'
  );

  assert.equal(result[0].severity, "minor");
});
