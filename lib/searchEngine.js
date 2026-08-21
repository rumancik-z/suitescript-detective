// lib/searchEngine.js — high-level search entry point.
//
// Delegates the actual scan to lib/query.js. Raw regex searches (potentially
// slow / catastrophic backtracking) run through a deadline-checked async scan so
// a pathological pattern can be aborted rather than freezing the service worker.
//
// Note on threading: this module always executes inside the MV3 service worker
// (background.js), which CANNOT spawn dedicated workers (`new Worker()` is
// undefined there). So regex searches use the cooperative `scanSourcesAsync`,
// which yields between sources and aborts once REGEX_TIMEOUT_MS is exceeded.
// This guards the common cases (many sources / many lines); a pathological
// pattern on a single very long line cannot be interrupted in-process, but the
// background's regexMaxLines filter already excludes huge/minified files.

import { REGEX_TIMEOUT_MS } from "./constants.js";
import { buildQuery, scanSources, scanSourcesAsync } from "./query.js";

/**
 * Search source records for a query built from `queryConfig`.
 *
 * @param {import('./constants.js').SourceRecord[]} sources
 * @param {{text?: string, chips?: string[], chipMode?: 'and'|'or', caseSensitive?: boolean, regex?: boolean, wholeWord?: boolean}} queryConfig
 * @param {{cap?: number, sort?: 'relevance'|'file'|'folder'|'line'}} [options]
 * @returns {Promise<{hits: object[], truncated: boolean, scanned: number, error?: string}>}
 */
export const search = async (sources, queryConfig, options = {}) => {
  try {
    const query = buildQuery(queryConfig || {});
    if (!query) {
      return { hits: [], truncated: false, scanned: sources.length };
    }
    // Raw regex runs through the deadline-checked async scan so a pathological
    // pattern can be aborted rather than freezing the service worker.
    if (queryConfig && queryConfig.regex) {
      return scanSourcesAsync(sources, query, options, REGEX_TIMEOUT_MS);
    }
    return scanSources(sources, query, options);
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
};

// Re-export for convenience / compatibility.
export { buildQuery };
