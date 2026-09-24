import { readFileSync } from "fs";

import { Octokit } from "@octokit/rest";

import type { ActionConfig } from "./config";

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface SubmitResult<T extends ReviewComment> {
  /** Comments successfully attached to a line. */
  posted: number;
  /** Findings GitHub refused to anchor; the caller must surface them. */
  unanchored: T[];
  /** Whether the summary already reached the pull request, as the review body. */
  summaryPosted: boolean;
}

export interface PullRequestDetails {
  title: string;
  description: string;
  headSha: string;
  state: string;
  draft: boolean;
}

export type TriggerSource =
  | "issue_comment"
  | "pull_request_review_comment"
  | "pull_request"
  | "manual";

export interface Trigger {
  owner: string;
  repo: string;
  pullNumber: number;
  source: TriggerSource;
  /** Extra steer typed after the trigger phrase. Empty when there was none. */
  focus: string;
  /** Comment to react to, so the developer sees the run was picked up. */
  ackCommentId: number | null;
}

/** Thrown when the event should not produce a review. Not an error condition. */
export class SkipRun extends Error {}

/** Comment text after the trigger phrase is prompt input; keep it bounded. */
const MAX_FOCUS_CHARS = 1000;

interface EventPayload {
  action?: string;
  number?: number;
  issue?: {
    number?: number;
    pull_request?: unknown;
  };
  pull_request?: {
    number?: number;
  };
  comment?: {
    id?: number;
    body?: string;
    author_association?: string;
    user?: { login?: string; type?: string };
  };
  repository?: {
    name?: string;
    owner?: { login?: string };
  };
}

export function readEventPayload(): EventPayload {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) {
    throw new Error(
      "GITHUB_EVENT_PATH is not set; this must run in GitHub Actions."
    );
  }

  return JSON.parse(readFileSync(path, "utf8")) as EventPayload;
}

function requireRepository(payload: EventPayload): {
  owner: string;
  repo: string;
} {
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;

  if (!owner || !repo) {
    throw new Error("Event payload is missing repository owner/name.");
  }

  return { owner, repo };
}

function isBot(payload: EventPayload): boolean {
  const user = payload.comment?.user;
  return user?.type === "Bot" || Boolean(user?.login?.endsWith("[bot]"));
}

/**
 * Splits a triggering comment into "was it a trigger" and "what came after".
 *
 * The remainder lets a developer steer the run inline, e.g.
 * `@openai review focus on the new query in ReportRepository`.
 */
function matchTriggerPhrase(
  body: string,
  triggerPhrase: string
): { matched: boolean; focus: string } {
  const index = body.toLowerCase().indexOf(triggerPhrase.toLowerCase());
  if (index === -1) return { matched: false, focus: "" };

  const focus = body
    .slice(index + triggerPhrase.length)
    .replace(/^[\s:,.-]+/, "")
    .trim()
    .slice(0, MAX_FOCUS_CHARS);

  return { matched: true, focus };
}

function resolveCommentTrigger(
  payload: EventPayload,
  config: ActionConfig,
  source: "issue_comment" | "pull_request_review_comment"
): Trigger {
  if (payload.action !== "created") {
    throw new SkipRun(
      `Ignoring "${payload.action}" comment event; only new comments trigger a review.`
    );
  }

  if (source === "issue_comment" && !payload.issue?.pull_request) {
    throw new SkipRun("Comment is on an issue, not a pull request.");
  }

  if (isBot(payload)) {
    throw new SkipRun("Comment was written by a bot.");
  }

  const body = payload.comment?.body ?? "";
  const { matched, focus } = matchTriggerPhrase(body, config.triggerPhrase);

  if (!matched) {
    throw new SkipRun(
      `Comment does not contain the trigger phrase "${config.triggerPhrase}".`
    );
  }

  const association = (
    payload.comment?.author_association ?? "NONE"
  ).toUpperCase();
  if (!config.allowedAssociations.includes(association)) {
    throw new SkipRun(
      `@${
        payload.comment?.user?.login ?? "unknown"
      } has association ${association}, ` +
        `which is not in ALLOWED_ASSOCIATIONS (${config.allowedAssociations.join(
          ", "
        )}).`
    );
  }

  const pullNumber =
    source === "issue_comment"
      ? payload.issue?.number
      : payload.pull_request?.number;

  if (!pullNumber) {
    throw new Error(
      "Could not determine the pull request number from the comment event."
    );
  }

  return {
    ...requireRepository(payload),
    pullNumber,
    source,
    focus,
    ackCommentId: payload.comment?.id ?? null,
  };
}

/**
 * Decides whether this event should produce a review, and for which PR.
 *
 * Throws `SkipRun` for the ordinary "not for us" cases so the caller can exit
 * successfully; throws `Error` only when the event is genuinely malformed.
 */
export function resolveTrigger(
  payload: EventPayload,
  config: ActionConfig
): Trigger {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";

  if (
    eventName === "issue_comment" ||
    eventName === "pull_request_review_comment"
  ) {
    return resolveCommentTrigger(payload, config, eventName);
  }

  const pullNumber =
    config.pullNumber ?? payload.number ?? payload.pull_request?.number ?? null;

  if (!pullNumber) {
    throw new SkipRun(
      `Event "${eventName || "unknown"}" carries no pull request number. ` +
        `Pass PR_NUMBER to review a specific pull request.`
    );
  }

  return {
    ...requireRepository(payload),
    pullNumber,
    source: eventName === "pull_request" ? "pull_request" : "manual",
    focus: "",
    ackCommentId: null,
  };
}

export class GitHubClient {
  private readonly octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({
      auth: token,
      // Actions sets this on every runner; honouring it is what makes the
      // action work on GitHub Enterprise Server rather than only github.com.
      baseUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    });
  }

  async getPullRequest(
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<PullRequestDetails> {
    const { data } = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });

    return {
      title: data.title ?? "",
      description: data.body ?? "",
      headSha: data.head.sha,
      state: data.state,
      draft: Boolean(data.draft),
    };
  }

  /**
   * Fetches the full PR diff.
   *
   * A manually requested review always covers the whole pull request. Upstream
   * used a `compareCommits` between the pushed SHAs for `synchronize` events,
   * which reviews only the newest push — correct for an auto-run on every push,
   * wrong for "review this PR".
   */
  async getDiff(
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<string> {
    const response = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      mediaType: { format: "diff" },
    });

    // The `diff` media type makes the response body a string rather than the
    // JSON object the generated types describe.
    return response.data as unknown as string;
  }

  /** Best-effort acknowledgement. A failed reaction must never fail the run. */
  async react(
    owner: string,
    repo: string,
    source: TriggerSource,
    commentId: number,
    content: "eyes" | "rocket" | "confused"
  ): Promise<void> {
    try {
      if (source === "pull_request_review_comment") {
        await this.octokit.reactions.createForPullRequestReviewComment({
          owner,
          repo,
          comment_id: commentId,
          content,
        });
      } else {
        await this.octokit.reactions.createForIssueComment({
          owner,
          repo,
          comment_id: commentId,
          content,
        });
      }
    } catch (error) {
      console.warn(
        `Could not add the "${content}" reaction:`,
        describeError(error)
      );
    }
  }

  async postComment(
    owner: string,
    repo: string,
    pullNumber: number,
    body: string
  ): Promise<void> {
    await this.octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });
  }

  /**
   * Submits the inline review, degrading rather than failing.
   *
   * `pulls.createReview` rejects the entire review with a 422 if any single
   * comment cannot be anchored, which would throw away every finding over one
   * bad line. On failure each comment is retried individually.
   *
   * The summary is deliberately NOT posted here. On the batch path it rides
   * along as the review body; on the degraded path there is no review to carry
   * it, so the caller posts it once — knowing which findings ended up
   * unanchored. Posting it in both places is how this ended up double-commenting.
   */
  async submitReview<T extends ReviewComment>(
    owner: string,
    repo: string,
    pullNumber: number,
    commitId: string,
    summary: string,
    comments: T[]
  ): Promise<SubmitResult<T>> {
    try {
      await this.octokit.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: commitId,
        event: "COMMENT",
        body: summary,
        comments: comments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: "RIGHT",
          body: comment.body,
        })),
      });

      return { posted: comments.length, unanchored: [], summaryPosted: true };
    } catch (error) {
      console.warn(
        "Batch review submission failed; retrying comments individually.",
        describeError(error)
      );
    }

    const unanchored: T[] = [];

    for (const comment of comments) {
      try {
        await this.octokit.pulls.createReviewComment({
          owner,
          repo,
          pull_number: pullNumber,
          commit_id: commitId,
          path: comment.path,
          line: comment.line,
          side: "RIGHT",
          body: comment.body,
        });
      } catch (error) {
        console.warn(
          `Could not anchor a comment to ${comment.path}:${comment.line}.`,
          describeError(error)
        );
        unanchored.push(comment);
      }
    }

    return {
      posted: comments.length - unanchored.length,
      unanchored,
      summaryPosted: false,
    };
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
