"use strict";

/**
 * End-to-end exercise of the bundled action.
 *
 * Runs `dist/index.js` — the exact artifact GitHub executes — as a child
 * process, with the GitHub API and the OpenAI API both pointed at a local
 * stub. This is what proves the event wiring, the diff fetch, the model call
 * and the comment posting actually fit together; the unit tests only cover the
 * pieces.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const { PHP_DIFF } = require("./fixtures");

const DIST = path.join(__dirname, "..", "dist", "index.js");
const HEAD_SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
  });
}

/**
 * Stub for both APIs. Records every call so a test can assert on what the
 * action did, including what it did *not* do.
 */
function startStub({
  modelOutput,
  reviewStatus = 200,
  modelStatus = 200,
  rejectCommentLines = [],
}) {
  const calls = {
    reactions: [],
    reviews: [],
    comments: [],
    model: [],
    reviewComments: [],
  };

  const server = http.createServer(async (req, res) => {
    const url = req.url || "";
    const send = (status, payload, contentType = "application/json") => {
      res.writeHead(status, { "content-type": contentType });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };

    // ---- OpenAI ----
    if (req.method === "POST" && url === "/v1/responses") {
      calls.model.push(JSON.parse(await readBody(req)));
      if (modelStatus !== 200) {
        return send(modelStatus, {
          error: { message: "upstream model is unavailable" },
        });
      }
      return send(200, {
        id: "resp_1",
        object: "response",
        status: "completed",
        output: [
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: JSON.stringify(modelOutput),
                annotations: [],
              },
            ],
          },
        ],
      });
    }

    // ---- GitHub ----
    if (
      req.method === "POST" &&
      /\/issues\/comments\/\d+\/reactions$/.test(url)
    ) {
      calls.reactions.push(JSON.parse(await readBody(req)).content);
      return send(201, { id: 1 });
    }

    if (req.method === "POST" && /\/pulls\/\d+\/reviews$/.test(url)) {
      calls.reviews.push(JSON.parse(await readBody(req)));
      return reviewStatus === 200
        ? send(200, { id: 1 })
        : send(reviewStatus, { message: "line must be part of the diff" });
    }

    if (req.method === "POST" && /\/pulls\/\d+\/comments$/.test(url)) {
      const comment = JSON.parse(await readBody(req));
      calls.reviewComments.push(comment);
      if (rejectCommentLines.includes(comment.line)) {
        return send(422, { message: "line must be part of the diff" });
      }
      return send(201, { id: 1 });
    }

    if (req.method === "POST" && /\/issues\/\d+\/comments$/.test(url)) {
      calls.comments.push(JSON.parse(await readBody(req)).body);
      return send(201, { id: 1 });
    }

    if (req.method === "GET" && /\/pulls\/\d+$/.test(url)) {
      if ((req.headers.accept || "").includes("diff")) {
        return send(200, PHP_DIFF, "text/plain");
      }
      return send(200, {
        number: 42,
        title: "ROCKS-1234: eager load report authors",
        body: "Fixes the N+1 on the report index.",
        state: "open",
        draft: false,
        head: { sha: HEAD_SHA },
      });
    }

    send(404, { message: `unexpected ${req.method} ${url}` });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, calls, port: server.address().port })
    );
  });
}

function writeEvent(payload) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "ai-review-")),
    "event.json"
  );
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

function runAction({ port, eventName, event, inputs = {} }) {
  const env = {
    ...process.env,
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: writeEvent(event),
    GITHUB_API_URL: `http://127.0.0.1:${port}`,
    OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    INPUT_GITHUB_TOKEN: "gh-token",
    INPUT_OPENAI_API_KEY: "sk-test",
    INPUT_OPENAI_API_MODEL: "gpt-4o",
  };

  for (const [name, value] of Object.entries(inputs)) {
    env[`INPUT_${name.toUpperCase()}`] = String(value);
  }

  return new Promise((resolve) => {
    execFile(process.execPath, [DIST], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr });
    });
  });
}

const triggerEvent = (body = "@openai review") => ({
  action: "created",
  issue: { number: 42, pull_request: { url: "https://api.github.com/x" } },
  comment: {
    id: 999,
    body,
    author_association: "MEMBER",
    user: { login: "dev", type: "User" },
  },
  repository: { name: "rocks-api", owner: { login: "full-scale-teams" } },
});

test("a trigger comment produces an inline review anchored to the right line", async (t) => {
  const { server, calls, port } = await startStub({
    modelOutput: {
      reviews: [
        {
          lineNumber: 12,
          severity: "blocker",
          reviewComment: "This still runs per row.",
        },
        {
          lineNumber: 999,
          severity: "major",
          reviewComment: "Line does not exist.",
        },
      ],
    },
  });
  t.after(() => server.close());

  const result = await runAction({
    port,
    eventName: "issue_comment",
    event: triggerEvent(),
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);

  // Acknowledged on the way in and on the way out.
  assert.deepEqual(calls.reactions, ["eyes", "rocket"]);

  assert.equal(calls.reviews.length, 1);
  const review = calls.reviews[0];
  assert.equal(review.event, "COMMENT");
  assert.equal(
    review.commit_id,
    HEAD_SHA,
    "pins the review to the head it reviewed"
  );

  // The invented line 999 is dropped; without that, GitHub 422s the whole review.
  assert.equal(review.comments.length, 1);
  assert.deepEqual(
    {
      path: review.comments[0].path,
      line: review.comments[0].line,
      side: review.comments[0].side,
    },
    { path: "app/Services/ReportService.php", line: 12, side: "RIGHT" }
  );
  assert.match(review.comments[0].body, /This still runs per row\./);
  assert.match(review.body, /1 issue/);
  assert.match(review.body, /1 blocker/);

  // The summary rides along with the review, so there is no duplicate comment.
  assert.deepEqual(calls.comments, []);

  // One request for the one changed file, carrying the diff and the PR context.
  assert.equal(calls.model.length, 1);
  assert.equal(calls.model[0].model, "gpt-4o");
  assert.equal(calls.model[0].store, false, "private source is not retained");
  assert.equal(calls.model[0].text.format.type, "json_schema");
  assert.equal(calls.model[0].text.format.strict, true);
  assert.match(calls.model[0].input, /ReportService\.php/);
  assert.match(calls.model[0].input, /eager load report authors/);
});

test("a clean review still reports back, so the developer is not left waiting", async (t) => {
  const { server, calls, port } = await startStub({
    modelOutput: { reviews: [] },
  });
  t.after(() => server.close());

  const result = await runAction({
    port,
    eventName: "issue_comment",
    event: triggerEvent(),
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);

  assert.deepEqual(calls.reviews, [], "nothing to comment on inline");
  assert.equal(calls.comments.length, 1);
  assert.match(calls.comments[0], /No issues found/);
  assert.deepEqual(calls.reactions, ["eyes", "rocket"]);
});

test("an ordinary comment costs nothing: no model call, no GitHub write", async (t) => {
  const { server, calls, port } = await startStub({
    modelOutput: { reviews: [] },
  });
  t.after(() => server.close());

  const result = await runAction({
    port,
    eventName: "issue_comment",
    event: triggerEvent("LGTM, merging once CI is green"),
  });

  assert.equal(result.code, 0);
  assert.deepEqual(calls.model, []);
  assert.deepEqual(calls.reviews, []);
  assert.deepEqual(calls.comments, []);
  assert.deepEqual(calls.reactions, []);
  assert.match(result.stdout, /No review requested/);
});

test("focus text after the trigger phrase reaches the model", async (t) => {
  const { server, calls, port } = await startStub({
    modelOutput: { reviews: [] },
  });
  t.after(() => server.close());

  await runAction({
    port,
    eventName: "issue_comment",
    event: triggerEvent("@openai review check the transaction boundary"),
  });

  assert.equal(calls.model.length, 1);
  assert.match(calls.model[0].input, /check the transaction boundary/);
});

test("a rejected batch review degrades to individual comments instead of losing everything", async (t) => {
  const { server, calls, port } = await startStub({
    modelOutput: {
      reviews: [
        { lineNumber: 12, severity: "major", reviewComment: "First finding." },
        { lineNumber: 13, severity: "minor", reviewComment: "Second finding." },
      ],
    },
    reviewStatus: 422,
  });
  t.after(() => server.close());

  const result = await runAction({
    port,
    eventName: "issue_comment",
    event: triggerEvent(),
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);

  assert.equal(calls.reviews.length, 1, "the batch was attempted");
  assert.equal(
    calls.reviewComments.length,
    2,
    "then each comment individually"
  );
  assert.equal(calls.comments.length, 1, "and the summary as a normal comment");
  assert.match(calls.comments[0], /2 issues/);
});

test("a model failure is reported on the pull request, not just in the log", async (t) => {
  const { server, calls, port } = await startStub({
    modelOutput: { reviews: [] },
    modelStatus: 500,
  });
  t.after(() => server.close());

  const result = await runAction({
    port,
    eventName: "issue_comment",
    event: triggerEvent(),
  });

  // The run fails, so the Actions check goes red rather than reporting success.
  assert.equal(result.code, 1);

  // Whoever asked for the review is watching the thread, not the workflow log.
  assert.equal(calls.comments.length, 1);
  assert.match(calls.comments[0], /could not be completed/);
  assert.deepEqual(calls.reactions, ["eyes", "confused"]);

  // The SDK retried before giving up, rather than failing on the first 500.
  assert.ok(
    calls.model.length > 1,
    `expected retries, saw ${calls.model.length} call(s)`
  );
});

test("an outside contributor cannot spend the API budget", async (t) => {
  const { server, calls, port } = await startStub({
    modelOutput: { reviews: [] },
  });
  t.after(() => server.close());

  const event = triggerEvent();
  event.comment.author_association = "NONE";

  const result = await runAction({ port, eventName: "issue_comment", event });

  assert.equal(result.code, 0);
  assert.deepEqual(calls.model, []);
  assert.deepEqual(calls.comments, []);
  assert.match(result.stdout, /ALLOWED_ASSOCIATIONS/);
});

test("the action's own comment cannot trigger another run", async (t) => {
  const { server, calls, port } = await startStub({
    modelOutput: { reviews: [] },
  });
  t.after(() => server.close());

  const event = triggerEvent("@openai review");
  event.comment.user = { login: "github-actions[bot]", type: "Bot" };

  const result = await runAction({ port, eventName: "issue_comment", event });

  assert.equal(result.code, 0);
  assert.deepEqual(calls.model, []);
  assert.match(result.stdout, /bot/i);
});

test("the summary is posted exactly once when the batch fails", async (t) => {
  // Regression guard. The degraded path and the caller both used to post the
  // summary, so a batch failure with an unanchorable comment produced two
  // identical comments on the pull request.
  const { server, calls, port } = await startStub({
    modelOutput: {
      reviews: [
        { lineNumber: 12, severity: "major", reviewComment: "Anchors fine." },
        {
          lineNumber: 13,
          severity: "minor",
          reviewComment: "Cannot be anchored.",
        },
      ],
    },
    reviewStatus: 422,
    rejectCommentLines: [13],
  });
  t.after(() => server.close());

  const result = await runAction({
    port,
    eventName: "issue_comment",
    event: triggerEvent(),
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);

  assert.equal(
    calls.reviewComments.length,
    2,
    "both were retried individually"
  );
  assert.equal(calls.comments.length, 1, "exactly one summary comment");

  // The finding GitHub refused is surfaced in that summary rather than lost.
  assert.match(calls.comments[0], /could not be attached to a line/);
  assert.match(calls.comments[0], /ReportService\.php:13/);
  assert.match(calls.comments[0], /Cannot be anchored\./);
});

// ---------------------------------------------------------------------------
// Backward compatibility.
//
// The product repos already run `full-scale-teams/ai-codereviewer@main` from a
// `pull_request` workflow. Publishing the new action upgrades those repos
// whether or not their workflow changes, so the old configuration has to keep
// working: four inputs, no TRIGGER_PHRASE, no PR_NUMBER, and crucially no
// `issues: write` permission.
// ---------------------------------------------------------------------------

const legacyPullRequestEvent = () => ({
  action: "opened",
  number: 42,
  pull_request: { number: 42 },
  repository: { name: "rocks-api", owner: { login: "full-scale-teams" } },
});

/** Exactly the inputs the current product `main.yml` passes. */
const LEGACY_INPUTS = {
  OPENAI_API_MODEL: "gpt-4o-mini",
  exclude: "**/*.lock,dist/**,**/*.json,**/*.md",
};

test("the existing product workflow still works when only the action is upgraded", async (t) => {
  const { server, calls, port } = await startStub({
    modelOutput: {
      reviews: [
        { lineNumber: 12, severity: "major", reviewComment: "Still reviewed." },
      ],
    },
  });
  t.after(() => server.close());

  const result = await runAction({
    port,
    eventName: "pull_request",
    event: legacyPullRequestEvent(),
    inputs: LEGACY_INPUTS,
  });

  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(calls.reviews.length, 1, "the review is still posted");
  assert.equal(calls.reviews[0].comments.length, 1);
  assert.equal(
    calls.model[0].model,
    "gpt-4o-mini",
    "honours the configured model"
  );

  // No reaction is attempted on a pull_request run, so the workflow does NOT
  // need the `issues: write` permission it currently lacks.
  assert.deepEqual(
    calls.reactions,
    [],
    "no reaction, so no issues:write needed"
  );
});

test("an automatic pull_request run stays silent when it finds nothing", async (t) => {
  // Otherwise upgrading the action would start posting a "nothing found"
  // comment on every push to every open pull request.
  const { server, calls, port } = await startStub({
    modelOutput: { reviews: [] },
  });
  t.after(() => server.close());

  const result = await runAction({
    port,
    eventName: "pull_request",
    event: legacyPullRequestEvent(),
    inputs: LEGACY_INPUTS,
  });

  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(
    calls.comments,
    [],
    "no comment spam on a clean automatic run"
  );
  assert.deepEqual(calls.reviews, []);
  assert.deepEqual(calls.reactions, []);
});

test("a failing automatic run does not post a failure comment on the pull request", async (t) => {
  // A manual request reports failure in the thread because a person is waiting.
  // An automatic run must not, or a model outage comments on every open PR.
  const { server, calls, port } = await startStub({
    modelOutput: { reviews: [] },
    modelStatus: 500,
  });
  t.after(() => server.close());

  const result = await runAction({
    port,
    eventName: "pull_request",
    event: legacyPullRequestEvent(),
    inputs: LEGACY_INPUTS,
  });

  assert.equal(result.code, 1, "the check still goes red");
  assert.deepEqual(calls.comments, [], "but the pull request is not spammed");
});
