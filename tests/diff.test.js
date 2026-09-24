"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const parseDiff = require("parse-diff");

const {
  selectReviewableFiles,
  buildReviewUnits,
  countAddedLines,
} = require("../lib/diff");
const {
  PHP_DIFF,
  DELETED_FILE_DIFF,
  BINARY_DIFF,
  LOCKFILE_DIFF,
  TWO_CHUNK_DIFF,
} = require("./fixtures");

test("selectReviewableFiles keeps a normal changed file", () => {
  const files = selectReviewableFiles(parseDiff(PHP_DIFF), []);

  assert.equal(files.length, 1);
  assert.equal(files[0].to, "app/Services/ReportService.php");
});

test("selectReviewableFiles drops deleted files", () => {
  assert.deepEqual(selectReviewableFiles(parseDiff(DELETED_FILE_DIFF), []), []);
});

test("selectReviewableFiles drops binary files, which carry no hunks", () => {
  assert.deepEqual(selectReviewableFiles(parseDiff(BINARY_DIFF), []), []);
});

test("selectReviewableFiles honours exclude globs", () => {
  const files = parseDiff(PHP_DIFF + LOCKFILE_DIFF);
  assert.equal(selectReviewableFiles(files, []).length, 2);

  const kept = selectReviewableFiles(files, ["**/*.lock", "yarn.lock"]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].to, "app/Services/ReportService.php");
});

test("buildReviewUnits marks only added lines as commentable", () => {
  const [file] = selectReviewableFiles(parseDiff(PHP_DIFF), []);
  const [unit] = buildReviewUnits(file, 12000);

  // The three `+` lines land at new-file lines 12, 13 and 14.
  assert.deepEqual(
    [...unit.commentableLines].sort((a, b) => a - b),
    [12, 13, 14]
  );
});

test("buildReviewUnits numbers added lines by the NEW file and never numbers deletions", () => {
  const [file] = selectReviewableFiles(parseDiff(PHP_DIFF), []);
  const [unit] = buildReviewUnits(file, 12000);
  const lines = unit.renderedDiff.split("\n");

  const added = lines.filter((line) => /\|\s*\+/.test(line));
  assert.equal(added.length, 3);
  assert.match(added[0], /^\s*12 \| \+/);
  assert.match(added[1], /^\s*13 \| \+/);
  assert.match(added[2], /^\s*14 \| \+/);

  // The deletion is shown for context but carries no citable number. This is
  // the upstream bug: it emitted the OLD file's line number here, which the
  // model then quoted and GitHub then rejected.
  const deleted = lines.filter((line) => /\|\s*-/.test(line));
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /^\s*- \| -/);
});

test("buildReviewUnits keeps one file in one request when it fits", () => {
  const [file] = selectReviewableFiles(parseDiff(TWO_CHUNK_DIFF), []);
  const units = buildReviewUnits(file, 12000);

  assert.equal(units.length, 1);
  assert.equal(units[0].partsTotal, 1);
  assert.deepEqual(
    [...units[0].commentableLines].sort((a, b) => a - b),
    [6, 42]
  );
});

test("buildReviewUnits splits on chunk boundaries when over the char budget", () => {
  const [file] = selectReviewableFiles(parseDiff(TWO_CHUNK_DIFF), []);
  const units = buildReviewUnits(file, 40);

  assert.equal(units.length, 2);
  assert.deepEqual(
    units.map((unit) => unit.part),
    [1, 2]
  );
  assert.ok(units.every((unit) => unit.partsTotal === 2));

  // Every added line survives the split, each in exactly one unit.
  const all = units
    .flatMap((unit) => [...unit.commentableLines])
    .sort((a, b) => a - b);
  assert.deepEqual(all, [6, 42]);
});

test("countAddedLines counts only additions", () => {
  const [file] = selectReviewableFiles(parseDiff(PHP_DIFF), []);
  assert.equal(countAddedLines(file), 3);
});
