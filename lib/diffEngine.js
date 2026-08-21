// lib/diffEngine.js — lightweight LCS-based line-level diff

import { CONTEXT_RADIUS } from "./constants.js";

/**
 * A single diff line.
 * @typedef {Object} DiffLine
 * @property {"|"|"+"|"-"} type - "|" for context, "+" for addition, "-" for removal
 * @property {string} value - the line text
 */

/**
 * A contiguous block of changes.
 * @typedef {Object} DiffHunk
 * @property {number} oldStart - 1-based starting line in the old file
 * @property {number} oldLines - number of lines consumed from old file
 * @property {number} newStart - 1-based starting line in the new file
 * @property {number} newLines - number of lines consumed from new file
 * @property {DiffLine[]} lines - the diff lines in this hunk
 */

/**
 * Compute LCS length table via bottom-up DP (Hirschberg-lite, table only).
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number[][]}
 */
const lcsTable = (a, b) => {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
};

/**
 * Backtrack through the LCS table to produce edit opcodes.
 * @param {string[]} a
 * @param {string[]} b
 * @param {number[][]} dp
 * @returns {Array<{tag: "equal"|"delete"|"insert", line: string}>}
 */
const backtrack = (a, b, dp) => {
  const ops = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ tag: "equal", line: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ tag: "insert", line: b[j - 1] });
      j--;
    } else {
      ops.push({ tag: "delete", line: a[i - 1] });
      i--;
    }
  }
  ops.reverse();
  return ops;
};

/**
 * Find contiguous change regions within the opcodes.
 * @param {Array<{tag: string, line: string}>} ops
 * @returns {number[][]} ranges of change indices [start, end) in `ops`
 */
const findChangeRegions = (ops) => {
  const regions = [];
  let start = -1;
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].tag !== "equal") {
      if (start === -1) start = k;
    } else {
      if (start !== -1) {
        regions.push([start, k]);
        start = -1;
      }
    }
  }
  if (start !== -1) regions.push([start, ops.length]);
  return regions;
};

/**
 * Given opcodes and a change region, count how many old/new lines
 * the ops in a slice consume.
 * @param {Array<{tag: string, line: string}>} ops
 * @param {number} lo
 * @param {number} hi
 * @returns {{oldCount: number, newCount: number}}
 */
const countSlice = (ops, lo, hi) => {
  let oldCount = 0, newCount = 0;
  for (let k = lo; k < hi; k++) {
    if (ops[k].tag !== "insert") oldCount++;
    if (ops[k].tag !== "delete") newCount++;
  }
  return { oldCount, newCount };
};

/**
 * Compare two arrays of lines and return a list of diff hunks.
 *
 * Uses a standard LCS algorithm with context-line grouping.
 * Identical inputs return an empty array.
 *
 * @param {string[]} linesA - original file lines
 * @param {string[]} linesB - modified file lines
 * @returns {DiffHunk[]}
 */
export const diffLines = (linesA, linesB) => {
  // Edge: identical (or both empty)
  if (linesA.length === 0 && linesB.length === 0) return [];
  if (linesA.length === linesB.length && linesA.every((l, i) => l === linesB[i]))
    return [];

  const dp = lcsTable(linesA, linesB);
  const ops = backtrack(linesA, linesB, dp);
  const regions = findChangeRegions(ops);

  if (regions.length === 0) return [];

  // Build hunks with context padding around each change region.
  // Each hunk entry: { opsStart, opsEnd } — inclusive range in `ops`.
  /** @type {Array<{opsStart: number, opsEnd: number}>} */
  const hunkRanges = [];
  for (const [cStart, cEnd] of regions) {
    const ctxStart = Math.max(0, cStart - CONTEXT_RADIUS);
    const ctxEnd = Math.min(ops.length - 1, cEnd + CONTEXT_RADIUS);
    if (hunkRanges.length > 0) {
      const prev = hunkRanges[hunkRanges.length - 1];
      if (ctxStart <= prev.opsEnd + 1) {
        prev.opsEnd = ctxEnd; // merge
        continue;
      }
    }
    hunkRanges.push({ opsStart: ctxStart, opsEnd: ctxEnd });
  }

  // Convert to DiffHunk[].
  /** @type {DiffHunk[]} */
  const hunks = [];
  // 1-based line counters (0 for empty files to preserve @@ -0,0 @@ convention)
  let oldPos = linesA.length > 0 ? 1 : 0;
  let newPos = linesB.length > 0 ? 1 : 0;

  // Advance counters to the start of the first hunk.
  const firstStart = hunkRanges[0].opsStart;
  for (let k = 0; k < firstStart; k++) {
    if (ops[k].tag !== "insert") oldPos++;
    if (ops[k].tag !== "delete") newPos++;
  }

  for (const { opsStart, opsEnd } of hunkRanges) {
    const oldStart = oldPos;
    const newStart = newPos;
    /** @type {DiffLine[]} */
    const lines = [];

    for (let k = opsStart; k <= opsEnd; k++) {
      const op = ops[k];
      if (op.tag === "equal") {
        lines.push({ type: "|", value: op.line });
        oldPos++; newPos++;
      } else if (op.tag === "delete") {
        lines.push({ type: "-", value: op.line });
        oldPos++;
      } else {
        lines.push({ type: "+", value: op.line });
        newPos++;
      }
    }

    const { oldCount, newCount } = countSlice(ops, opsStart, opsEnd + 1);
    hunks.push({ oldStart, oldLines: oldCount, newStart, newLines: newCount, lines });
  }

  return hunks;
};
