import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const REVIEW_PROMPT: string = core.getInput("REVIEW_PROMPT");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

interface AIReview {
  lineNumber: string;
  reviewComment: string;
}

interface ReviewComment {
  body: string;
  path: string;
  line: number;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );

  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });

  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
    owner: string,
    repo: string,
    pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });

  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
    parsedDiff: File[],
    prDetails: PRDetails
): Promise<ReviewComment[]> {
  const comments: ReviewComment[] = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue;

    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);

      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments.length > 0) {
          comments.push(...newComments);
        }
      }
    }
  }

  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  const defaultPrompt = `You are a senior code reviewer for a production Laravel and Vue application.

Your job is to review pull request diffs and report only actionable, high-value issues.
Do not provide praise, summaries, explanations of what the code does, or low-value suggestions.

Return valid JSON only in this format:
{"reviews":[{"lineNumber":123,"reviewComment":"comment here"}]}

Rules:
- Only report issues that are important enough to justify a GitHub PR comment.
- Do not comment unless the issue could cause a bug, security problem, performance regression, broken UX, or meaningful maintenance risk.
- If there are no meaningful issues, return {"reviews":[]}.
- Keep comments concise, direct, and specific.
- Write in GitHub Markdown format.
- Do not repeat what is already obvious from the diff.
- Do not suggest adding comments to the code.
- Do not make style-only suggestions unless they affect correctness, maintainability, security, or readability in a meaningful way.
- Do not comment on formatting, naming preferences, or minor refactoring ideas unless they create a real problem.
- Prefer one strong comment over several small overlapping comments.
- Only comment on changed lines or on a nearby changed line when necessary for context.
- Do not speculate. Comment only when the risk is reasonably supported by the diff.
- Do not mention that you are an AI.
- Only use line numbers that correspond to added lines in the provided diff.
- Do not comment on deleted lines, file-level concerns, or guessed line numbers.
- If no valid added line is appropriate, return {"reviews":[]}.

Review priorities:
- Correctness, edge cases, and data integrity
- Laravel validation, authorization, Eloquent/query efficiency, transactions, queues, cache behavior, API compatibility, and unsafe input handling
- Vue reactivity, async state handling, prop misuse, rendering logic, event/timer cleanup, XSS risk, and form behavior
- Laravel/Vue contract mismatches between backend responses and frontend expectations
- Maintainability issues only when they create real fragility or future bug risk

Comment style:
- Start with the issue.
- Briefly explain the risk.
- Suggest a fix only when it is clear and short.
- Keep the tone neutral and professional.
- Avoid long comments.

Use the pull request title and description only as context. Review only the code changes.`;

  const promptHeader = REVIEW_PROMPT?.trim() ? REVIEW_PROMPT : defaultPrompt;

  return `${promptHeader}

Pull request title: ${prDetails.title}
Pull request description:
---
${prDetails.description}
---

Review the following code diff for file "${file.to}":
\`\`\`diff
${chunk.content}
${chunk.changes
      // @ts-expect-error
      .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
      .join("\n")}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<AIReview[] | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
  };

  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        ...queryConfig,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: prompt,
          },
        ],
      });

      const res =
          response.choices[0].message?.content?.trim() || '{"reviews":[]}';

      const parsed = JSON.parse(res);

      if (!parsed.reviews || !Array.isArray(parsed.reviews)) {
        console.warn("Invalid reviews format:", parsed);
        return [];
      }

      return parsed.reviews;
    } catch (error) {
      console.warn(`Retry ${attempt + 1} failed`, error);

      if (attempt === maxRetries) {
        console.error("Final failure calling OpenAI:", error);
        return null;
      }

      await new Promise((resolve) =>
          setTimeout(resolve, 1000 * (attempt + 1))
      );
    }
  }

  return null;
}

function createComment(
    file: File,
    chunk: Chunk,
    aiResponses: AIReview[]
): ReviewComment[] {
  const filePath = file.to;

  if (!filePath) {
    return [];
  }

  const validLines = new Set<number>();

  for (const change of chunk.changes) {
    if (change.type === "add" && typeof change.ln === "number") {
      validLines.add(change.ln);
    }
  }

  return aiResponses.flatMap((aiResponse) => {
    const line = Number(aiResponse.lineNumber);
    const body = aiResponse.reviewComment?.trim();

    if (!Number.isInteger(line) || !validLines.has(line)) {
      console.warn(
          `Skipping invalid review comment for ${filePath} at line ${aiResponse.lineNumber}`
      );
      return [];
    }

    if (!body) {
      console.warn(
          `Skipping empty review comment for ${filePath} at line ${aiResponse.lineNumber}`
      );
      return [];
    }

    return {
      body,
      path: filePath,
      line,
    };
  });
}

function dedupeComments(comments: ReviewComment[]): ReviewComment[] {
  return Array.from(
      new Map(
          comments.map((comment) => [
            `${comment.path}:${comment.line}:${comment.body}`,
            comment,
          ])
      ).values()
  );
}

async function createReviewComment(
    owner: string,
    repo: string,
    pull_number: number,
    comments: ReviewComment[]
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;

  const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
      .getInput("exclude")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
        minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  const uniqueComments = dedupeComments(comments);

  if (uniqueComments.length > 0) {
    await createReviewComment(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        uniqueComments
    );
  } else {
    console.log("No valid review comments to submit");
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});