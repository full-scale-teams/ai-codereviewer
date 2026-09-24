import * as core from "@actions/core";
import parseDiff from "parse-diff";

import { loadConfig, type ActionConfig } from "./config";
import { mapWithConcurrency } from "./concurrency";
import {
  buildReviewUnits,
  countAddedLines,
  selectReviewableFiles,
} from "./diff";
import { buildSummary, dedupe, toFindings, type Finding } from "./findings";
import {
  describeError,
  GitHubClient,
  readEventPayload,
  resolveTrigger,
  SkipRun,
  type PullRequestDetails,
  type Trigger,
} from "./github";
import { buildInput, buildInstructions } from "./prompt";
import { Reviewer } from "./reviewer";

interface SummaryInput {
  config: ActionConfig;
  pr: PullRequestDetails;
  filesReviewed: number;
  skippedFiles?: string[];
  findings?: Finding[];
  unanchored?: Finding[];
  /** The endpoint actually used, which differs from config after a fallback. */
  endpoint?: string;
}

function summaryFor({
  config,
  pr,
  filesReviewed,
  skippedFiles = [],
  findings = [],
  unanchored = [],
  endpoint = config.endpoint,
}: SummaryInput): string {
  return buildSummary({
    model: config.model,
    endpoint,
    headSha: pr.headSha,
    filesReviewed,
    skippedFiles,
    findings,
    unanchored,
  });
}

async function review(
  config: ActionConfig,
  github: GitHubClient,
  trigger: Trigger,
  manual: boolean
): Promise<void> {
  const { owner, repo, pullNumber } = trigger;

  const pr = await github.getPullRequest(owner, repo, pullNumber);
  if (pr.state !== "open") {
    core.info(`Pull request is ${pr.state}; nothing to review.`);
    return;
  }

  const diff = await github.getDiff(owner, repo, pullNumber);
  const reviewable = selectReviewableFiles(
    parseDiff(diff),
    config.excludePatterns
  );

  if (reviewable.length === 0) {
    core.info("No reviewable files in this diff.");
    if (manual) {
      await github.postComment(
        owner,
        repo,
        pullNumber,
        summaryFor({ config, pr, filesReviewed: 0 })
      );
    }
    return;
  }

  // Cap by size so an enormous pull request cannot run away with the API
  // budget. The largest diffs are the ones most worth reviewing, so they win.
  const ranked = [...reviewable].sort(
    (a, b) => countAddedLines(b) - countAddedLines(a)
  );
  const selected = ranked.slice(0, config.maxFiles);
  const skippedFiles = ranked
    .slice(config.maxFiles)
    .map((file) => file.to ?? "(unknown)");

  const units = selected.flatMap((file) =>
    buildReviewUnits(file, config.maxRequestChars)
  );
  core.info(
    `Sending ${units.length} request(s) covering ${selected.length} file(s) to "${config.model}".`
  );

  const instructions = buildInstructions(
    config.promptOverride,
    config.projectContext
  );
  const reviewer = new Reviewer(config);

  const perUnit = await mapWithConcurrency(
    units,
    config.concurrency,
    async (unit) => {
      const raw = await reviewer.review(
        instructions,
        buildInput(unit, {
          title: pr.title,
          description: pr.description,
          focus: trigger.focus,
          projectContext: config.projectContext,
        })
      );

      return toFindings(unit, raw);
    }
  );

  const all = dedupe(perUnit.flat());
  const findings = all.slice(0, config.maxComments);

  if (all.length > findings.length) {
    core.info(
      `Reporting the ${findings.length} most severe of ${all.length} findings (MAX_COMMENTS).`
    );
  }

  if (findings.length === 0) {
    core.info("No issues found.");
    if (manual) {
      await github.postComment(
        owner,
        repo,
        pullNumber,
        summaryFor({
          config,
          pr,
          filesReviewed: selected.length,
          skippedFiles,
          endpoint: reviewer.activeEndpoint,
        })
      );
    }
    return;
  }

  const result = await github.submitReview(
    owner,
    repo,
    pullNumber,
    pr.headSha,
    summaryFor({
      config,
      pr,
      filesReviewed: selected.length,
      skippedFiles,
      findings,
      endpoint: reviewer.activeEndpoint,
    }),
    findings
  );

  // On the batch path the summary rode along as the review body. On the
  // degraded path there was no review to carry it, so post it once here — now
  // that we know which findings could not be attached to a line.
  if (!result.summaryPosted) {
    await github.postComment(
      owner,
      repo,
      pullNumber,
      summaryFor({
        config,
        pr,
        filesReviewed: selected.length,
        skippedFiles,
        findings,
        unanchored: result.unanchored,
        endpoint: reviewer.activeEndpoint,
      })
    );
  }

  core.info(`Posted ${result.posted} inline comment(s).`);
}

async function run(): Promise<void> {
  const config = loadConfig();
  const payload = readEventPayload();

  let trigger: Trigger;
  try {
    trigger = resolveTrigger(payload, config);
  } catch (error) {
    if (error instanceof SkipRun) {
      core.info(`No review requested: ${error.message}`);
      return;
    }
    throw error;
  }

  const github = new GitHubClient(config.githubToken);
  const manual = trigger.source !== "pull_request";
  const { owner, repo, pullNumber, ackCommentId } = trigger;

  core.info(
    `Reviewing ${owner}/${repo}#${pullNumber} (triggered by ${trigger.source}).`
  );

  if (ackCommentId !== null) {
    await github.react(owner, repo, trigger.source, ackCommentId, "eyes");
  }

  try {
    await review(config, github, trigger, manual);

    if (ackCommentId !== null) {
      await github.react(owner, repo, trigger.source, ackCommentId, "rocket");
    }
  } catch (error) {
    // Someone asked for this review and is watching the comment thread, not the
    // Actions log, so the failure has to surface on the pull request.
    if (manual) {
      if (ackCommentId !== null) {
        await github.react(
          owner,
          repo,
          trigger.source,
          ackCommentId,
          "confused"
        );
      }

      await github
        .postComment(
          owner,
          repo,
          pullNumber,
          [
            "### 🤖 AI code review",
            "",
            "The review could not be completed.",
            "",
            "```",
            describeError(error),
            "```",
            "",
            "<sub>See the workflow run log for details.</sub>",
          ].join("\n")
        )
        .catch((commentError) =>
          core.warning(
            `Could not post the failure comment: ${describeError(commentError)}`
          )
        );
    }

    throw error;
  }
}

run().catch((error) => {
  core.setFailed(describeError(error));
});
