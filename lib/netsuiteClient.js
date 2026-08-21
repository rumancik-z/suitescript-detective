// lib/netsuiteClient.js — NetSuite inventory + content download

import {
  INVENTORY_PATH,
  SCRIPT_FOLDERS,
  FILE_TYPE,
  PAGE_SIZE,
  BATCH_SIZE,
  BATCH_DELAY_MS,
  MAX_RETRIES,
  MINIFIED_MAX_LINE,
  NETSUITE_HOST_RE,
} from "./constants.js";

const HASHMAP = "java.util.HashMap";

// ---- Payload builders -------------------------------------------------------

/**
 * Wrap a scalar string as a NetSuite HashMap value.
 * @param {string} value
 * @returns {{javaClass: string, stringValue: string}}
 */
const str = (value) => ({ javaClass: HASHMAP, stringValue: String(value) });

/**
 * Wrap an array of scalar strings as a NetSuite HashMap array value.
 * @param {string[]} values
 * @returns {{javaClass: string, arrayValue: Array}}
 */
const strArray = (values) => ({ javaClass: HASHMAP, arrayValue: values.map(str) });

/**
 * Build a single search filter triplet: [name, operator, value].
 * @param {string} name
 * @param {string} operator
 * @param {string|string[]} value
 * @returns {{javaClass: string, arrayValue: Array}}
 */
const filter = (name, operator, value) => {
  const valueNode = Array.isArray(value) ? strArray(value) : str(value);
  return {
    javaClass: HASHMAP,
    arrayValue: [str(name), str(operator), valueNode],
  };
};

/**
 * The "AND" join node placed between filters.
 * @returns {{javaClass: string, stringValue: string}}
 */
const andJoin = () => str("AND");

/**
 * Build a result column descriptor.
 * @param {string} name
 * @param {number} userindex
 * @param {string|null} [sortdir]
 * @returns {object}
 */
const column = (name, userindex, sortdir = null) => ({
  name,
  join: null,
  summary: null,
  label: null,
  type: null,
  functionid: null,
  formula: null,
  sortdir,
  whenorderedby: null,
  userindex,
});

/**
 * Build the full searchRecord JSON-RPC body for a given pagination cursor.
 * @param {number|string} cursor - Drives the `internalidnumber greaterthan` filter.
 * @param {string[]} [folders=SCRIPT_FOLDERS] - Top-level folder ids to include.
 * @returns {{id: number, method: string, params: string[][]}}
 */
export const buildSearchBody = (cursor, folders = SCRIPT_FOLDERS) => {
  const filters = [
    filter("folder", "anyof", folders),
    andJoin(),
    filter("filetype", "anyof", FILE_TYPE),
    andJoin(),
    filter("isavailable", "is", "T"),
    andJoin(),
    filter("internalidnumber", "greaterthan", String(cursor)),
  ];

  const columns = [
    column("internalid", 1, "ASC"),
    column("name", 2),
    column("folder", 3),
    column("url", 4),
    column("modified", 5),
  ];

  return {
    id: 8,
    method: "remoteObject.searchRecord",
    params: ["file", null, filters, columns],
  };
};

// ---- Network ----------------------------------------------------------------

/**
 * POST one inventory page for the given cursor.
 * Uses credentials:"include" to reuse the user's NetSuite session cookie.
 * @param {AccountInfo} account
 * @param {number|string} cursor
 * @param {string[]} [folders=SCRIPT_FOLDERS]
 * @returns {Promise<object>} parsed JSON response
 */
export const fetchInventoryPage = async (account, cursor, folders = SCRIPT_FOLDERS) => {
  const url = `${account.origin}${INVENTORY_PATH}`;
  const res = await fetch(url, {
    method: "POST",
    mode: "cors",
    credentials: "include",
    headers: { "content-type": "text/xml; charset=UTF-8" },
    body: JSON.stringify(buildSearchBody(cursor, folders)),
  });

  if (!res.ok) {
    throw new Error(`Inventory request failed: HTTP ${res.status}`);
  }

  // The handler returns JSON even though the request content-type is text/xml.
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Inventory response was not valid JSON.");
  }
};

// ---- Response parsing (single point to update) ------------------------------

/**
 * Pull a printable string out of a column cell that may be scalar or {value,text}.
 * @param {unknown} cell
 * @returns {string}
 */
const cellText = (cell) => {
  if (cell == null) return "";
  if (typeof cell === "string" || typeof cell === "number") return String(cell);
  if (typeof cell === "object") {
    if (cell.text != null && cell.text !== "") return String(cell.text);
    if (cell.value != null) return String(cell.value);
    if (cell.name != null) return String(cell.name);
  }
  return "";
};

/**
 * Pull the underlying id/value out of a column cell.
 * @param {unknown} cell
 * @returns {string}
 */
const cellValue = (cell) => {
  if (cell == null) return "";
  if (typeof cell === "string" || typeof cell === "number") return String(cell);
  if (typeof cell === "object") {
    if (cell.value != null) return String(cell.value);
    if (cell.internalid != null) return String(cell.internalid);
    if (cell.text != null) return String(cell.text);
  }
  return "";
};

/**
 * Read a named column from a record, tolerating several response shapes.
 * @param {object|null} record
 * @param {string} name
 * @returns {unknown}
 */
const readColumn = (record, name) => {
  if (!record) return null;
  if (Array.isArray(record.cells)) {
    const cell = record.cells.find((c) => c && c.name === name);
    return cell ?? null;
  }
  if (record.columns && name in record.columns) return record.columns[name];
  if (name in record) return record[name];
  if (record.values && name in record.values) return record.values[name];
  return null;
};

// A file source URL either points at a hosted asset path (…/c.<ACCT>/…/*.js)
// or the media.nl download endpoint (which carries the required `h=` hash).
const URL_LIKE_RE = /(media\.nl\?|\/c\.[^/]+\/|\.js(\?|$)|https?:\/\/)/i;

/** True if a string looks like a fetchable file URL/path. */
const looksLikeFileUrl = (s) =>
  typeof s === "string" && s.length > 3 && URL_LIKE_RE.test(s);

/**
 * Extract a usable URL from a column cell. Unlike cellText, this prefers a
 * URL-looking string over any human display label (e.g. an anchor's text).
 * @param {unknown} cell
 * @returns {string}
 */
const cellUrl = (cell) => {
  if (cell == null) return "";
  if (typeof cell === "string") return looksLikeFileUrl(cell) ? cell : "";
  if (typeof cell === "object") {
    for (const key of ["value", "url", "href", "text", "name"]) {
      const v = cell[key];
      if (looksLikeFileUrl(v)) return v;
    }
  }
  return "";
};

/**
 * Deep-scan a record for the first URL-looking string. Used as a fallback when
 * the named `url` column can't be read from the (undocumented) response shape.
 * @param {unknown} row
 * @param {number} [depth]
 * @returns {string}
 */
const findUrlInRow = (row, depth = 0) => {
  if (row == null || depth > 4) return "";
  if (typeof row === "string") return looksLikeFileUrl(row) ? row : "";
  if (Array.isArray(row)) {
    for (const item of row) {
      const found = findUrlInRow(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof row === "object") {
    for (const value of Object.values(row)) {
      const found = findUrlInRow(value, depth + 1);
      if (found) return found;
    }
  }
  return "";
};

/**
 * Locate the array of record rows within the JSON-RPC response, tolerating
 * several shapes NetSuite may return.
 * @param {unknown} data
 * @returns {any[]}
 */
const extractRows = (data) => {
  if (!data) return [];
  const result = data.result ?? data;
  if (Array.isArray(result)) return result;
  const candidates = [
    result.records,
    result.recordList,
    result.rows,
    result.results,
    result.data,
    result.searchResult,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
};

/**
 * Parse a raw inventory response into normalized inventory entries.
 * @param {object} data
 * @returns {InventoryEntry[]}
 */
export const parseInventoryResponse = (data) => {
  const rows = extractRows(data);
  const entries = [];

  for (const row of rows) {
    const internalId = cellValue(readColumn(row, "internalid")) || cellValue(row.id);
    if (!internalId) continue;

    // The `url` column holds the real, fetchable file path (a hosted /c.<ACCT>/…
    // asset URL or a media.nl link with the required `h=` hash). Prefer a
    // URL-aware read, then deep-scan the row as a last resort.
    const url =
      cellUrl(readColumn(row, "url")) ||
      cellUrl(readColumn(row, "urlnoproto")) ||
      findUrlInRow(row);

    entries.push({
      internalId: String(internalId),
      name: cellText(readColumn(row, "name")),
      folderPath: cellText(readColumn(row, "folder")),
      url,
      modified: cellText(readColumn(row, "modified")),
    });
  }

  return entries;
};

// ---- Pagination orchestrator ------------------------------------------------

/**
 * Fetch the entire script inventory using cursor pagination.
 * @param {AccountInfo} account
 * @param {object} [opts]
 * @param {number|string} [opts.startCursor=0]
 * @param {(state:{entries: InventoryEntry[], cursor: string, page: number}) => Promise<void>|void} [opts.onPage]
 * @param {() => boolean} [opts.isCancelled]
 * @param {string[]} [opts.folders]
 * @returns {Promise<{entries: InventoryEntry[], cursor: string, pages: number, cancelled: boolean}>}
 */
export const inventoryAll = async (account, opts = {}) => {
  const { startCursor = 0, onPage, isCancelled, folders } = opts;

  const entries = [];
  const seen = new Set();
  let cursor = String(startCursor);
  let page = 0;
  let cancelled = false;

  // Hard ceiling to guarantee termination even on unexpected responses.
  const MAX_PAGES = 1000;

  while (page < MAX_PAGES) {
    if (isCancelled && isCancelled()) {
      cancelled = true;
      break;
    }

    const data = await fetchInventoryPage(account, cursor, folders);
    const rows = parseInventoryResponse(data);
    page += 1;

    if (rows.length === 0) break;

    let maxId = Number(cursor);
    for (const entry of rows) {
      if (seen.has(entry.internalId)) continue;
      seen.add(entry.internalId);
      entries.push(entry);
      const idNum = Number(entry.internalId);
      if (Number.isFinite(idNum) && idNum > maxId) maxId = idNum;
    }

    const nextCursor = String(maxId);

    if (Number(nextCursor) <= Number(cursor)) {
      console.warn("[SSNav] Inventory cursor did not advance; stopping.", {
        cursor,
        nextCursor,
      });
      cursor = nextCursor;
      if (onPage) await onPage({ entries, cursor, page });
      break;
    }

    cursor = nextCursor;
    if (onPage) await onPage({ entries, cursor, page });

    if (rows.length < PAGE_SIZE) break;
  }

  return { entries, cursor, pages: page, cancelled };
};

// ---- Phase 3: content download (uses the file's own `url` from inventory) ----

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with jitter (ms) for retry attempt N (1-based).
 * @param {number} attempt
 * @returns {number}
 */
const backoffDelay = (attempt) => 300 * 2 ** (attempt - 1) + Math.random() * 200;

/**
 * Resolve the fetchable URL for an inventory entry. Uses the `url` column
 * from inventory (hosted asset path or media.nl link with `h=` hash).
 * @param {AccountInfo} account
 * @param {InventoryEntry} entry
 * @returns {string} Absolute URL, or "" if none is available.
 */
export const buildMediaUrl = (account, entry) => {
  const raw = (entry.url || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.startsWith("/")) return `${account.origin}${raw}`;
  return `${account.origin}/${raw}`;
};

/**
 * Reject inventory URLs that are not https URLs on a netsuite.com host before
 * they are fetched with the session cookie (audit: a crafted inventory
 * response could otherwise send requests to attacker-controlled endpoints).
 * @param {string} url
 * @returns {string} the parsed hostname
 */
const assertNetsuiteUrl = (url) => {
  let u;
  try {
    u = new URL(url);
  } catch {
    const err = new Error(`Unparseable inventory URL — refusing to fetch: ${url}`);
    err.fatal = true;
    throw err;
  }
  if (u.protocol !== "https:" || !NETSUITE_HOST_RE.test(u.hostname)) {
    const err = new Error(
      `Inventory URL host is not a NetSuite host (expected *.netsuite.com over https) — refusing to fetch: ${u.hostname}`
    );
    err.fatal = true;
    throw err;
  }
  return u.hostname;
};

/**
 * Fetch a single script's raw source with retry/backoff on 429 & 5xx.
 * @param {AccountInfo} account
 * @param {InventoryEntry} entry
 * @returns {Promise<string>} raw source text
 */
export const fetchSource = async (account, entry) => {
  const url = buildMediaUrl(account, entry);
  if (!url) {
    const err = new Error(
      "No file URL in inventory (missing `url` column) — cannot fetch source."
    );
    err.fatal = true;
    throw err;
  }
  // Security: refuse to fetch any URL that isn't https on a *.netsuite.com host.
  assertNetsuiteUrl(url);
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    try {
      const res = await fetch(url, {
        method: "GET",
        mode: "cors",
        credentials: "include",
        headers: { accept: "*/*" },
      });

      if (res.status === 429 || res.status >= 500) {
        throw new Error(`transient HTTP ${res.status}`);
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.fatal = true;
        throw err;
      }
      return await res.text();
    } catch (err) {
      if (err.fatal || attempt >= MAX_RETRIES) throw err;
      await sleep(backoffDelay(attempt));
    }
  }
};

/**
 * Normalize raw source text into a stored source record (lines pre-split).
 * @param {InventoryEntry} entry
 * @param {string} text
 * @returns {SourceRecord}
 */
export const toSourceRecord = (entry, text) => {
  const lines = text.split("\n");
  return {
    internalId: entry.internalId,
    name: entry.name,
    folderPath: entry.folderPath,
    modified: entry.modified,
    lineCount: lines.length,
    lines,
  };
};

const BUNDLE_NAME_RE = /(\.min\.js$|\.[0-9a-f]{8,}\.js$)/i;

/**
 * True if the file name looks like a minified/bundled asset (pre-fetch check).
 * @param {string} [name]
 * @returns {boolean}
 */
export const looksLikeBundleName = (name = "") => BUNDLE_NAME_RE.test(name);

/**
 * True if the fetched source looks minified (any single line is very long).
 * @param {string} [text]
 * @returns {boolean}
 */
export const isMinifiedSource = (text) => {
  if (!text) return false;
  let maxLine = 0;
  let cur = 0;
  for (let k = 0; k < text.length; k++) {
    if (text.charCodeAt(k) === 10) {
      if (cur > maxLine) maxLine = cur;
      cur = 0;
    } else {
      cur++;
    }
  }
  if (cur > maxLine) maxLine = cur;
  return maxLine >= MINIFIED_MAX_LINE;
};

/**
 * True if an already-cached source record looks minified/bundled. Works from
 * the stored record so the skip-minified option can be applied retroactively.
 * @param {SourceRecord|null} record
 * @returns {boolean}
 */
export const isMinifiedRecord = (record) => {
  if (!record) return false;
  if (looksLikeBundleName(record.name)) return true;
  const lines = record.lines || [];
  for (const line of lines) {
    if (line && line.length >= MINIFIED_MAX_LINE) return true;
  }
  return false;
};

/**
 * Download source for every inventory entry in throttled batches.
 * @param {AccountInfo} account
 * @param {InventoryEntry[]} entries
 * @param {object} [opts]
 * @param {(record: SourceRecord) => Promise<void>|void} [opts.onRecord]
 * @param {(state: ProgressState) => void} [opts.onProgress]
 * @param {(entry: InventoryEntry) => boolean} [opts.shouldSkip]
 * @param {() => boolean} [opts.isCancelled]
 * @param {boolean} [opts.skipMinified]
 * @returns {Promise<{total: number, downloaded: number, skipped: number, skippedMinified: number, failed: number, failures: Array, cancelled: boolean}>}
 */
export const downloadContent = async (account, entries, opts = {}) => {
  const { onRecord, onProgress, shouldSkip, isCancelled, skipMinified } = opts;

  const total = entries.length;
  let done = 0;
  let downloaded = 0;
  let skipped = 0;
  let skippedMinified = 0;
  let failed = 0;
  let cancelled = false;
  const failures = [];

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    if (isCancelled && isCancelled()) {
      cancelled = true;
      break;
    }

    const batch = entries.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (entry) => {
        try {
          if (shouldSkip && shouldSkip(entry)) {
            skipped += 1;
            return;
          }
          if (skipMinified && looksLikeBundleName(entry.name)) {
            skippedMinified += 1;
            return;
          }
          const text = await fetchSource(account, entry);
          if (skipMinified && isMinifiedSource(text)) {
            skippedMinified += 1;
            return;
          }
          const record = toSourceRecord(entry, text);
          if (onRecord) await onRecord(record);
          downloaded += 1;
        } catch (err) {
          failed += 1;
          failures.push({
            internalId: entry.internalId,
            name: entry.name,
            error: err?.message || String(err),
          });
        } finally {
          done += 1;
          if (onProgress) onProgress({ done, total, failed });
        }
      })
    );

    if (i + BATCH_SIZE < entries.length) await sleep(BATCH_DELAY_MS);
  }

  return {
    total,
    downloaded,
    skipped,
    skippedMinified,
    failed,
    failures,
    cancelled,
  };
};

