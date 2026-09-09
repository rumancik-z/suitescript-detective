// lib/fuzzyMatch.js — lightweight fuzzy matching for file names/paths

// Hard cap on scan work (characters explored across the whole enumeration).
// Fuzzy scoring prefers the first (leftmost) candidates, and autocomplete
// only needs a good-enough top match, so cutting off enumeration after this
// much work keeps the worst case (repeated characters over long paths)
// bounded while leaving normal file-name queries untouched.
const NODE_BUDGET = 50000;

/**
 * Fuzzy-match `query` against `text`, preferring consecutive, start-of-word,
 * and start-of-string matches. Subsequence enumeration is bounded by
 * NODE_BUDGET, keeping the worst case (repeated characters over long paths)
 * fast while leaving normal file-name queries untouched.
 *
 * @param {string} query — search term (case-insensitive)
 * @param {string} text  — target string
 * @returns {{score: number, indices: number[]}|null}
 */
export const fuzzyMatch = (query, text) => {
  if (!query) return null;

  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const len = t.length;

  let bestScore = -1;
  let bestIndices = null;
  let nodes = 0;

  let qi = 0;
  const indices = new Array(q.length);

  const scan = (start) => {
    if (qi === q.length) {
      let score = computeScore(q, t, indices);
      if (score > bestScore) {
        bestScore = score;
        bestIndices = indices.slice();
      }
      return;
    }

    for (let i = start; i < len; i++) {
      // Budget counts characters scanned (not just hits): the inner loop's
      // failed-advance iterations dominate the cost on repetitive input.
      if (++nodes > NODE_BUDGET) return; // bounded: keep best match so far
      if (t[i] === q[qi]) {
        indices[qi] = i;
        qi++;
        scan(i + 1);
        qi--;
        if (bestScore === 100) return;
      }

      if (bestScore === 100) return;
    }
  };

  scan(0);
  return bestIndices ? { score: bestScore, indices: bestIndices } : null;
};

/**
 * Score a single match: 0–100, 100 = exact match.
 */
const computeScore = (q, t, indices) => {
  const exact = q.length === t.length && indices[0] === 0;
  if (exact) return 100;

  let raw = 0;

  for (let i = 0; i < q.length; i++) {
    const pos = indices[i];

    raw += 15; // base per character

    // Consecutive run bonus
    if (i > 0 && pos === indices[i - 1] + 1) {
      raw += 12;
    }

    // Start-of-string bonus
    if (pos === 0) {
      raw += 15;
    }

    // Word-boundary bonus (char after / \ _ . - or space)
    if (pos > 0 && /[\/\\_.\- ]/.test(t[pos - 1])) {
      raw += 12;
    }
  }

  // Normalize per character, then apply density factor
  const perChar = raw / q.length;
  const span = indices[indices.length - 1] - indices[0] + 1;
  const density = q.length / span;

  return Math.min(100, Math.round(perChar * density * 3));
};
