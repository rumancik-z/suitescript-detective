// lib/constants.js — centralized configuration

// ---- Shared @typedefs (referenced across modules) ----

/**
 * Resolved NetSuite account information.
 * @typedef {Object} AccountInfo
 * @property {string} baseHost  - e.g. "1234567.app.netsuite.com"
 * @property {string} accountId    - numeric account id (also the media.nl `c=` param)
 * @property {string} accountLabel - full host label for display (e.g. "1234567-sb1")
 * @property {string} origin       - e.g. "https://1234567.app.netsuite.com"
 */

/**
 * A single inventory entry returned by the NetSuite search endpoint.
 * @typedef {Object} InventoryEntry
 * @property {string} internalId
 * @property {string} name
 * @property {string} folderPath
 * @property {string} url
 * @property {string} modified
 */

/**
 * A cached source record (source text pre-split into lines).
 * @typedef {Object} SourceRecord
 * @property {string} internalId
 * @property {string} name
 * @property {string} folderPath
 * @property {string} modified
 * @property {number} lineCount
 * @property {string[]} lines
 */

/**
 * Index metadata persisted to chrome.storage.local.
 * @typedef {Object} IndexMeta
 * @property {string} accountId
 * @property {"ready"|"inventory"|"content"|"cancelled"} status
 * @property {string} cursor
 * @property {number} scriptCount
 * @property {number} [downloaded]
 * @property {number} [skipped]
 * @property {number} [skippedMinified]
 * @property {number} [failed]
 * @property {number} [bytes]
 * @property {number|null} builtAt
 * @property {number} updatedAt
 * @property {string} [origin] - NetSuite origin the index was built from (used for remote re-pulls)
 */

/**
 * Progress state emitted during an index build.
 * @typedef {Object} ProgressState
 * @property {number} done
 * @property {number} total
 * @property {number} [failed]
 * @property {number} [page]
 */

/**
 * A single search result hit.
 * @typedef {Object} SearchHit
 * @property {string} internalId
 * @property {string} name
 * @property {string} folderPath
 * @property {number} lineNumber
 * @property {number} matchIndexInContext
 * @property {number} matchCol
 * @property {string} matchText - the raw term text that matched (for display)
 * @property {{start:number, len:number}[]} matchRanges - highlight ranges in the matched line
 * @property {{n:number, text:string}[]} context
 */

/**
 * User-configurable settings persisted to chrome.storage.local.
 * @typedef {Object} Settings
 * @property {boolean} skipMinified
 * @property {string[]} folders
 * @property {boolean} autoPurgeStale
 * @property {number} regexMaxLines - skip regex search on files with more lines than this (0 = no limit)
 */

/**
 * A single diff line in a hunk.
 * @typedef {Object} DiffLine
 * @property {"|"|"+"|"-"} type - "|" for context, "+" for addition, "-" for removal
 * @property {string} value - the line text
 */

/**
 * A contiguous block of changes between two file versions.
 * @typedef {Object} DiffHunk
 * @property {number} oldStart - 1-based starting line in the old file
 * @property {number} oldLines - number of lines consumed from old file
 * @property {number} newStart - 1-based starting line in the new file
 * @property {number} newLines - number of lines consumed from new file
 * @property {DiffLine[]} lines - the diff lines in this hunk
 */

/**
 * Result of comparing two files.
 * @typedef {Object} CompareResult
 * @property {string} filePath - the matched file path (folderPath + name)
 * @property {string} [oldInternalId] - internalId in the base account
 * @property {string} [newInternalId] - internalId in the comparison account
 * @property {DiffHunk[]} hunks - array of diff hunks (empty if identical)
 * @property {boolean} onlyInBase - true if file only exists in base account
 * @property {boolean} onlyInComparison - true if file only exists in comparison account
 */

// ---- NetSuite endpoints (paths appended to the resolved account baseHost) ----
export const INVENTORY_PATH = "/app/common/scripting/nlapijsonhandler.nl?jrr=T";
export const MEDIA_PATH = "/core/media/media.nl";

// ---- Inventory search filters ----
/** @type {string[]} */
export const SCRIPT_FOLDERS = ["-15", "-16", "-19"];

/** @type {{id:string, label:string}[]} */
export const SCRIPT_FOLDER_DEFS = [
  { id: "-15", label: "SuiteScripts" },
  { id: "-16", label: "SuiteBundles" },
  { id: "-19", label: "SuiteApps" },
];

export const FILE_TYPE = "JAVASCRIPT";

// ---- Pagination / throttling ----
export const PAGE_SIZE = 1000;
export const BATCH_SIZE = 5;
export const BATCH_DELAY_MS = 200;
export const MAX_RETRIES = 4;

// ---- UI ----
export const RESULT_CAP = 200;
export const SEARCH_DEBOUNCE_MS = 200;
export const CONTEXT_RADIUS = 5;
// Lines of context shown above/below each match in compact multi-match cards.
// Smaller than CONTEXT_RADIUS to keep multi-match cards terse.
export const COMPACT_CONTEXT_RADIUS = 3;

// When a matched line is longer than this (e.g. minified/bundled files), the
// UI shows a character window centered on the match instead of the whole line.
export const LONG_LINE_CHARS = 200;
export const CHAR_CONTEXT = 140;

// ---- Search enhancements ----
// Hard timeout (ms) for regex searches running in a dedicated worker.
export const REGEX_TIMEOUT_MS = 4000;
// Sort modes offered in the popup's search options.
export const SORT_OPTIONS = ["relevance", "file", "folder"];

// A file whose longest line reaches this many characters is treated as
// minified/bundled and can be skipped to save storage.
export const MINIFIED_MAX_LINE = 5000;

// ---- chrome.storage.local keys ----
/**
 * @typedef {Object} StorageKeys
 * @property {string} META
 * @property {string} INVENTORY
 * @property {string} SETTINGS
 * @property {string} SRC_PREFIX
 * @property {string} COMPARISON_ACCOUNT
 * @property {string} COMPARISON_META
 * @property {string} COMPARISON_INVENTORY
 * @property {string} COMPARISON_SRC_PREFIX
 * @property {string} DIFF_STATE
 */

/** @type {StorageKeys} */
export const STORAGE_KEYS = {
  // NOTE: META, INVENTORY, and SRC_PREFIX are now used as PREFIXES, not exact
  // keys. The per-account key is built by appending the account label (the
  // baseHost prefix, e.g. "1234567-sb1"):
  //   "ssnav.meta.<label>"              → that account's IndexMeta
  //   "ssnav.inventory.<label>"         → that account's inventory array
  //   "ssnav.src.<label>:<internalId>"  → that account's source shards
  META: "ssnav.meta",
  INVENTORY: "ssnav.inventory",
  SETTINGS: "ssnav.settings",
  SRC_PREFIX: "ssnav.src.",
  // Legacy, used only by migrateLegacyCache() — one-shot migration of the
  // pre-per-account comparison slot into per-account keys.
  COMPARISON_ACCOUNT: "ssnav.comparison.account",
  COMPARISON_META: "ssnav.comparison.meta",
  COMPARISON_INVENTORY: "ssnav.comparison.inventory",
  COMPARISON_SRC_PREFIX: "ssnav.comparison.src.",
  DIFF_STATE: "ssnav.diff.state",
};

// ---- Message types (popup <-> service worker) ----
/**
 * @typedef {Object} MsgTypes
 * @property {string} RESOLVE_ACCOUNT
 * @property {string} BUILD_INDEX
 * @property {string} CANCEL_BUILD
 * @property {string} SEARCH
 * @property {string} GET_STATUS
 * @property {string} CLEAR_INDEX
 * @property {string} ACCOUNT
 * @property {string} PROGRESS
 * @property {string} BUILD_STARTED
 * @property {string} INDEX_READY
 * @property {string} RESULTS
 * @property {string} STATUS
 * @property {string} CLEARED
 * @property {string} CANCELLED
 * @property {string} ERROR
 * @property {string} COMPARE_FILES
 * @property {string} COMPARE_RESULT
 * @property {string} COMPARE_FOLDER
 * @property {string} COMPARE_FOLDER_RESULT
 * @property {string} BUILD_COMPARISON_INDEX
 * @property {string} SET_DIFF_BASE_ACCOUNT
 * @property {string} GET_COMPARISON_FILES
 * @property {string} GET_COMPARISON_FILES_RESULT
 * @property {string} CLEAR_ALL_CACHE
 * @property {string} GET_CACHED_ACCOUNTS
 * @property {string} CACHED_ACCOUNTS
 */

/** @type {MsgTypes} */
export const MSG = {
  RESOLVE_ACCOUNT: "RESOLVE_ACCOUNT",
  BUILD_INDEX: "BUILD_INDEX",
  CANCEL_BUILD: "CANCEL_BUILD",
  SEARCH: "SEARCH",
  GET_STATUS: "GET_STATUS",
  CLEAR_INDEX: "CLEAR_INDEX",
  ACCOUNT: "ACCOUNT",
  PROGRESS: "PROGRESS",
  BUILD_STARTED: "BUILD_STARTED",
  INDEX_READY: "INDEX_READY",
  RESULTS: "RESULTS",
  STATUS: "STATUS",
  CLEARED: "CLEARED",
  CANCELLED: "CANCELLED",
  ERROR: "ERROR",
  COMPARE_FILES: "COMPARE_FILES",
  COMPARE_RESULT: "COMPARE_RESULT",
  COMPARE_FOLDER: "COMPARE_FOLDER",
  COMPARE_FOLDER_RESULT: "COMPARE_FOLDER_RESULT",
  BUILD_COMPARISON_INDEX: "BUILD_COMPARISON_INDEX",
  SET_DIFF_BASE_ACCOUNT: "SET_DIFF_BASE_ACCOUNT",
  GET_COMPARISON_FILES: "GET_COMPARISON_FILES",
  GET_COMPARISON_FILES_RESULT: "GET_COMPARISON_FILES_RESULT",
  CLEAR_ALL_CACHE: "CLEAR_ALL_CACHE",
  GET_CACHED_ACCOUNTS: "GET_CACHED_ACCOUNTS",
  CACHED_ACCOUNTS: "CACHED_ACCOUNTS",
};

// Warn the user when cached data exceeds this fraction of the storage quota.
export const QUOTA_WARN_RATIO = 0.85;

// Cache time-to-live: auto-clear on open/browser startup. 4 hours.
export const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

export const NETSUITE_HOST_RE = /(^|\.)netsuite\.com$/i;

