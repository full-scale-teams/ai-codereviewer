"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadConfig } = require("../lib/config");

/** `@actions/core` reads inputs from `INPUT_<NAME>` environment variables. */
function withInputs(inputs, fn) {
  const applied = Object.keys(inputs).map(
    (name) => `INPUT_${name.toUpperCase()}`
  );
  const saved = new Map(applied.map((key) => [key, process.env[key]]));

  for (const [name, value] of Object.entries(inputs)) {
    process.env[`INPUT_${name.toUpperCase()}`] = String(value);
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const REQUIRED = { GITHUB_TOKEN: "tok", OPENAI_API_KEY: "sk-test" };

test("defaults are applied when optional inputs are absent", () => {
  const config = withInputs(REQUIRED, loadConfig);

  assert.equal(config.model, "gpt-4o");
  assert.equal(config.endpoint, "responses");
  assert.equal(config.temperature, 0.2);
  assert.equal(config.maxOutputTokens, 2000);
  assert.equal(config.triggerPhrase, "@openai review");
  assert.deepEqual(config.allowedAssociations, [
    "OWNER",
    "MEMBER",
    "COLLABORATOR",
  ]);
  assert.equal(config.maxFiles, 40);
  assert.equal(config.concurrency, 3);
  assert.equal(config.pullNumber, null);
  assert.deepEqual(config.excludePatterns, []);
});

test("a missing credential fails loudly instead of calling the API unauthenticated", () => {
  assert.throws(
    () => withInputs({ GITHUB_TOKEN: "tok", OPENAI_API_KEY: "" }, loadConfig),
    /OPENAI_API_KEY.*required/
  );
});

test("exclude patterns are split and trimmed", () => {
  const config = withInputs(
    Object.assign({}, REQUIRED, {
      exclude: " **/*.lock , dist/** ,, **/*.md ",
    }),
    loadConfig
  );

  assert.deepEqual(config.excludePatterns, ["**/*.lock", "dist/**", "**/*.md"]);
});

test("associations are normalised to upper case", () => {
  const config = withInputs(
    Object.assign({}, REQUIRED, { ALLOWED_ASSOCIATIONS: "owner, member" }),
    loadConfig
  );

  assert.deepEqual(config.allowedAssociations, ["OWNER", "MEMBER"]);
});

test("an unknown endpoint is rejected at startup, not mid-review", () => {
  assert.throws(
    () =>
      withInputs(
        Object.assign({}, REQUIRED, { OPENAI_API_ENDPOINT: "assistants" }),
        loadConfig
      ),
    /must be "responses" or "chat"/
  );

  for (const endpoint of ["responses", "chat", "CHAT"]) {
    const config = withInputs(
      Object.assign({}, REQUIRED, { OPENAI_API_ENDPOINT: endpoint }),
      loadConfig
    );
    assert.equal(config.endpoint, endpoint.toLowerCase());
  }
});

test("a mistyped numeric input fails rather than silently using the default", () => {
  for (const value of ["abc", "0", "-5", "2.5"]) {
    assert.throws(
      () =>
        withInputs(
          Object.assign({}, REQUIRED, { MAX_FILES: value }),
          loadConfig
        ),
      /MAX_FILES.*positive integer/
    );
  }
});

test("temperature is bounds-checked", () => {
  assert.throws(
    () =>
      withInputs(
        Object.assign({}, REQUIRED, { OPENAI_TEMPERATURE: "5" }),
        loadConfig
      ),
    /between 0 and 2/
  );

  const config = withInputs(
    Object.assign({}, REQUIRED, { OPENAI_TEMPERATURE: "0" }),
    loadConfig
  );
  assert.equal(config.temperature, 0);
});

test("PR_NUMBER is parsed when present and validated when wrong", () => {
  const config = withInputs(
    Object.assign({}, REQUIRED, { PR_NUMBER: "4711" }),
    loadConfig
  );
  assert.equal(config.pullNumber, 4711);

  assert.throws(
    () =>
      withInputs(
        Object.assign({}, REQUIRED, { PR_NUMBER: "not-a-pr" }),
        loadConfig
      ),
    /PR_NUMBER.*positive integer/
  );
});
