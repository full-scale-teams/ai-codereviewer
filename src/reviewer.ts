import OpenAI from "openai";

import type { ActionConfig } from "./config";
import { REVIEW_SCHEMA, SEVERITIES, type Severity } from "./prompt";

export interface RawFinding {
  lineNumber: number;
  severity: Severity;
  reviewComment: string;
}

const SCHEMA_NAME = "code_review";

/** Reasoning models reject `temperature`; detected from the 400 and retried without it. */
function isUnsupportedTemperatureError(error: unknown): boolean {
  return (
    error instanceof OpenAI.APIError &&
    error.status === 400 &&
    /temperature/i.test(error.message)
  );
}

function isSeverity(value: unknown): value is Severity {
  return SEVERITIES.includes(value as Severity);
}

/**
 * Validates the model's output before it reaches the GitHub layer.
 *
 * Structured Outputs makes a malformed shape very unlikely, but the `chat`
 * fallback path and future model changes both make this worth keeping: a bad
 * entry is dropped with a warning rather than failing the whole run.
 */
export function parseFindings(raw: string): RawFinding[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(
      `Model returned output that is not valid JSON: ${raw.slice(0, 200)}`
    );
    return [];
  }

  const reviews = (parsed as { reviews?: unknown })?.reviews;
  if (!Array.isArray(reviews)) {
    console.warn(
      "Model output has no `reviews` array; treating as no findings."
    );
    return [];
  }

  return reviews.flatMap((entry): RawFinding[] => {
    const { lineNumber, severity, reviewComment } = (entry ?? {}) as Record<
      string,
      unknown
    >;

    const line = Number(lineNumber);
    const comment =
      typeof reviewComment === "string" ? reviewComment.trim() : "";

    if (!Number.isInteger(line) || line <= 0 || !comment) {
      console.warn(`Dropping malformed finding: ${JSON.stringify(entry)}`);
      return [];
    }

    return [
      {
        lineNumber: line,
        severity: isSeverity(severity) ? severity : "minor",
        reviewComment: comment,
      },
    ];
  });
}

/**
 * Drives one OpenAI endpoint to produce findings for a single diff.
 *
 * Transport-level retries (429, 5xx, connection resets) are delegated to the
 * OpenAI SDK, which already implements them with backoff and honours
 * `Retry-After`.
 */
export class Reviewer {
  private readonly client: OpenAI;
  private temperature: number | undefined;

  constructor(private readonly config: ActionConfig) {
    this.client = new OpenAI({
      apiKey: config.openAIApiKey,
      maxRetries: 3,
      timeout: 120_000,
    });
    this.temperature = config.temperature;
  }

  async review(instructions: string, input: string): Promise<RawFinding[]> {
    try {
      return await this.request(instructions, input);
    } catch (error) {
      if (
        !isUnsupportedTemperatureError(error) ||
        this.temperature === undefined
      ) {
        throw error;
      }

      console.warn(
        `Model "${this.config.model}" does not accept a temperature; retrying without it.`
      );
      this.temperature = undefined;

      return this.request(instructions, input);
    }
  }

  private request(instructions: string, input: string): Promise<RawFinding[]> {
    return this.config.endpoint === "responses"
      ? this.viaResponses(instructions, input)
      : this.viaChatCompletions(instructions, input);
  }

  /** The current OpenAI endpoint, with Structured Outputs. */
  private async viaResponses(
    instructions: string,
    input: string
  ): Promise<RawFinding[]> {
    const response = await this.client.responses.create({
      model: this.config.model,
      instructions,
      input,
      max_output_tokens: this.config.maxOutputTokens,
      ...(this.temperature === undefined
        ? {}
        : { temperature: this.temperature }),
      text: {
        format: {
          type: "json_schema",
          name: SCHEMA_NAME,
          strict: true,
          schema: REVIEW_SCHEMA,
        },
      },
      // Private source code: do not let the request be retained for training
      // or made available in the dashboard.
      store: false,
    });

    if (response.status === "incomplete") {
      console.warn(
        `Response truncated (${
          response.incomplete_details?.reason ?? "unknown reason"
        }). ` +
          `Consider raising OPENAI_MAX_OUTPUT_TOKENS or lowering MAX_REQUEST_CHARS.`
      );
    }

    return parseFindings(response.output_text ?? "");
  }

  /** Legacy endpoint, kept selectable via `OPENAI_API_ENDPOINT: chat`. */
  private async viaChatCompletions(
    instructions: string,
    input: string
  ): Promise<RawFinding[]> {
    const completion = await this.client.chat.completions.create({
      model: this.config.model,
      max_tokens: this.config.maxOutputTokens,
      ...(this.temperature === undefined
        ? {}
        : { temperature: this.temperature }),
      response_format: {
        type: "json_schema",
        json_schema: {
          name: SCHEMA_NAME,
          strict: true,
          schema: REVIEW_SCHEMA,
        },
      },
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: input },
      ],
    });

    const choice = completion.choices[0];

    if (choice?.finish_reason === "length") {
      console.warn(
        "Completion hit the token limit and was truncated. " +
          "Consider raising OPENAI_MAX_OUTPUT_TOKENS or lowering MAX_REQUEST_CHARS."
      );
    }

    return parseFindings(choice?.message?.content ?? "");
  }
}
