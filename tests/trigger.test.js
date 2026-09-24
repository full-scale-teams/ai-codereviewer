"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveTrigger, SkipRun } = require("../lib/github");
const { baseConfig, commentEvent } = require("./fixtures");

function asEvent(name, fn) {
  const previous = process.env.GITHUB_EVENT_NAME;
  process.env.GITHUB_EVENT_NAME = name;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.GITHUB_EVENT_NAME;
    else process.env.GITHUB_EVENT_NAME = previous;
  }
}

function expectSkip(name, payload, config, match) {
  assert.throws(
    () => asEvent(name, () => resolveTrigger(payload, config || baseConfig())),
    (error) => {
      assert.ok(error instanceof SkipRun, `expected SkipRun, got ${error}`);
      if (match) assert.match(error.message, match);
      return true;
    }
  );
}

test("a member's trigger comment starts a review of that pull request", () => {
  const trigger = asEvent("issue_comment", () =>
    resolveTrigger(commentEvent(), baseConfig())
  );

  assert.equal(trigger.owner, "full-scale-teams");
  assert.equal(trigger.repo, "rocks-api");
  assert.equal(trigger.pullNumber, 42);
  assert.equal(trigger.source, "issue_comment");
  assert.equal(trigger.ackCommentId, 999);
  assert.equal(trigger.focus, "");
});

test("text after the trigger phrase becomes the review focus", () => {
  const trigger = asEvent("issue_comment", () =>
    resolveTrigger(
      commentEvent({
        comment: { body: "@openai review: focus on the N+1 in ReportService" },
      }),
      baseConfig()
    )
  );

  assert.equal(trigger.focus, "focus on the N+1 in ReportService");
});

test("the trigger phrase is matched case-insensitively and mid-comment", () => {
  const trigger = asEvent("issue_comment", () =>
    resolveTrigger(
      commentEvent({
        comment: { body: "Looks good to me.\n\n@OpenAI Review please" },
      }),
      baseConfig()
    )
  );

  assert.equal(trigger.pullNumber, 42);
  assert.equal(trigger.focus, "please");
});

test("a custom trigger phrase is honoured", () => {
  const config = baseConfig({ triggerPhrase: "/ai-review" });
  const trigger = asEvent("issue_comment", () =>
    resolveTrigger(commentEvent({ comment: { body: "/ai-review" } }), config)
  );

  assert.equal(trigger.pullNumber, 42);
  expectSkip("issue_comment", commentEvent(), config, /trigger phrase/);
});

test("an ordinary comment does not start a review", () => {
  expectSkip(
    "issue_comment",
    commentEvent({ comment: { body: "nice work, shipping this" } }),
    undefined,
    /trigger phrase/
  );
});

test("a comment on a plain issue does not start a review", () => {
  expectSkip(
    "issue_comment",
    commentEvent({ issue: { number: 42 } }),
    undefined,
    /not a pull request/
  );
});

test("a bot's comment cannot start a review, so the action cannot trigger itself", () => {
  expectSkip(
    "issue_comment",
    commentEvent({
      comment: { user: { login: "github-actions[bot]", type: "Bot" } },
    }),
    undefined,
    /bot/
  );

  // Belt and braces: `type` alone is enough, and so is the login suffix.
  expectSkip(
    "issue_comment",
    commentEvent({
      comment: { user: { login: "dependabot[bot]", type: "User" } },
    }),
    undefined,
    /bot/
  );
});

test("an outside commenter cannot spend the API budget", () => {
  expectSkip(
    "issue_comment",
    commentEvent({ comment: { author_association: "NONE" } }),
    undefined,
    /ALLOWED_ASSOCIATIONS/
  );

  expectSkip(
    "issue_comment",
    commentEvent({ comment: { author_association: "FIRST_TIME_CONTRIBUTOR" } }),
    undefined,
    /ALLOWED_ASSOCIATIONS/
  );
});

test("ALLOWED_ASSOCIATIONS can be widened", () => {
  const config = baseConfig({
    allowedAssociations: ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"],
  });

  const trigger = asEvent("issue_comment", () =>
    resolveTrigger(
      commentEvent({ comment: { author_association: "CONTRIBUTOR" } }),
      config
    )
  );

  assert.equal(trigger.pullNumber, 42);
});

test("editing or deleting a comment does not re-run the review", () => {
  for (const action of ["edited", "deleted"]) {
    expectSkip(
      "issue_comment",
      commentEvent({ action }),
      undefined,
      /only new comments/
    );
  }
});

test("a trigger inside a review thread works and acks the right comment", () => {
  const payload = {
    action: "created",
    pull_request: { number: 77 },
    comment: {
      id: 555,
      body: "@openai review this hunk",
      author_association: "OWNER",
      user: { login: "lead", type: "User" },
    },
    repository: {
      name: "rocks-frontend",
      owner: { login: "full-scale-teams" },
    },
  };

  const trigger = asEvent("pull_request_review_comment", () =>
    resolveTrigger(payload, baseConfig())
  );

  assert.equal(trigger.pullNumber, 77);
  assert.equal(trigger.source, "pull_request_review_comment");
  assert.equal(trigger.ackCommentId, 555);
  assert.equal(trigger.focus, "this hunk");
});

test("the pull_request event still works, for repos that want an automatic pass", () => {
  const payload = {
    action: "opened",
    number: 5,
    repository: { name: "rocks-api", owner: { login: "full-scale-teams" } },
  };

  const trigger = asEvent("pull_request", () =>
    resolveTrigger(payload, baseConfig())
  );

  assert.equal(trigger.pullNumber, 5);
  assert.equal(trigger.source, "pull_request");
  assert.equal(trigger.ackCommentId, null);
});

test("workflow_dispatch reviews the pull request named by PR_NUMBER", () => {
  const payload = {
    repository: { name: "rocks-api", owner: { login: "full-scale-teams" } },
  };

  const trigger = asEvent("workflow_dispatch", () =>
    resolveTrigger(payload, baseConfig({ pullNumber: 123 }))
  );

  assert.equal(trigger.pullNumber, 123);
  assert.equal(trigger.source, "manual");
});

test("workflow_dispatch without PR_NUMBER skips rather than crashing", () => {
  expectSkip(
    "workflow_dispatch",
    { repository: { name: "rocks-api", owner: { login: "full-scale-teams" } } },
    undefined,
    /PR_NUMBER/
  );
});
