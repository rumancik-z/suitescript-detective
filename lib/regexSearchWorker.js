// lib/regexSearchWorker.js — dedicated worker that runs regex searches so the
// service worker can enforce a hard timeout (terminating the worker) and never
// block on catastrophic backtracking.

import { buildQuery, scanSources } from "./query.js";

self.onmessage = (e) => {
  const data = e.data || {};
  const sources = data.sources || [];
  const options = data.options || {};
  try {
    const query = buildQuery(data.queryConfig || {});
    if (!query) {
      self.postMessage({ hits: [], truncated: false, scanned: sources.length });
      return;
    }
    const res = scanSources(sources, query, options);
    self.postMessage(res);
  } catch (err) {
    self.postMessage({
      error: err && err.message ? err.message : String(err),
    });
  }
};
