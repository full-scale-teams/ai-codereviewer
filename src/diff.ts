import minimatch from "minimatch";
import type { Change, Chunk, File } from "parse-diff";

/**
 * One request's worth of diff for a single file.
 *
 * A file is normally reviewed in one unit so the model sees all of its changes
 * together. Files whose diff exceeds the character budget are split across
 * several units on chunk boundaries.
 */
export interface ReviewUnit {
  path: string;
  /** Diff rendered with new-file line numbers, ready to embed in a prompt. */
  renderedDiff: string;
  /** New-file line numbers a comment may be anchored to. */
  commentableLines: Set<number>;
  /** 1-based index of this unit and the total, for "part 1 of 2" context. */
  part: number;
  partsTotal: number;
}

const DELETED_FILE_PATH = "/dev/null";
const LINE_NUMBER_COLUMN_WIDTH = 5;

/**
 * Drops files the reviewer must not or cannot comment on: deletions (there is
 * no right-hand side to anchor to), binary/metadata-only entries with no
 * hunks, and anything matching an exclude pattern.
 */
export function selectReviewableFiles(
  files: File[],
  excludePatterns: string[]
): File[] {
  return files.filter((file) => {
    const path = file.to;
    if (!path || path === DELETED_FILE_PATH) return false;
    if (file.deleted) return false;
    if (file.chunks.length === 0) return false;

    return !excludePatterns.some((pattern) => minimatch(path, pattern));
  });
}

/** New-file line number a comment may target, or `null` for deleted lines. */
function newLineNumber(change: Change): number | null {
  switch (change.type) {
    case "add":
      return change.ln;
    case "normal":
      return change.ln2;
    case "del":
      return null;
  }
}

/**
 * Renders a chunk with the *new* file's line numbers in a fixed column.
 *
 * The upstream implementation emitted `change.ln` for both additions and
 * deletions, mixing new-file and old-file numbering in one listing, which led
 * the model to cite line numbers that do not exist on the right-hand side.
 * Deleted lines are shown for context but carry no number, so there is nothing
 * invalid for the model to quote.
 */
function renderChunk(chunk: Chunk): string {
  const lines = chunk.changes.map((change) => {
    const line = newLineNumber(change);
    const label = (line === null ? "-" : String(line)).padStart(
      LINE_NUMBER_COLUMN_WIDTH
    );

    return `${label} | ${change.content}`;
  });

  return [chunk.content, ...lines].join("\n");
}

function collectCommentableLines(chunks: Chunk[]): Set<number> {
  const lines = new Set<number>();

  for (const chunk of chunks) {
    for (const change of chunk.changes) {
      if (change.type === "add") {
        lines.add(change.ln);
      }
    }
  }

  return lines;
}

/**
 * Groups a file's chunks into requests that stay under `maxChars`.
 *
 * Reviewing a whole file in one request (rather than one request per chunk, as
 * upstream did) gives the model the context to spot problems that span hunks,
 * and cuts the number of API calls roughly to the number of changed files.
 */
export function buildReviewUnits(file: File, maxChars: number): ReviewUnit[] {
  const path = file.to;
  if (!path) return [];

  const groups: Chunk[][] = [];
  let current: Chunk[] = [];
  let currentSize = 0;

  for (const chunk of file.chunks) {
    const size = renderChunk(chunk).length;

    if (current.length > 0 && currentSize + size > maxChars) {
      groups.push(current);
      current = [];
      currentSize = 0;
    }

    current.push(chunk);
    currentSize += size;
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups.map((chunks, index) => ({
    path,
    renderedDiff: chunks.map(renderChunk).join("\n"),
    commentableLines: collectCommentableLines(chunks),
    part: index + 1,
    partsTotal: groups.length,
  }));
}

/** Total added lines across a file, used to rank files when capping. */
export function countAddedLines(file: File): number {
  return file.chunks.reduce(
    (total, chunk) =>
      total + chunk.changes.filter((change) => change.type === "add").length,
    0
  );
}
