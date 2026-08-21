// background.js — MV3 service worker: message router + orchestrator

import {
  MSG,
  RESULT_CAP,
  SCRIPT_FOLDERS,
  CACHE_TTL_MS,
} from "./lib/constants.js";
import { resolveAccount, parseAccountFromUrl, recordLastAccount } from "./lib/accountResolver.js";
import {
  getMeta,
  setMeta,
  getAllSources,
  setInventory,
  putSource,
  getSourceMetaMap,
  getUsage,
  clearAccountCache,
  clearAllCaches,
  getCachedAccountIds,
  getCachedAccounts,
  getSettings,
  findSourceByPath,
  getDiffState,
  getDiffStateObj,
  setDiffState,
  migrateLegacyCache,
} from "./lib/storage.js";
import { search } from "./lib/searchEngine.js";
import { diffLines } from "./lib/diffEngine.js";
import {
  inventoryAll,
  downloadContent,
  isMinifiedRecord,
} from "./lib/netsuiteClient.js";

// One-shot migration of the pre-per-account cache layout into per-account
// keys. No-op once the legacy slot keys are gone.
//
// IMPORTANT: no top-level await here. Older Chrome builds (e.g. managed
// fleet versions) reject top-level await in service workers at
// registration ("Top-level await is disallowed in service workers"),
// which kills the entire worker — the popup then hangs on its first
// message forever. Message handlers and the spawn-time purge gate on
// `migrationPromise` instead, which preserves the same ordering without
// blocking registration.
const migrationPromise = migrateLegacyCache().catch((e) =>
  console.warn("Legacy cache migration failed", e)
);

/** @type {boolean} */
let buildInProgress = false;
/** @type {boolean} */
let cancelRequested = false;
/** @type {("base" | "comparison") | null} Kind of the running build, exposed via GET_STATUS. */
let activeBuildKind = null;
/** @type {string | null} Label of the most recent build's target account. Set at the start of every build and never cleared. */
let activeBuildAccount = null;
/** @type {boolean} Whether the spawn-time purge cleared at least one stale cache. Exposed via GET_STATUS. */
let purgeCleared = false;
/** @type {Promise<boolean> | null} The in-flight spawn-time purge, awaited by GET_STATUS so `purged` is accurate. */
let purgePromise = null;

/**
 * Broadcast a message to any listeners.
 * @param {object} message
 */
const broadcast = (message) => {
  chrome.runtime.sendMessage(message).catch(() => {
    /* no receiver (popup closed) — safe to ignore */
  });
};

/**
 * Start a build without holding the message channel open for its whole
 * duration. Keeping a pending response (return true) alive for minutes pins
 * the service worker, which Chrome terminates after ~5 minutes — that used to
 * drop the final BUILD_INDEX reply and freeze the popup on the last progress
 * tick ("Downloading 541/541 scripts") even though every download finished.
 * Return a quick ack instead; the final result is broadcast to the popup.
 * @param {object} msg - The incoming build message.
 * @param {(msg: object) => Promise<object>} run - The build function.
 * @param {"base" | "comparison"} kind - Build kind, exposed via GET_STATUS so a
 *   popup that reopens mid-build can tell what is running.
 * @returns {object} A BUILD_STARTED ack (or ERROR if a build is already running).
 */
const startBuild = (msg, run, kind) => {
  if (buildInProgress) {
    return { type: MSG.ERROR, message: "An index build is already running." };
  }
  // Claim the build slot synchronously — before run() begins its pre-flight
  // awaits — so a second build request (double-click, banner + main button)
  // cannot slip past the guard and run two builds concurrently.
  buildInProgress = true;
  cancelRequested = false;
  activeBuildKind = kind;
  run(msg)
    .then((res) => {
      if (res) broadcast(res);
    })
    .catch((err) => {
      broadcast({ type: MSG.ERROR, message: err?.message || String(err) });
    })
    .finally(() => {
      buildInProgress = false;
      cancelRequested = false;
      activeBuildKind = null;
    });
  return { type: MSG.BUILD_STARTED };
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch((err) =>
      sendResponse({ type: MSG.ERROR, message: err?.message || String(err) })
    );
  return true;
});

/**
 * Route incoming messages to handlers.
 * @param {{type: string, [key: string]: any}} msg
 * @returns {Promise<object>}
 */
const handleMessage = async (msg) => {
  // Gate every handler behind the spawn-time legacy-cache migration (see
  // top of file — top-level await is disallowed in service workers). Once
  // the migration has settled this is a no-op microtask.
  await migrationPromise;
  switch (msg?.type) {
    case MSG.RESOLVE_ACCOUNT:
      return resolveAccountMsg();
    case MSG.GET_STATUS:
      return statusMsg(msg);
    case MSG.SEARCH:
      return searchMsg(msg);
    case MSG.BUILD_INDEX:
      return startBuild(msg, buildIndexMsg, "base");
    case MSG.CANCEL_BUILD:
      return cancelBuildMsg();
    case MSG.CLEAR_INDEX:
      return clearIndexMsg(msg);
    case MSG.CLEAR_ALL_CACHE:
      return clearAllCacheMsg();
    case MSG.GET_CACHED_ACCOUNTS:
      return getCachedAccountsMsg(msg);
    case MSG.COMPARE_FILES:
      return compareFilesMsg(msg);
    case MSG.COMPARE_FOLDER:
      return compareFolderMsg(msg);
    case MSG.BUILD_COMPARISON_INDEX:
      return startBuild(msg, buildComparisonIndexMsg, "comparison");
    case MSG.SET_DIFF_BASE_ACCOUNT:
      return setDiffBaseAccountMsg(msg);
    case MSG.GET_COMPARISON_FILES:
      return getComparisonFilesMsg(msg);
    default:
      return { type: MSG.ERROR, message: `Unknown message: ${msg?.type}` };
  }
};

/**
 * Handle a RESOLVE_ACCOUNT message.
 * @returns {Promise<object>}
 */
const resolveAccountMsg = async () => {
  const account = await resolveAccount();
  if (!account) {
    return {
      type: MSG.ACCOUNT,
      account: null,
      message: "No NetSuite tab detected.",
    };
  }
  // Best-effort bookkeeping — deliberately not awaited, so a slow or wedged
  // session-storage write can never hold the response (and the popup's
  // "Checking…" label) open.
  void recordLastAccount(account.origin);
  return { type: MSG.ACCOUNT, account };
};

/**
 * Resolve the current account, preferring an explicit origin hint.
 * Used when the popup runs as a full tab (e.g. a diff tab), where the active
 * tab is the extension's own page rather than a NetSuite tab.
 * @param {string} [origin] - NetSuite origin URL (e.g. https://123456-sb1.app.netsuite.com).
 * @returns {Promise<import("./lib/constants.js").AccountInfo | null>}
 */
const resolveAccountWithHint = async (origin) => {
  let account = null;
  if (origin) {
    account = parseAccountFromUrl(origin);
  }
  if (!account) {
    account = await resolveAccount();
  }
  if (account) void recordLastAccount(account.origin);
  return account;
};

/**
 * Handle a GET_STATUS message.
 * @returns {Promise<object>}
 */
const statusMsg = async (msg = {}) => {
  // Wait for the spawn-time purge to settle so `purged` below is accurate —
  // but never trigger a purge here: refreshing status must not clear caches.
  if (purgePromise) await purgePromise;
  // The purge notice is one-time per purge event: report the flag to the
  // first status consumer, then reset the latch so a popup reopened in the
  // same worker lifetime doesn't show the toast again.
  const purged = purgeCleared;
  purgeCleared = false;
  const account = await resolveAccountWithHint(msg.origin);
  const currentLabel = account
    ? account.baseHost.split(".")[0] || account.accountId
    : null;

  const meta = currentLabel ? await getMeta(currentLabel) : null;
  const usage = await getUsage();
  const resumable = !!meta && meta.status !== "ready";
  const diffStateObj = await getDiffStateObj();
  const diffState = diffStateObj?.label || null;
  const baseMeta = diffState ? await getMeta(diffState) : null;
  const baseReady =
    !!baseMeta && baseMeta.status === "ready" && baseMeta.accountId === diffState;
  const buildMeta = activeBuildAccount ? await getMeta(activeBuildAccount) : null;
  return {
    type: MSG.STATUS,
    meta,
    currentAccount: currentLabel,
    scriptCount: meta?.scriptCount ?? 0,
    usage,
    resumable,
    purged,
    diffState,
    diffBaseOrigin: diffStateObj?.origin || null,
    baseMeta,
    baseReady,
    baseScriptCount: baseReady ? baseMeta.scriptCount || 0 : 0,
    buildMeta,
    buildAccount: buildInProgress ? activeBuildAccount : null,
    building: buildInProgress,
    buildKind: activeBuildKind,
  };
};

/**
 * True if `ts` is older than the cache TTL.
 * @param {number|null} ts
 * @returns {boolean}
 */
const isExpired = (ts) => {
  if (!ts) return false;
  return Date.now() - ts > CACHE_TTL_MS;
};

/**
 * Purge each account's per-account cache independently when it is stale and
 * auto-purge is enabled.
 * @returns {Promise<boolean>} True if anything was purged.
 */
const purgeIfStale = async () => {
  if (buildInProgress) return false;
  const settings = await getSettings();
  if (!settings.autoPurgeStale) return false;

  let purged = false;
  for (const id of await getCachedAccountIds()) {
    const m = await getMeta(id);
    if (m && isExpired(m.builtAt || m.updatedAt)) {
      await clearAccountCache(id);
      purged = true;
    }
  }
  if (purged) purgeCleared = true;
  return purged;
};

chrome.runtime.onStartup.addListener(() => {
  // Gate on the migration so the purge never interleaves with it on
  // storage (both enumerate and rewrite cache keys).
  migrationPromise.then(() => purgeIfStale()).catch(() => {});
});

// Fire-and-forget startup purge, chained onto the migration so the two
// never interleave on storage. A cold worker spawn (browser start, or the
// popup reopening after the worker went idle) is the purge trigger — never
// a per-status refresh, which used to silently delete caches while the
// user merely switched between the search and diff views.
purgePromise = migrationPromise
  .then(() => purgeIfStale())
  .catch((e) => console.warn("Stale cache purge failed", e));

/**
 * Handle a CLEAR_INDEX message: clear only the current account's cached
 * index (meta, inventory, source shards).
 * @param {{type?: string, origin?: string}} [msg]
 * @returns {Promise<object>}
 */
const clearIndexMsg = async (msg = {}) => {
  if (buildInProgress) {
    return { type: MSG.ERROR, message: "Cannot clear while a build is running." };
  }
  const account = await resolveAccountWithHint(msg.origin);
  if (!account) {
    return {
      type: MSG.ERROR,
      message: "No NetSuite tab detected. Open a NetSuite tab and try again.",
    };
  }
  const label = account.baseHost.split(".")[0] || account.accountId;
  await clearAccountCache(label);
  return { type: MSG.CLEARED, accountId: label };
};

/**
 * Handle a CLEAR_ALL_CACHE message: clear every account's cached index.
 * @returns {Promise<object>}
 */
const clearAllCacheMsg = async () => {
  if (buildInProgress) {
    return { type: MSG.ERROR, message: "Cannot clear while a build is running." };
  }
  await clearAllCaches();
  return { type: MSG.CLEARED };
};

/**
 * Handle a GET_CACHED_ACCOUNTS message: list every account with cached
 * index data (for the accounts page), plus the current/diff-base context.
 * @param {{type?: string, origin?: string}} [msg]
 * @returns {Promise<object>}
 */
const getCachedAccountsMsg = async (msg = {}) => {
  const accounts = await getCachedAccounts();
  const account = await resolveAccountWithHint(msg.origin);
  const currentLabel = account
    ? account.baseHost.split(".")[0] || account.accountId
    : null;
  const diffStateObj = await getDiffStateObj();
  const usage = await getUsage();
  return {
    type: MSG.CACHED_ACCOUNTS,
    accounts,
    currentAccount: currentLabel,
    diffBase: diffStateObj?.label || null,
    diffBaseOrigin: diffStateObj?.origin || null,
    usage,
  };
};

/**
 * Handle a SEARCH message.
 * @param {{
 *   type: string,
 *   term?: string,
 *   chips?: string[],
 *   chipMode?: 'and'|'or',
 *   caseSensitive?: boolean,
 *   regex?: boolean,
 *   wholeWord?: boolean,
 *   sort?: 'relevance'|'file'|'folder'|'line',
 * }} msg
 * @returns {Promise<object>}
 */
const searchMsg = async (msg) => {
  // The per-account cache slot holds whatever was last indexed for this
  // account. If the account has no ready index, return an empty result so
  // the popup prompts to build instead of showing files from the wrong
  // account.
  const account = await resolveAccountWithHint(msg.origin);
  const currentLabel = account
    ? account.baseHost.split(".")[0] || account.accountId
    : null;
  const meta = currentLabel ? await getMeta(currentLabel) : null;
  if (!meta || meta.status !== "ready") {
    return {
      type: MSG.RESULTS,
      hits: [],
      truncated: false,
      scanned: 0,
      noIndex: true,
      accountId: currentLabel,
    };
  }

  let sources = await getAllSources(currentLabel);

  const settings = await getSettings();
  if (settings.skipMinified) {
    sources = sources.filter((s) => !isMinifiedRecord(s));
  }
  // Skip regex search on very large files when the user has set a cap.
  const maxLines = Number(settings.regexMaxLines) || 0;
  if (msg.regex && maxLines > 0) {
    sources = sources.filter((s) => !(s.lines && s.lines.length > maxLines));
  }

  const queryConfig = {
    text: msg.term || "",
    chips: Array.isArray(msg.chips) ? msg.chips : undefined,
    chipMode: msg.chipMode === "and" ? "and" : "or",
    caseSensitive: !!msg.caseSensitive,
    regex: !!msg.regex,
    wholeWord: !!msg.wholeWord,
  };

  const res = await search(sources, queryConfig, {
    cap: RESULT_CAP,
    sort: msg.sort || "relevance",
  });

  if (res.error) {
    return { type: MSG.ERROR, message: res.error };
  }
  return { type: MSG.RESULTS, hits: res.hits, truncated: res.truncated, scanned: res.scanned };
};

/**
 * Unified index build core, shared by the search page (phase "ready") and
 * the diff page (phase "comparison-ready"). All cache reads and writes go
 * to the target account's per-account slot, so a cache pulled from either
 * page is immediately usable for that account's search and diffing.
 * @param {{type?: string, mode?: string, folders?: string[], skipMinified?: boolean}} [msg]
 * @param {import("./lib/constants.js").AccountInfo} account - The account to build for (the diff page may pass any account, e.g. the diff base pulled remotely).
 * @param {"ready" | "comparison-ready"} resultPhase - Phase reported in the final INDEX_READY / CANCELLED message.
 * @returns {Promise<object>}
 */
const runIndexBuild = async (msg, account, resultPhase) => {
  // Store the full account identifier including suffix (e.g., 1234567-sb1)
  // so it matches diffState and statusMsg.currentAccount exactly.
  const accountLabel = account.baseHost.split(".")[0] || account.accountId;
  activeBuildAccount = accountLabel;

  const mode = msg.mode === "rebuild" ? "rebuild" : "delta";

  const settings = await getSettings();
  const folders =
    (Array.isArray(msg.folders) && msg.folders.length ? msg.folders : null) ||
    (Array.isArray(settings.folders) && settings.folders.length
      ? settings.folders
      : null) ||
    SCRIPT_FOLDERS;
  if (!folders.length) {
    return {
      type: MSG.ERROR,
      message: "Select at least one folder to index (SuiteScripts, SuiteBundles, or SuiteApps).",
    };
  }

  const isCancelled = () => cancelRequested;
  try {
    if (mode === "rebuild") {
      await clearAccountCache(accountLabel);
    }

    broadcast({ type: MSG.PROGRESS, phase: "inventory", done: 0, total: 0 });

    const {
      entries,
      cursor,
      cancelled: invCancelled,
    } = await inventoryAll(account, {
      isCancelled,
      folders,
      onPage: async ({ entries, cursor, page }) => {
        await setInventory(accountLabel, entries);
        await setMeta(accountLabel, {
          accountId: accountLabel,
          origin: account.origin || null,
          status: "inventory",
          cursor,
          scriptCount: entries.length,
          builtAt: null,
          updatedAt: Date.now(),
        });
        broadcast({
          type: MSG.PROGRESS,
          phase: "inventory",
          done: entries.length,
          total: entries.length,
          page,
        });
      },
    });

    await setInventory(accountLabel, entries);

    if (invCancelled) {
      return finishCancelled(account, cursor, entries.length, null, resultPhase);
    }

    await setMeta(accountLabel, {
      accountId: accountLabel,
      origin: account.origin || null,
      status: "content",
      cursor,
      scriptCount: entries.length,
      builtAt: null,
      updatedAt: Date.now(),
    });

    broadcast({ type: MSG.PROGRESS, phase: "content", done: 0, total: entries.length });

    const existing = mode === "rebuild" ? new Map() : await getSourceMetaMap(accountLabel);
    const shouldSkip = (entry) => {
      const prev = existing.get(String(entry.internalId));
      return !!prev && prev.modified === entry.modified;
    };

    const result = await downloadContent(account, entries, {
      isCancelled,
      skipMinified: !!msg.skipMinified,
      shouldSkip: mode === "rebuild" ? undefined : shouldSkip,
      onRecord: async (record) => {
        await putSource(accountLabel, record);
      },
      onProgress: ({ done, total, failed }) => {
        broadcast({ type: MSG.PROGRESS, phase: "content", done, total, failed });
      },
    });

    if (result.cancelled) {
      return finishCancelled(account, cursor, entries.length, result, resultPhase);
    }

    const cached = await getAllSources(accountLabel);
    const usage = await getUsage();

    await setMeta(accountLabel, {
      accountId: accountLabel,
      origin: account.origin || null,
      status: "ready",
      cursor,
      scriptCount: cached.length,
      downloaded: result.downloaded,
      skipped: result.skipped,
      skippedMinified: result.skippedMinified,
      failed: result.failed,
      bytes: usage.bytes,
      builtAt: Date.now(),
      updatedAt: Date.now(),
    });

    const scriptCount = cached.length;
    return {
      type: MSG.INDEX_READY,
      phase: resultPhase,
      scriptCount,
      downloaded: result.downloaded,
      skipped: result.skipped,
      skippedMinified: result.skippedMinified,
      failed: result.failed,
      usage,
      message:
        resultPhase === "comparison-ready"
          ? `Comparison index ready: ${scriptCount} scripts cached (${result.downloaded} downloaded, ${result.skipped} already cached).`
          : `Index ready: ${scriptCount} scripts cached (${result.downloaded} downloaded, ${result.skipped} already cached).`,
    };
  } catch (err) {
    return { type: MSG.ERROR, message: err?.message || String(err) };
  }
};

/**
 * Handle a BUILD_INDEX message: build (or refresh) the current account's
 * index into its per-account cache slot.
 * @param {{type?: string, mode?: string, folders?: string[], skipMinified?: boolean}} [msg]
 * @returns {Promise<object>}
 */
const buildIndexMsg = async (msg = {}) => {
  const account = await resolveAccountWithHint(msg.origin);
  if (!account) {
    return {
      type: MSG.ERROR,
      message: "No NetSuite tab detected. Open a NetSuite tab and try again.",
    };
  }
  return runIndexBuild(msg, account, "ready");
};

/**
 * Signal the running build to stop.
 * @returns {Promise<object>}
 */
const cancelBuildMsg = async () => {
  if (!buildInProgress) {
    return { type: MSG.ERROR, message: "No build is currently running." };
  }
  cancelRequested = true;
  return { type: MSG.CANCELLED, acknowledged: true };
};

/**
 * Finalize a cancelled build (base or comparison) and report the partial
 * summary for the target account's per-account cache slot.
 * @param {import("./lib/constants.js").AccountInfo} account
 * @param {string} cursor
 * @param {number} inventoryCount
 * @param {object|null} [result]
 * @param {"ready" | "comparison-ready"} [phase]
 * @returns {Promise<object>}
 */
const finishCancelled = async (
  account,
  cursor,
  inventoryCount,
  result = null,
  phase = "ready"
) => {
  const accountLabel = account.baseHost.split(".")[0] || account.accountId;
  const cached = await getAllSources(accountLabel);
  const usage = await getUsage();
  await setMeta(accountLabel, {
    accountId: accountLabel,
    origin: account.origin || null,
    status: "cancelled",
    cursor,
    scriptCount: cached.length,
    downloaded: result?.downloaded || 0,
    skipped: result?.skipped || 0,
    skippedMinified: result?.skippedMinified || 0,
    failed: result?.failed || 0,
    bytes: usage.bytes,
    builtAt: null,
    updatedAt: Date.now(),
  });
  return {
    type: MSG.CANCELLED,
    phase: phase === "comparison-ready" ? "comparison-cancelled" : "cancelled",
    scriptCount: cached.length,
    inventoryCount,
    usage,
    message:
      phase === "comparison-ready"
        ? `Comparison build cancelled. ${cached.length} sources already cached.`
        : `Cancelled. ${cached.length} sources already cached.`,
  };
};

/**
 * Handle a COMPARE_FILES message.
 * @param {{type: string, folderPath: string, name: string}} msg
 * @returns {Promise<object>}
 */
// Cap for full-file diffs (files that exist in only one account).
// Very large files would create too many DOM rows.
const FULL_DIFF_LINE_CAP = 2000;

/**
 * Build a single hunk containing all lines as additions (+).
 * Caps at FULL_DIFF_LINE_CAP lines to avoid rendering massive files.
 * @param {string[]} lines
 * @returns {import('./lib/constants').DiffHunk[]}
 */
const buildFullAddHunk = (lines) => {
  if (!lines || lines.length === 0) return [];
  const capped = lines.slice(0, FULL_DIFF_LINE_CAP);
  return [{
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: capped.length,
    lines: capped.map((l) => ({ type: "+", value: l })),
  }];
};

/**
 * Build a single hunk containing all lines as deletions (-).
 * Caps at FULL_DIFF_LINE_CAP lines to avoid rendering massive files.
 * @param {string[]} lines
 * @returns {import('./lib/constants').DiffHunk[]}
 */
const buildFullDeleteHunk = (lines) => {
  if (!lines || lines.length === 0) return [];
  const capped = lines.slice(0, FULL_DIFF_LINE_CAP);
  return [{
    oldStart: 1,
    oldLines: capped.length,
    newStart: 0,
    newLines: 0,
    lines: capped.map((l) => ({ type: "-", value: l })),
  }];
};

const compareFilesMsg = async (msg) => {
  const folderPath = msg.folderPath || "";
  const name = msg.name || "";

  // Comparing mid-build reads a half-written cache and would report a
  // misleading "no cached sources" error — wait for the build to finish.
  if (buildInProgress) {
    return {
      type: MSG.ERROR,
      message: "An index build is currently running — wait for it to finish before comparing.",
    };
  }

  const diffBase = await getDiffState();
  if (!diffBase) {
    return {
      type: MSG.ERROR,
      message: "No diff base account set. Use the menu to set a base account first.",
    };
  }

  const account = await resolveAccountWithHint(msg.origin);
  const currentLabel = account
    ? account.baseHost.split(".")[0] || account.accountId
    : null;

  const baseSources = await getAllSources(diffBase);
  const compSources = currentLabel ? await getAllSources(currentLabel) : [];

  if (baseSources.length === 0) {
    return {
      type: MSG.ERROR,
      message: `Base account (${diffBase}) has no cached sources. Build the base index first.`,
    };
  }
  if (compSources.length === 0) {
    return {
      type: MSG.ERROR,
      message: `Compare account (${currentLabel ?? "unknown"}) has no cached sources. Build the comparison index first.`,
    };
  }

  // Find the file in both accounts by folderPath + name
  const baseRecord = findSourceByPath(baseSources, folderPath, name);
  const compRecord = findSourceByPath(compSources, folderPath, name);

  // Handle missing files
  if (!baseRecord && !compRecord) {
    return {
      type: MSG.COMPARE_RESULT,
      filePath: `${folderPath}${folderPath ? "/" : ""}${name}`,
      hunks: [],
      onlyInBase: false,
      onlyInComparison: false,
      error: "File not found in either account.",
    };
  }

  if (!baseRecord) {
    const hunks = buildFullAddHunk(compRecord.lines);
    return {
      type: MSG.COMPARE_RESULT,
      filePath: `${folderPath}${folderPath ? "/" : ""}${name}`,
      newInternalId: compRecord.internalId,
      hunks,
      onlyInBase: false,
      onlyInComparison: true,
    };
  }

  if (!compRecord) {
    const hunks = buildFullDeleteHunk(baseRecord.lines);
    return {
      type: MSG.COMPARE_RESULT,
      filePath: `${folderPath}${folderPath ? "/" : ""}${name}`,
      oldInternalId: baseRecord.internalId,
      hunks,
      onlyInBase: true,
      onlyInComparison: false,
    };
  }

  // Run the diff
  const hunks = diffLines(baseRecord.lines, compRecord.lines);

  return {
    type: MSG.COMPARE_RESULT,
    filePath: `${folderPath}${folderPath ? "/" : ""}${name}`,
    oldInternalId: baseRecord.internalId,
    newInternalId: compRecord.internalId,
    hunks,
    onlyInBase: false,
    onlyInComparison: false,
  };
};

/**
 * Handle a SET_DIFF_BASE_ACCOUNT message.
 * @param {{type?: string, origin?: string}} [msg]
 * @returns {Promise<object>}
 */
const setDiffBaseAccountMsg = async (msg = {}) => {
  const account = await resolveAccountWithHint(msg.origin);
  if (!account) {
    return {
      type: MSG.ERROR,
      message: "No NetSuite tab detected. Open a NetSuite tab and try again.",
    };
  }
  // Store the full account identifier including suffix (e.g., 1234567-sb1)
  const firstLabel = account.baseHost.split('.')[0] || account.accountId;
  await setDiffState(firstLabel, account.origin);
  // Diff comparisons use this account's per-account cache slot as the base.
  // If it has no ready index, the popup must pull one before comparing.
  const meta = firstLabel ? await getMeta(firstLabel) : null;
  const needsBaseBuild = !(meta && meta.status === "ready");
  return {
    type: MSG.SET_DIFF_BASE_ACCOUNT,
    accountId: account.accountId,
    needsBaseBuild,
    message: `Account ${firstLabel} set as diff base.`,
  };
};

/**
 * Handle a GET_COMPARISON_FILES message.
 * @param {{type?: string, origin?: string}} [msg]
 * @returns {Promise<object>}
 */
const getComparisonFilesMsg = async (msg = {}) => {
  const diffState = await getDiffState();
  if (!diffState) {
    return {
      type: MSG.ERROR,
      message: "No diff base account set. Use the menu to set a base account first.",
    };
  }

  const baseSources = await getAllSources(diffState);
  const account = await resolveAccountWithHint(msg.origin);
  const currentLabel = account
    ? account.baseHost.split(".")[0] || account.accountId
    : null;
  const compSources = currentLabel ? await getAllSources(currentLabel) : [];
  const allSources = [...baseSources, ...compSources];

  const seen = new Set();
  const uniqueSources = allSources.filter((s) => {
    const fullPath = s.folderPath ? `${s.folderPath}/${s.name}` : s.name;
    if (seen.has(fullPath)) return false;
    seen.add(fullPath);
    return true;
  });

  const files = uniqueSources.map((s) => ({
    folderPath: s.folderPath,
    name: s.name,
    fullPath: s.folderPath ? `${s.folderPath}/${s.name}` : s.name,
  }));

  return { type: MSG.GET_COMPARISON_FILES_RESULT, files };
};

/**
 * Handle a COMPARE_FOLDER message — compare all files in a folder between base and comparison accounts.
 * @param {{type: string, folderPath: string}} msg
 * @returns {Promise<object>}
 */
const compareFolderMsg = async (msg) => {
  const folderPath = (msg.folderPath || "").trim();
  // Empty folderPath means "compare all files" (user typed "/").
  // Allow it — the matchesFolder predicate below will match every source.

  // Comparing mid-build reads a half-written cache and would report a
  // misleading "no cached sources" error — wait for the build to finish.
  if (buildInProgress) {
    return {
      type: MSG.ERROR,
      message: "An index build is currently running — wait for it to finish before comparing.",
    };
  }

  const diffBase = await getDiffState();
  if (!diffBase) {
    return {
      type: MSG.ERROR,
      message: "No diff base account set. Use the menu to set a base account first.",
    };
  }

  const account = await resolveAccountWithHint(msg.origin);
  const currentLabel = account
    ? account.baseHost.split(".")[0] || account.accountId
    : null;

  const baseSources = await getAllSources(diffBase);
  const compSources = currentLabel ? await getAllSources(currentLabel) : [];

  if (baseSources.length === 0) {
    return {
      type: MSG.ERROR,
      message: `Base account (${diffBase}) has no cached sources. Build the base index first.`,
    };
  }
  if (compSources.length === 0) {
    return {
      type: MSG.ERROR,
      message: `Compare account (${currentLabel ?? "unknown"}) has no cached sources. Build the comparison index first.`,
    };
  }

  // Filter sources that match the folder path (exact or subdirectory).
  // If folderPath is empty, match all files.
  const matchesFolder = (s) =>
    !folderPath ||
    s.folderPath === folderPath ||
    s.folderPath.startsWith(folderPath + "/");

  const baseFiltered = baseSources.filter(matchesFolder);
  const compFiltered = compSources.filter(matchesFolder);

  // Build a composite key from the relative path within the target folder.
  // When folderPath is empty (compare all), use the full path as the key so
  // files with the same name in different folders stay separate.
  const relKey = (s) => {
    if (!folderPath) {
      return s.folderPath ? `${s.folderPath}/${s.name}` : s.name;
    }
    if (s.folderPath === folderPath) {
      return s.name;
    }
    const relative = s.folderPath.substring(folderPath.length + 1); // strip "folderPath/"
    return `${relative}/${s.name}`;
  };

  // Collect all unique file keys from both accounts.
  const allKeys = new Set();
  for (const s of baseFiltered) allKeys.add(relKey(s));
  for (const s of compFiltered) allKeys.add(relKey(s));

  // Index filtered sources by relKey for O(1) lookup.
  const baseMap = new Map();
  for (const s of baseFiltered) baseMap.set(relKey(s), s);

  const compMap = new Map();
  for (const s of compFiltered) compMap.set(relKey(s), s);

  const fileResults = [];
  let filesWithDiffs = 0;
  let processed = 0;

  for (const key of allKeys) {
    // Yield to the event loop every 25 files so the service worker doesn't
    // block the message pump long enough to trigger a popup timeout.
    if (processed++ % 25 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }

    const baseRecord = baseMap.get(key);
    const compRecord = compMap.get(key);

    // Build the display file path.
    // When folderPath is empty, key already contains the full path.
    const filePath = folderPath ? `${folderPath}/${key}` : key;

    if (baseRecord && compRecord) {
      // Both exist — run diff, skip identical files.
      const hunks = diffLines(baseRecord.lines, compRecord.lines);
      if (hunks.length === 0) continue;
      filesWithDiffs++;
      fileResults.push({
        filePath,
        hunks,
        onlyInBase: false,
        onlyInComparison: false,
        oldInternalId: baseRecord.internalId,
        newInternalId: compRecord.internalId,
      });
    } else if (baseRecord) {
      // Only in base account.
      filesWithDiffs++;
      fileResults.push({
        filePath,
        hunks: buildFullDeleteHunk(baseRecord.lines),
        onlyInBase: true,
        onlyInComparison: false,
        oldInternalId: baseRecord.internalId,
      });
    } else {
      // Only in comparison account.
      filesWithDiffs++;
      fileResults.push({
        filePath,
        hunks: buildFullAddHunk(compRecord.lines),
        onlyInBase: false,
        onlyInComparison: true,
        newInternalId: compRecord.internalId,
      });
    }
  }

  return {
    type: MSG.COMPARE_FOLDER_RESULT,
    folderPath,
    fileResults,
    totalFiles: allKeys.size,
    filesWithDiffs,
  };
};

/**
 * Handle a BUILD_COMPARISON_INDEX message: build (or refresh) the target
 * account's index into its per-account cache slot. The origin may point at
 * any account — the diff page can pull the diff base's index remotely — so
 * the resolved account is not assumed to be the current tab's account.
 * @param {{type?: string, mode?: string, folders?: string[], skipMinified?: boolean}} [msg]
 * @returns {Promise<object>}
 */
const buildComparisonIndexMsg = async (msg = {}) => {
  const diffBase = await getDiffState();
  // An explicit origin names the target account directly (e.g. a per-account
  // "Refresh" from the accounts page), so it is valid without a diff base.
  if (!diffBase && !msg.origin) {
    return {
      type: MSG.ERROR,
      message: "No diff base account set. Use the menu to set a base account first.",
    };
  }

  const account = await resolveAccountWithHint(msg.origin);
  if (!account) {
    return {
      type: MSG.ERROR,
      message: "No NetSuite tab detected. Open a NetSuite tab and try again.",
    };
  }
  return runIndexBuild(msg, account, "comparison-ready");
};

