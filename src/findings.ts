import type { ReviewUnit } from "./diff";
import type { ReviewComment } from "./github";
import { SEVERITIES, type Severity } from "./prompt";
import type { RawFinding } from "./reviewer";

export interface Finding extends ReviewComment {
  severity: Severity;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: "🔴 **Blocker**",
  major: "🟠 **Major**",
  minor: "🟡 **Minor**",
};

const SEVERITY_RANK: Record<Severity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
};

/**
 * Keeps only findings anchored to a line the model was allowed to comment on.
 *
 * GitHub rejects a review comment whose line is not part of the diff, so this
 * is the guard that stops one invented line number from costing the whole
 * review.
 */
export function toFindings(unit: ReviewUnit, raw: RawFinding[]): Finding[] {
  return raw.flatMap((finding): Finding[] => {
    if (!unit.commentableLines.has(finding.lineNumber)) {
      console.warn(
        `Dropping comment on ${unit.path}:${finding.lineNumber} — not an added line in this diff.`
      );
      return [];
    }

    return [
      {
        path: unit.path,
        line: finding.lineNumber,
        severity: finding.severity,
        body: `${SEVERITY_LABEL[finding.severity]} — ${finding.reviewComment}`,
      },
    ];
  });
}

/**
 * One comment per line, most severe wins, sorted worst-first.
 *
 * Splitting a file across requests, or two chunks touching the same concern,
 * otherwise produces near-duplicate comments on the same line.
 */
export function dedupe(findings: Finding[]): Finding[] {
  const byLocation = new Map<string, Finding>();

  for (const finding of findings) {
    const key = `${finding.path}:${finding.line}`;
    const existing = byLocation.get(key);

    if (
      !existing ||
      SEVERITY_RANK[finding.severity] < SEVERITY_RANK[existing.severity]
    ) {
      byLocation.set(key, finding);
    }
  }

  return [...byLocation.values()].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.path.localeCompare(b.path) ||
      a.line - b.line
  );
}

export function countBySeverity(findings: Finding[]): string {
  return SEVERITIES.flatMap((severity) => {
    const count = findings.filter(
      (finding) => finding.severity === severity
    ).length;
    return count > 0 ? [`${count} ${severity}`] : [];
  }).join(" · ");
}

export interface SummaryOptions {
  model: string;
  endpoint: string;
  headSha: string;
  filesReviewed: number;
  /** Files dropped by the MAX_FILES cap. */
  skippedFiles: string[];
  findings: Finding[];
  /** Findings GitHub refused to anchor; surfaced here so they are not lost. */
  unanchored: Finding[];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function buildSummary(options: SummaryOptions): string {
  const {
    model,
    endpoint,
    headSha,
    filesReviewed,
    skippedFiles,
    findings,
    unanchored,
  } = options;

  const shortSha = headSha.slice(0, 7);
  const lines: string[] = ["### 🤖 AI code review", ""];

  if (findings.length === 0) {
    lines.push(
      `No issues found across **${plural(
        filesReviewed,
        "file"
      )}** at \`${shortSha}\`.`,
      "",
      "This is an automated pass, not a substitute for human review."
    );
  } else {
    lines.push(
      `**${plural(findings.length, "issue")}** across **${plural(
        filesReviewed,
        "file"
      )}** at \`${shortSha}\` — ${countBySeverity(findings)}.`
    );
  }

  if (unanchored.length > 0) {
    lines.push(
      "",
      `<details><summary>${plural(
        unanchored.length,
        "finding"
      )} that could not be attached to a line</summary>`,
      ""
    );

    for (const finding of unanchored) {
      lines.push(
        `- \`${finding.path}:${finding.line}\` — ${finding.body.replace(
          /\s*\n+\s*/g,
          " "
        )}`
      );
    }

    lines.push("", "</details>");
  }

  if (skippedFiles.length > 0) {
    lines.push(
      "",
      `<details><summary>${plural(
        skippedFiles.length,
        "file"
      )} not reviewed (MAX_FILES limit)</summary>`,
      "",
      ...skippedFiles.map((path) => `- \`${path}\``),
      "",
      "</details>"
    );
  }

  lines.push(
    "",
    "---",
    `<sub>Model \`${model}\` via the OpenAI \`${endpoint}\` endpoint. ` +
      `Request another pass by posting the review trigger phrase in a new comment.</sub>`
  );

  return lines.join("\n");
}
