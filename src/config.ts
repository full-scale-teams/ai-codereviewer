import * as core from "@actions/core";

/**
 * Which OpenAI endpoint to drive the review with.
 *
 * `responses` is the current OpenAI endpoint and the default. `chat` is kept as
 * an escape hatch so a workflow can fall back without redeploying the action if
 * an organisation or model has not been enabled for the Responses API yet.
 */
export type OpenAIEndpoint = "responses" | "chat";

export interface ActionConfig {
  githubToken: string;
  openAIApiKey: string;
  model: string;
  endpoint: OpenAIEndpoint;
  temperature: number;
  maxOutputTokens: number;
  /** Full replacement for the built-in reviewer instructions. Usually empty. */
  promptOverride: string;
  /** Extra repository context appended to the built-in instructions. */
  projectContext: string;
  excludePatterns: string[];
  triggerPhrase: string;
  /** `author_association` values allowed to trigger a review from a comment. */
  allowedAssociations: string[];
  /** Explicit PR number, for `workflow_dispatch` runs. `null` when unset. */
  pullNumber: number | null;
  maxFiles: number;
  maxComments: number;
  /** Character budget for one model request's rendered diff. */
  maxRequestChars: number;
  concurrency: number;
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Reads a positive integer input, falling back to `fallback` when the input is
 * blank. An input that is present but not a positive integer is a workflow
 * authoring mistake, so it fails loudly rather than silently using the default.
 */
function readPositiveInt(name: string, fallback: number): number {
  const raw = core.getInput(name).trim();
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Input "${name}" must be a positive integer, got "${raw}".`
    );
  }

  return parsed;
}

function readTemperature(fallback: number): number {
  const raw = core.getInput("OPENAI_TEMPERATURE").trim();
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
    throw new Error(
      `Input "OPENAI_TEMPERATURE" must be a number between 0 and 2, got "${raw}".`
    );
  }

  return parsed;
}

function readEndpoint(): OpenAIEndpoint {
  const raw = core.getInput("OPENAI_API_ENDPOINT").trim().toLowerCase();
  if (!raw) return "responses";
  if (raw === "responses" || raw === "chat") return raw;

  throw new Error(
    `Input "OPENAI_API_ENDPOINT" must be "responses" or "chat", got "${raw}".`
  );
}

function readPullNumber(): number | null {
  const raw = core.getInput("PR_NUMBER").trim();
  if (!raw) return null;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Input "PR_NUMBER" must be a positive integer, got "${raw}".`
    );
  }

  return parsed;
}

const DEFAULT_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

function readAssociations(): string[] {
  const configured = splitList(core.getInput("ALLOWED_ASSOCIATIONS"));
  const values = configured.length > 0 ? configured : DEFAULT_ASSOCIATIONS;

  return values.map((value) => value.toUpperCase());
}

function readRequired(name: string): string {
  const value = core.getInput(name).trim();
  if (!value) {
    throw new Error(`Input "${name}" is required but was empty.`);
  }

  return value;
}

export function loadConfig(): ActionConfig {
  return {
    githubToken: readRequired("GITHUB_TOKEN"),
    openAIApiKey: readRequired("OPENAI_API_KEY"),
    model: core.getInput("OPENAI_API_MODEL").trim() || "gpt-4o",
    endpoint: readEndpoint(),
    temperature: readTemperature(0.2),
    maxOutputTokens: readPositiveInt("OPENAI_MAX_OUTPUT_TOKENS", 2000),
    promptOverride: core.getInput("REVIEW_PROMPT").trim(),
    projectContext: core.getInput("PROJECT_CONTEXT").trim(),
    excludePatterns: splitList(core.getInput("exclude")),
    triggerPhrase: core.getInput("TRIGGER_PHRASE").trim() || "@openai review",
    allowedAssociations: readAssociations(),
    pullNumber: readPullNumber(),
    maxFiles: readPositiveInt("MAX_FILES", 40),
    maxComments: readPositiveInt("MAX_COMMENTS", 25),
    maxRequestChars: readPositiveInt("MAX_REQUEST_CHARS", 12000),
    concurrency: readPositiveInt("CONCURRENCY", 3),
  };
}
