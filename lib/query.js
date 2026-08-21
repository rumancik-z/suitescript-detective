// lib/query.js — search query model, term matchers, boolean parser, and scan.
//
// This module is framework-free and side-effect-free so it can be shared by the
// service worker (inline search) and the regex worker (timeout-guarded search).

import { CONTEXT_RADIUS } from "./constants.js";

/** Escape a literal string for safe use inside a RegExp source. */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A single search term matcher.
 * Built from a raw string plus matching options. Handles plain substring,
 * regex, and whole-word modes with optional case sensitivity.
 */
export class Term {
  /**
   * @param {string} raw
   * @param {{caseSensitive?: boolean, regex?: boolean, wholeWord?: boolean}} [opts]
   */
  constructor(raw, { caseSensitive = false, regex = false, wholeWord = false } = {}) {
    this.raw = raw;
    this.caseSensitive = caseSensitive;
    this.regex = regex;
    this.wholeWord = wholeWord;
    this.re = null;

    if (regex || wholeWord) {
      const base = regex ? raw : escapeRegExp(raw);
      if (!base) throw new Error("Empty search term.");
      const src = wholeWord ? `\\b(?:${base})\\b` : base;
      const flags = caseSensitive ? "" : "i";
      try {
        this.re = new RegExp(src, flags);
      } catch (err) {
        throw new Error(`Invalid regex: ${raw} (${err.message})`);
      }
    }
  }

  /** First match range in `line`, or null. */
  firstMatch(line) {
    if (this.re) {
      const m = this.re.exec(line);
      if (!m) return null;
      return { start: m.index, len: m[0].length || 1 };
    }
    const hay = this.caseSensitive ? line : line.toLowerCase();
    const needle = this.caseSensitive ? this.raw : this.raw.toLowerCase();
    const idx = hay.indexOf(needle);
    return idx === -1 ? null : { start: idx, len: needle.length };
  }

  /** True if `line` contains a match. */
  contains(line) {
    return this.firstMatch(line) !== null;
  }

  /** All match ranges in `line` (for multi-occurrence highlighting). */
  allMatches(line) {
    if (this.re) {
      const flags = (this.caseSensitive ? "" : "i") + "g";
      const re = new RegExp(this.re.source, flags);
      const ranges = [];
      let m;
      while ((m = re.exec(line))) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        ranges.push({ start: m.index, len: m[0].length });
      }
      return ranges;
    }
    const ranges = [];
    const hay = this.caseSensitive ? line : line.toLowerCase();
    const needle = this.caseSensitive ? this.raw : this.raw.toLowerCase();
    if (!needle) return ranges;
    let idx = hay.indexOf(needle);
    while (idx !== -1) {
      ranges.push({ start: idx, len: needle.length });
      idx = hay.indexOf(needle, idx + needle.length);
    }
    return ranges;
  }
}

// ---------------------------------------------------------------------------
// Tokenizer + boolean-expression parser (AND / OR / NOT / "-")
// ---------------------------------------------------------------------------

/**
 * Split free-text into tokens: quoted phrases, negations, operators, and words.
 * @param {string} text
 * @returns {{kind: string, value?: string}[]}
 */
const tokenize = (text) => {
  const out = [];
  const re = /(-?"[^"]*")|(-?\S+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1]) {
      const neg = m[1][0] === "-";
      const inner = m[1].replace(/^-?/, "").replace(/^"|"$/g, "");
      if (!inner) continue;
      out.push(neg ? { kind: "negate", value: inner } : { kind: "phrase", value: inner });
    } else {
      const tok = m[2];
      if (tok.startsWith("-") && tok.length > 1) {
        out.push({ kind: "negate", value: tok.slice(1) });
      } else {
        const up = tok.toUpperCase();
        if (up === "AND") out.push({ kind: "and" });
        else if (up === "OR") out.push({ kind: "or" });
        else if (up === "NOT") out.push({ kind: "not" });
        else out.push({ kind: "term", value: tok });
      }
    }
  }
  return out;
};

const makeTermNode = (value, opts) => ({ kind: "term", term: new Term(value, opts) });

/**
 * Recursive-descent parser. Grammar (AND binds tighter than OR; adjacency is an
 * implicit AND; NOT / "-" negate a single term):
 *   expr    := orExpr
 *   orExpr  := andExpr ( 'OR' andExpr )*
 *   andExpr := unary ( ( 'AND' )? unary )*
 *   unary   := ( 'NOT' | '-' )? primary
 *   primary := word | "phrase"
 *
 * @param {string} text
 * @param {{caseSensitive?: boolean, regex?: boolean, wholeWord?: boolean}} opts
 * @returns {object|null} AST node, or null if there are no terms.
 */
const parseQueryText = (text, opts) => {
  const tokens = tokenize(text);
  if (!tokens.length) return null;
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const parsePrimary = () => {
    const t = peek();
    if (!t) return null;
    if (t.kind === "term" || t.kind === "phrase") {
      next();
      return makeTermNode(t.value, opts);
    }
    if (t.kind === "negate") {
      // "-foo" / "-"phrase"" is a single atomic token carrying its own term.
      next();
      return { kind: "not", child: makeTermNode(t.value, opts) };
    }
    if (t.kind === "not") {
      // "NOT foo" is a prefix operator over the following term.
      next();
      const inner = parsePrimary();
      if (!inner) throw new Error("Expected a search term after NOT.");
      return { kind: "not", child: inner };
    }
    return null;
  };

  const parseAnd = () => {
    let node = parsePrimary();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const t = peek();
      if (!t) break;
      if (t.kind === "term" || t.kind === "phrase" || t.kind === "negate" || t.kind === "not") {
        const rhs = parsePrimary();
        node = node ? { kind: "and", children: [node, rhs] } : rhs;
      } else if (t.kind === "and") {
        next();
        const rhs = parsePrimary();
        if (!rhs) break;
        node = node ? { kind: "and", children: [node, rhs] } : rhs;
      } else {
        break; // 'or' or anything else — handled by parseOr
      }
    }
    return node;
  };

  const parseOr = () => {
    let node = parseAnd();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const t = peek();
      if (t && t.kind === "or") {
        next();
        const rhs = parseAnd();
        if (!rhs) break;
        node = { kind: "or", children: [node, rhs] };
      } else {
        break;
      }
    }
    return node;
  };

  return parseOr();
};

/**
 * Build an AST query from the popup's search configuration. Returns null when
 * there is nothing to search for.
 *
 * @param {{text?: string, chips?: string[], chipMode?: 'and'|'or', caseSensitive?: boolean, regex?: boolean, wholeWord?: boolean}} cfg
 * @returns {object|null} Query AST, or null.
 */
export const buildQuery = (cfg = {}) => {
  const caseSensitive = !!cfg.caseSensitive;
  const regex = !!cfg.regex;
  const wholeWord = !!cfg.wholeWord;
  const opts = { caseSensitive, regex, wholeWord };

  const chips = Array.isArray(cfg.chips)
    ? cfg.chips.map((c) => String(c).trim()).filter(Boolean)
    : [];
  const text = (cfg.text || "").trim();

  if (chips.length) {
    // Chips are the primary criteria; any typed text is an extra criterion
    // that must also match (filtering the results), so the chip group and the
    // text node are AND-combined.
    const children = [
      {
        kind: cfg.chipMode === "and" ? "and" : "or",
        children: chips.map((c) => makeTermNode(c, opts)),
      },
    ];
    if (text) {
      children.push(
        regex
          ? { kind: "term", term: new Term(text, opts) }
          : parseQueryText(text, opts)
      );
    }
    return { kind: "and", children };
  }

  if (!text) return null;

  if (regex) {
    // In regex mode the whole text is a single pattern (no boolean parsing).
    return { kind: "term", term: new Term(text, opts) };
  }

  return parseQueryText(text, opts);
};

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Merge the hits map of `b` into `a`. Maps lineIndex -> Set<Term>.
 * @param {Map<number, Set<Term>>} a
 * @param {Map<number, Set<Term>>} b
 * @returns {Map<number, Set<Term>>}
 */
const mergeHitMaps = (a, b) => {
  for (const [i, terms] of b) {
    if (!a.has(i)) a.set(i, new Set());
    for (const t of terms) a.get(i).add(t);
  }
  return a;
};

/**
 * Evaluate a query AST against a file's lines.
 * @param {object} node
 * @param {string[]} lines
 * @returns {{matched: boolean, hits: Map<number, Set<Term>>}}
 */
export const evalQuery = (node, lines) => {
  switch (node.kind) {
    case "term": {
      const term = node.term;
      const hits = new Map();
      let matched = false;
      for (let i = 0; i < lines.length; i++) {
        if (term.contains(lines[i])) {
          matched = true;
          if (!hits.has(i)) hits.set(i, new Set());
          hits.get(i).add(term);
        }
      }
      return { matched, hits };
    }
    case "not": {
      const r = evalQuery(node.child, lines);
      return { matched: !r.matched, hits: new Map() };
    }
    case "and": {
      const combined = new Map();
      for (const child of node.children) {
        const r = evalQuery(child, lines);
        if (!r.matched) return { matched: false, hits: new Map() };
        mergeHitMaps(combined, r.hits);
      }
      return { matched: true, hits: combined };
    }
    case "or": {
      let matched = false;
      const combined = new Map();
      for (const child of node.children) {
        const r = evalQuery(child, lines);
        if (r.matched) {
          matched = true;
          mergeHitMaps(combined, r.hits);
        }
      }
      return { matched, hits: combined };
    }
    default:
      return { matched: false, hits: new Map() };
  }
};

/**
 * Build the ±CONTEXT_RADIUS context window around a matched line index.
 * @param {string[]} lines
 * @param {number} i zero-based index of the matched line
 * @returns {{context: {n:number, text:string}[], matchIndexInContext: number}}
 */
const buildContext = (lines, i) => {
  const start = Math.max(0, i - CONTEXT_RADIUS);
  const end = Math.min(lines.length - 1, i + CONTEXT_RADIUS);
  const context = [];
  for (let n = start; n <= end; n++) {
    context.push({ n: n + 1, text: lines[n] });
  }
  return { context, matchIndexInContext: i - start };
};

/**
 * Sort hit objects according to a mode.
 * @param {object[]} hits
 * @param {'relevance'|'file'|'folder'|'line'} mode
 * @param {Map<string, number>} counts internalId -> number of hits
 * @returns {object[]}
 */
export const sortHits = (hits, mode, counts) => {
  const arr = hits.slice();
  const byName = (a, b) => {
    const n = a.name.localeCompare(b.name);
    return n || a.lineNumber - b.lineNumber;
  };
  switch (mode) {
    case "file":
      arr.sort(byName);
      break;
    case "folder":
      arr.sort(
        (a, b) =>
          (a.folderPath || "").localeCompare(b.folderPath || "") || byName(a, b)
      );
      break;
    case "line":
      arr.sort((a, b) => a.lineNumber - b.lineNumber || byName(a, b));
      break;
    case "relevance":
    default:
      // Most matches first = most relevant first.
      arr.sort(
        (a, b) =>
          (counts.get(b.internalId) || 0) - (counts.get(a.internalId) || 0) ||
          a.lineNumber - b.lineNumber ||
          a.name.localeCompare(b.name)
      );
  }
  return arr;
};

/**
 * Scan all sources against a query AST and return hits.
 * This is the shared scan used both inline (service worker) and in the regex
 * worker.
 *
 * @param {import('./constants.js').SourceRecord[]} sources
 * @param {object} query AST from {@link buildQuery}
 * @param {{cap?: number, sort?: 'relevance'|'file'|'folder'|'line'}} [options]
 * @returns {{hits: object[], truncated: boolean, scanned: number}}
 */
export const scanSources = (sources, query, options = {}) => {
  const cap = Number.isFinite(options.cap) ? options.cap : Infinity;
  const sort = options.sort || "relevance";
  const hits = [];
  const counts = new Map();

  for (const src of sources) {
    const lines = src.lines || [];
    const { matched, hits: lineHits } = evalQuery(query, lines);
    if (!matched || lineHits.size === 0) continue;

    const sortedLines = [...lineHits.keys()].sort((a, b) => a - b);
    for (const i of sortedLines) {
      const term = [...lineHits.get(i)][0];
      const first = term.firstMatch(lines[i]);
      const ranges = term.allMatches(lines[i]);
      const { context, matchIndexInContext } = buildContext(lines, i);
      hits.push({
        internalId: src.internalId,
        name: src.name,
        folderPath: src.folderPath,
        lineNumber: i + 1,
        matchIndexInContext,
        matchCol: first ? first.start : 0,
        matchText: term.raw,
        matchRanges: ranges,
        context,
      });
      counts.set(src.internalId, (counts.get(src.internalId) || 0) + 1);
      if (hits.length >= cap) {
        return { hits: sortHits(hits, sort, counts), truncated: true, scanned: sources.length };
      }
    }
  }

  return { hits: sortHits(hits, sort, counts), truncated: false, scanned: sources.length };
};

/**
 * Error thrown when a regex search exceeds its allotted time budget.
 * Used by {@link scanSourcesAsync} so the service worker can reject slow
 * (e.g. catastrophically backtracking) patterns instead of freezing.
 */
export class SearchTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "SearchTimeoutError";
    this.isTimeout = true;
  }
}

/**
 * Deadline-checked variant of {@link scanSources}. Yields to the event loop
 * between sources so the MV3 service worker stays responsive and can abort
 * before `timeoutMs` elapses.
 *
 * This is the inline counterpart to the dedicated-worker path used for raw
 * regex searches. Service workers cannot spawn dedicated workers, so this is
 * what actually enforces the timeout there.
 *
 * @param {import('./constants.js').SourceRecord[]} sources
 * @param {object} query AST from {@link buildQuery}
 * @param {{cap?: number, sort?: 'relevance'|'file'|'folder'|'line'}} [options]
 * @param {number} [timeoutMs=0] budget in ms; `0` disables the deadline.
 * @returns {Promise<{hits: object[], truncated: boolean, scanned: number}>}
 * @throws {SearchTimeoutError} if `timeoutMs` is exceeded between sources.
 */
export const scanSourcesAsync = async (sources, query, options = {}, timeoutMs = 0) => {
  const cap = Number.isFinite(options.cap) ? options.cap : Infinity;
  const sort = options.sort || "relevance";
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
  const hits = [];
  const counts = new Map();

  for (const src of sources) {
    if (deadline && Date.now() > deadline) {
      throw new SearchTimeoutError(
        "Regex search timed out. Try a simpler pattern, or disable regex for large files."
      );
    }
    const lines = src.lines || [];
    const { matched, hits: lineHits } = evalQuery(query, lines);
    if (!matched || lineHits.size === 0) {
      // Yield so other messages (e.g. cancel) can still be handled.
      await new Promise((r) => setTimeout(r, 0));
      continue;
    }

    const sortedLines = [...lineHits.keys()].sort((a, b) => a - b);
    for (const i of sortedLines) {
      const term = [...lineHits.get(i)][0];
      const first = term.firstMatch(lines[i]);
      const ranges = term.allMatches(lines[i]);
      const { context, matchIndexInContext } = buildContext(lines, i);
      hits.push({
        internalId: src.internalId,
        name: src.name,
        folderPath: src.folderPath,
        lineNumber: i + 1,
        matchIndexInContext,
        matchCol: first ? first.start : 0,
        matchText: term.raw,
        matchRanges: ranges,
        context,
      });
      counts.set(src.internalId, (counts.get(src.internalId) || 0) + 1);
      if (hits.length >= cap) {
        return { hits: sortHits(hits, sort, counts), truncated: true, scanned: sources.length };
      }
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  return { hits: sortHits(hits, sort, counts), truncated: false, scanned: sources.length };
};
