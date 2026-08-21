// popup/popup.js — UI logic: events, messaging, rendering

import {
  MSG,
  SEARCH_DEBOUNCE_MS,
  LONG_LINE_CHARS,
  CHAR_CONTEXT,
  COMPACT_CONTEXT_RADIUS,
  NETSUITE_HOST_RE,
} from "../lib/constants.js";
import { getSettings, setSettings } from "../lib/storage.js";
import { tokenizeLine } from "../lib/highlight.js";
import { fuzzyMatch } from "../lib/fuzzyMatch.js";
import {
  renderAccounts,
  wireAccountsList,
  accountOriginFor,
} from "./accounts.js";

// ---- Element refs ----
const el = {
  accountLabel: document.getElementById("account-label"),
  accountDot: document.getElementById("account-dot"),
  themeToggleBtn: document.getElementById("theme-toggle-btn"),
  search: document.getElementById("search-input"),
  regexToggle: document.getElementById("regex-toggle"),
  wholeWordToggle: document.getElementById("wholeword-toggle"),
  caseToggle: document.getElementById("case-toggle"),
  sortSelect: document.getElementById("sort-select"),
  chipRow: document.getElementById("chip-row"),
  chipContainer: document.getElementById("chip-container"),
  chipModeToggle: document.getElementById("chip-mode"),
  chipModeLabel: document.getElementById("chip-mode-label"),
  chipClearAll: document.getElementById("chip-clear-all"),
  regexMaxLines: document.getElementById("regex-max-lines"),
  buildBtn: document.getElementById("build-btn"),
  cancelBtn: document.getElementById("cancel-btn"),
  rebuildBtn: document.getElementById("rebuild-btn"),
  searchWrap: document.querySelector(".search-wrap"),
  searchOptions: document.querySelector(".search-options"),
  clearBtn: document.getElementById("clear-btn"),
  clearAllBtn: document.getElementById("clear-all-btn"),
  accountsBtn: document.getElementById("accounts-btn"),
  accountsSection: document.getElementById("accounts-section"),
  accountsUsage: document.getElementById("accounts-usage"),
  accountsList: document.getElementById("accounts-list"),
  accountsFooter: document.getElementById("accounts-footer"),
  accountsClearAllBtn: document.getElementById("accounts-clear-all-btn"),
  skipMinified: document.getElementById("skip-minified"),
  autoPurge: document.getElementById("auto-purge"),
  folderChecks: Array.from(document.querySelectorAll('input[id^="folder--"]')),
  menu: document.getElementById("menu"),
  openTabBtn: document.getElementById("open-tab-btn"),
  indexStatus: document.getElementById("index-status"),
  resultCount: document.getElementById("result-count"),
  exportCsvBtn: document.getElementById("export-csv-btn"),
  resultsToolbar: document.getElementById("results-toolbar"),
  resultsCollapseAll: document.getElementById("results-collapse-all"),
  resultsExpandAll: document.getElementById("results-expand-all"),
  progress: document.getElementById("progress"),
  progressFill: document.getElementById("progress-fill"),
  progressText: document.getElementById("progress-text"),
  toolbar: document.querySelector(".toolbar"),
  results: document.getElementById("results"),
  empty: document.getElementById("empty"),
  emptyTitle: document.getElementById("empty-title"),
  emptySub: document.getElementById("empty-sub"),
  emptyBuildBtn: document.getElementById("empty-build-btn"),
  modeToggleBtn: document.getElementById("mode-toggle-btn"),
  diffSection: document.getElementById("diff-section"),
  setDiffBaseBtn: document.getElementById("set-diff-base-btn"),
  diffBanner: document.getElementById("diff-banner"),
  diffBannerText: document.getElementById("diff-banner-text"),
  diffBannerBuildBtn: document.getElementById("diff-banner-build-btn"),
  diffBannerDismissBtn: document.getElementById("diff-banner-dismiss-btn"),
  diffFolderSelect: document.getElementById("diff-folder-select"),
  diffBaseSelect: document.getElementById("diff-base-select"),
  diffCompSelect: document.getElementById("diff-comp-select"),
  diffFilePath: document.getElementById("diff-file-path"),
  diffAutocomplete: document.getElementById("diff-autocomplete"),
  diffCompareBtn: document.getElementById("diff-compare-btn"),
  diffOutput: document.getElementById("diff-output"),
  diffFolderChecks: Array.from(document.querySelectorAll(".diff-folder")),
  diffBulkCollapse: document.getElementById("diff-bulk-collapse"),
  diffBulkExpand: document.getElementById("diff-bulk-expand"),
};

/** @type {object} */
const state = {
  skipMinified: false,
  theme: "light",
  folders: ["-15", "-16", "-19"],
  accountOrigin: null,
  lastTerm: "",
  chips: [],
  chipMode: "and",
  hits: [],
  cards: [],
  rendered: 0,
  mode: "search",
  diffVisible: false,
  isTab: false,
  isSearchTab: false,
  isDiffTab: false,
  comparing: false,
  buildActive: false,
  buildKind: null,
  buildId: 0,
  buildStartedAt: 0,
  lastProgressAt: 0,
  buildWatchdog: null,
  folderDiffMode: false,
  diffBaseAccount: null,
  diffBaseOrigin: null,
  // Comparison side selected in the diff pickers (account label). null means
  // "the active tab's account" — the historical default. Popup-local, not
  // persisted: the base is the long-lived reference, the comparison is the
  // per-session working side.
  diffCompLabel: null,
  accountsData: null,
  currentAccount: null,
  baseIndexReady: false,
  baseReady: false,
  baseScriptCount: 0,
  scriptCount: 0,
  buildAccount: null,
  bannerTarget: null,
  autocompleteItems: [],
  autocompleteHighlighted: -1,
  comparisonFilesCache: null,
  collapsedFileIds: new Set(),
  bulkTogglesVisible: false,
  filteredCards: [],
  groupBy: "none",
  groups: [],
  filteredGroups: [],
  collapsedGroups: new Set(),
  collapsedCards: new Set(),
  plan: [],
};

// ---- Messaging helper ----

/**
 * Send a message to the service worker and await a response.
 * @template {Record<string, unknown>} Req
 * @template {Record<string, unknown>} Res
 * @param {Req} message - Message to send.
 * @returns {Promise<Res>} Response from the service worker.
 */
const send = (message) => chrome.runtime.sendMessage(message);

// ---- Init ----

/**
 * Application bootstrap: detect tab mode, wire DOM events, load settings,
 * resolve the NetSuite account, refresh index status, and restore any
 * in-session search query.
 * @returns {Promise<void>}
 */
const init = async () => {
  detectTabMode();
  wireEvents();
  await loadSettings();
  await resolveAccount();
  const firstStatus = await refreshStatus();
  // The spawn-time purge is the only thing that clears stale caches; report
  // it once, at init, instead of on every status refresh.
  if (firstStatus?.purged) {
    showToast("Cleared cache older than 4 hours — click Build / Refresh to re-pull.");
  }
  await restoreQuery();
};

/**
 * Save the current search query to chrome.storage.session so it persists
 * across popup close/reopen.
 * @returns {void}
 */
const saveQuery = () => {
  try {
    chrome.storage.session.set({
      "ssnav.query": {
        term: state.lastTerm,
        caseSensitive: el.caseToggle.checked,
        regex: el.regexToggle.checked,
        wholeWord: el.wholeWordToggle.checked,
        group: el.sortSelect.value,
        chips: state.chips,
        chipMode: state.chipMode,
        mode: state.mode,
      },
    });
  } catch {
    /* session storage unavailable — ignore */
  }
};

/**
 * Restore the search query from session storage and automatically re-run it.
 * @returns {Promise<void>}
 */
const restoreQuery = async () => {
  try {
    // A tab explicitly opened as a diff view always starts in diff mode, even
    // when there is no saved query to restore.
    if (state.isDiffTab) {
      await switchMode("diff");
    }
    const res = await chrome.storage.session.get("ssnav.query");
    /** @type {object | undefined} */
    const q = res["ssnav.query"];
    if (!q) return;
    if (q.term) el.search.value = q.term;
    el.caseToggle.checked = !!q.caseSensitive;
    el.regexToggle.checked = !!q.regex;
    el.wholeWordToggle.checked = !!q.wholeWord;
    el.sortSelect.value = ["none", "folder", "type"].includes(q.group) ? q.group : "none";
    state.groupBy = el.sortSelect.value;
    state.chips = Array.isArray(q.chips) ? q.chips.slice() : [];
    state.chipMode = q.chipMode === "and" ? "and" : "or";
    el.chipModeToggle.checked = state.chipMode === "or";
    renderChips();
    // Restore diff mode (e.g. reopening the popup on a different account).
    // Runs after refreshStatus, so diffBaseAccount/baseReady are current.
    // Search-only pop-out tabs are never allowed to enter diff mode.
    if (q.mode === "diff" && !state.isSearchTab && !state.isDiffTab) {
      await switchMode("diff");
    }
    if (!q.term && !state.chips.length) return;
    await onSearch();
  } catch {
    /* ignore */
  }
};

/**
 * Detect whether the popup is open as a full browser tab and adjust layout.
 * Tabs are single-purpose: a search tab (?tab=1) cannot enter diff mode, while
 * a diff tab (?tab=1&diff=1) is locked to the diff view.
 * @returns {void}
 */
const detectTabMode = () => {
  const params = new URLSearchParams(location.search);
  const isTab = params.get("tab") === "1";
  const isDiffTab = isTab && params.get("diff") === "1";
  state.isTab = isTab;
  state.isSearchTab = isTab && !isDiffTab;
  state.isDiffTab = isDiffTab;
  if (isTab) {
    document.body.classList.add("in-tab");
    el.openTabBtn.classList.add("hidden");
    document.title = isDiffTab
      ? "SuiteScript Navigator — Diff"
      : "SuiteScript Navigator";
    // Hide the mode toggle: search tabs must not initiate diff mode, and diff
    // tabs stay in diff mode. Full tabs are single-purpose, so the accounts
    // page is popup-only as well.
    if (el.modeToggleBtn) el.modeToggleBtn.classList.add("hidden");
    if (el.accountsBtn) el.accountsBtn.classList.add("hidden");
  }
};

/**
 * Apply the active theme to the document root and keep the header toggle
 * button's glyph and label in sync.
 * @param {"light" | "dark"} theme
 * @returns {void}
 */
const applyTheme = (theme) => {
  const t = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = t;
  const btn = el.themeToggleBtn;
  if (btn) {
    btn.textContent = t === "dark" ? "☀" : "☾";
    const label = t === "dark" ? "Switch to light mode" : "Switch to dark mode";
    btn.setAttribute("aria-label", label);
    btn.title = label;
  }
  state.theme = t;
};

/**
 * Load persisted settings from chrome.storage.sync and sync the UI controls.
 * @returns {Promise<void>}
 */
const loadSettings = async () => {
  try {
    const settings = await getSettings();
    // Apply the theme first so it is set before the UI renders (no flash).
    applyTheme(settings.theme);
    state.skipMinified = !!settings.skipMinified;
    el.skipMinified.checked = state.skipMinified;
    el.autoPurge.checked = settings.autoPurgeStale !== false;
    el.regexMaxLines.value = Number(settings.regexMaxLines) || 0;

    state.folders = Array.isArray(settings.folders)
      ? settings.folders
      : ["-15", "-16", "-19"];
    el.folderChecks.forEach((cb) => {
      cb.checked = state.folders.includes(cb.dataset.folder);
    });
  } catch {
    /* ignore */
  }
};

/**
 * Attach all DOM event listeners for UI controls.
 * @returns {void}
 */
const wireEvents = () => {
  el.search.addEventListener("input", debounce(onSearch, SEARCH_DEBOUNCE_MS));
  el.search.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      const val = el.search.value.trim();
      if (val) {
        e.preventDefault();
        addChip(val);
      }
    } else if (e.key === "Backspace" && !el.search.value && state.chips.length) {
      e.preventDefault();
      state.chips.pop();
      renderChips();
      onSearch();
    }
  });
  el.caseToggle.addEventListener("change", onSearch);
  el.regexToggle.addEventListener("change", onSearch);
  el.wholeWordToggle.addEventListener("change", onSearch);
  el.sortSelect.addEventListener("change", onGroupChange);
  el.chipModeToggle.addEventListener("change", () => {
    state.chipMode = el.chipModeToggle.checked ? "or" : "and";
    renderChips();
    onSearch();
  });
  el.chipContainer.addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".chip-remove");
    if (!removeBtn) return;
    const value = removeBtn.dataset.value;
    state.chips = state.chips.filter((c) => c !== value);
    renderChips();
    onSearch();
  });
  el.chipClearAll.addEventListener("click", () => {
    if (!state.chips.length) return;
    state.chips = [];
    renderChips();
    onSearch();
  });
  el.regexMaxLines.addEventListener("change", async () => {
    const n = Math.max(0, Math.floor(Number(el.regexMaxLines.value) || 0));
    el.regexMaxLines.value = n;
    await setSettings({ regexMaxLines: n });
    if (state.lastTerm || state.chips.length) onSearch();
  });
  el.buildBtn.addEventListener("click", () => onBuild("delta"));
  el.emptyBuildBtn.addEventListener("click", () => onBuild("delta"));
  el.cancelBtn.addEventListener("click", onCancel);
  el.openTabBtn.addEventListener("click", onOpenTab);
  el.rebuildBtn.addEventListener("click", () => {
    closeMenu();
    onBuild("rebuild");
  });
  el.clearBtn.addEventListener("click", () => {
    closeMenu();
    onClear();
  });
  if (el.clearAllBtn) {
    el.clearAllBtn.addEventListener("click", () => {
      closeMenu();
      onClearAll();
    });
  }
  if (el.accountsBtn) {
    el.accountsBtn.addEventListener("click", () => {
      switchMode(state.mode === "accounts" ? "search" : "accounts");
    });
  }
  if (el.accountsClearAllBtn) {
    el.accountsClearAllBtn.addEventListener("click", onClearAll);
  }
  if (el.accountsList) {
    wireAccountsList(el.accountsList, {
      onClear: onClearAccount,
      onClearAll,
      onSetBase: onSetBaseAccount,
      onRefresh: onRefreshAccount,
    });
  }
  el.skipMinified.addEventListener("change", async () => {
    state.skipMinified = el.skipMinified.checked;
    await setSettings({ skipMinified: state.skipMinified });
    if (state.lastTerm) onSearch();
  });
  el.autoPurge.addEventListener("change", async () => {
    await setSettings({ autoPurgeStale: el.autoPurge.checked });
  });
  el.themeToggleBtn.addEventListener("click", async () => {
    const next = state.theme === "dark" ? "light" : "dark";
    await setSettings({ theme: next });
    applyTheme(next);
  });
  el.folderChecks.forEach((cb) => {
    cb.addEventListener("change", async () => {
      state.folders = el.folderChecks
        .filter((c) => c.checked)
        .map((c) => c.dataset.folder);
      await setSettings({ folders: state.folders });
      if (!state.folders.length) {
        showToast("Select at least one folder to index.");
      }
    });
  });

  document.addEventListener("click", (e) => {
    if (el.menu.open && !el.menu.contains(e.target)) el.menu.open = false;
    // Close autocomplete when clicking outside
    if (!e.target.closest(".diff-autocomplete") && !e.target.closest("#diff-file-path")) {
      hideAutocomplete();
    }
  });

  // Diff UI events
  if (el.modeToggleBtn) {
    el.modeToggleBtn.addEventListener("click", () => {
      switchMode(state.mode === "diff" ? "search" : "diff");
    });
  }
  el.diffCompareBtn.addEventListener("click", handleCompare);
  el.diffFilePath.addEventListener("input", debounce(() => {
    showAutocomplete(el.diffFilePath.value);
  }, 150));
  el.diffFilePath.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      navigateAutocomplete(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      navigateAutocomplete(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (state.autocompleteHighlighted >= 0 && state.autocompleteItems.length) {
        selectAutocompleteItem(state.autocompleteItems[state.autocompleteHighlighted]);
      } else if (!state.comparing) {
        handleCompare();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      hideAutocomplete();
    }
  });
  el.diffAutocomplete.addEventListener("click", (e) => {
    const item = e.target.closest(".diff-autocomplete-item");
    if (item) {
      selectAutocompleteItem(item.dataset.path);
    }
  });
  el.setDiffBaseBtn.addEventListener("click", handleSetDiffBase);
  el.diffBaseSelect.addEventListener("change", handleDiffBaseSelect);
  el.diffCompSelect.addEventListener("change", handleDiffCompSelect);
  el.diffBannerBuildBtn.addEventListener("click", handleBannerBuild);
  el.diffBannerDismissBtn.addEventListener("click", () => {
    el.diffBanner.classList.add("hidden");
    // In the popup, dismissing the banner leaves diff mode. Diff tabs stay in
    // diff mode — the banner can reappear on the next status refresh.
    if (state.mode === "diff" && !state.isDiffTab) {
      switchMode("search");
    }
  });

  // Bulk collapse/expand
  el.diffBulkCollapse.addEventListener("click", collapseAllFiles);
  el.diffBulkExpand.addEventListener("click", expandAllFiles);

    // CSV export
      el.exportCsvBtn.addEventListener("click", exportCsv);
      el.resultsCollapseAll.addEventListener("click", collapseAllCards);
      el.resultsExpandAll.addEventListener("click", expandAllCards);

      chrome.runtime.onMessage.addListener((msg) => {
    if (!msg?.type) return;
    if (msg.type === MSG.PROGRESS) {
      onProgress(msg);
    } else if (
      msg.type === MSG.INDEX_READY ||
      msg.type === MSG.CANCELLED ||
      msg.type === MSG.ERROR
    ) {
      // Deliberately NOT gated on state.buildActive: a popup that was closed
      // and reopened mid-build (or opened just as the build finished) renders
      // progress broadcasts but never received the BUILD_STARTED ack. Dropping
      // the final broadcast here is what froze the UI on "Finalizing…".
      onBuildFinished(msg);
    }
  });

  // Cross-view theme sync: the popup can be open in the sidebar and as a full
  // tab at the same time, so mirror theme changes made in the other view.
  // Only acts when the stored theme actually differs from state.theme, which
  // also prevents an echo loop from this view's own toggle.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const change = changes["ssnav.settings"];
    const theme = change?.newValue?.theme;
    if (theme && theme !== state.theme) applyTheme(theme);
  });
}

/**
 * Close the kebab (<more>) menu.
 * @returns {void}
 */
const closeMenu = () => {
  el.menu.open = false;
};

// ---- Index status ----

/**
 * Query the service worker for the latest index status and render it.
 * @returns {Promise<object | null>} The status response (or null on error).
 */
const refreshStatus = async () => {
  try {
    const res = await send({
      type: MSG.GET_STATUS,
      origin: state.accountOrigin,
    });
    // Adopt a build the service worker is running that this popup instance did
    // not start (e.g. the popup was closed and reopened mid-pull). Without
    // this, no watchdog exists here and the progress bar freezes on its last
    // tick ("Finalizing…") even though the build finishes fine in the worker.
    if (res.building && !state.buildActive) {
      state.buildActive = true;
      state.buildKind = res.buildKind === "comparison" ? "comparison" : "base";
      state.buildId += 1;
      state.buildStartedAt = Date.now();
      state.lastProgressAt = Date.now();
      setBuildingUI(true, "delta");
      showProgress("Index build in progress…", true);
      startBuildWatchdog();
    }
    renderStatus(res);

    // Handle diff state
    const diffBase = res.diffState || null;
    state.diffBaseAccount = diffBase;
    state.diffBaseOrigin = res.diffBaseOrigin || null;
    state.baseReady = !!res.baseReady;

    const meta = res.meta;
    const currentAccount = res.currentAccount || null;
    state.currentAccount = currentAccount;
    state.baseIndexReady =
      !!meta && meta.status === "ready" && meta.accountId === currentAccount;
    // Per-account slots: meta always belongs to the current account.
    state.indexReadyForAccount = !!meta && meta.status === "ready";
    state.scriptCount = res.scriptCount ?? (meta?.scriptCount || 0);
    state.baseScriptCount = res.baseScriptCount || 0;
    state.buildAccount = res.buildAccount || null;

    // Show/hide the "Set as diff base" menu item (hidden when the active
    // tab's account is already the base).
    el.setDiffBaseBtn.classList.toggle(
      "hidden",
      !!(diffBase && currentAccount && currentAccount === diffBase),
    );

    // Banner logic for diff mode. The comparison side is the account picked
    // in the diff pickers (state.diffCompLabel) or the active tab's account.
    if (diffBase && state.mode === "diff") {
      const compLabel = state.diffCompLabel || currentAccount;
      const compIsCurrent = !!(currentAccount && compLabel === currentAccount);
      const sameAccount = !!(compLabel && compLabel === diffBase);
      const compReady = compIsCurrent
        ? state.indexReadyForAccount
        : accountReady(compLabel);
      const baseReady = state.baseReady;
      const setFolderLabel = (text) => {
        const folderLabel = el.diffBanner.querySelector(".diff-folder-label");
        if (folderLabel) folderLabel.textContent = text;
      };
      // Case 1: base and comparison are the same account with no cached
      // index. Pulling that account's index serves both sides at once.
      if (sameAccount && !baseReady) {
        el.diffBannerText.textContent = compIsCurrent
          ? `Diff base (${diffBase}) has no cached index. Pull files for this account?`
          : `Diff base (${diffBase}) has no cached index. Pull the base index now?`;
        el.diffBanner.classList.remove("hidden");
        el.diffBannerBuildBtn.textContent = compIsCurrent ? "Pull index" : "Pull base index";
        el.diffFolderSelect.style.display = "";
        setFolderLabel("Folders to index:");
        state.bannerTarget = compIsCurrent ? "current" : "base";
      }
      // Case 1b: base and comparison are the same account — nothing to diff
      // until the user picks a different comparison account (or navigates).
      else if (sameAccount) {
        el.diffBannerText.textContent =
          `Diff base and comparison are both ${diffBase}. Pick a different comparison account, or navigate to another NetSuite account.`;
        el.diffBanner.classList.remove("hidden");
        // No index to build here — hide the folder/button row
        el.diffFolderSelect.style.display = "none";
        state.bannerTarget = null;
      }
      // Case 3: base is a different account with no cached index — offer a
      // remote pull of the base account's index (or build it on that account).
      else if (!sameAccount && !baseReady) {
        el.diffBannerText.textContent =
          `Diff base ${diffBase} has no cached index. Pull the base index now, or open account ${diffBase} and build it there.`;
        el.diffBanner.classList.remove("hidden");
        el.diffBannerBuildBtn.textContent = "Pull base index";
        el.diffFolderSelect.style.display = "";
        setFolderLabel("Folders to index:");
        state.bannerTarget = "base";
      }
      // Case 2: base is ready but the comparison side has no index yet —
      // offer to build the comparison side's index (remotely when the picked
      // account is not the active tab).
      else if (!sameAccount && baseReady && !compReady && compLabel) {
        el.diffBannerText.textContent =
          `Diff base: ${diffBase}. Build the comparison index for ${compLabel}?`;
        el.diffBanner.classList.remove("hidden");
        el.diffBannerBuildBtn.textContent = "Build comparison index";
        el.diffFolderSelect.style.display = "";
        setFolderLabel("Folders to compare:");
        state.bannerTarget = compIsCurrent ? "current" : "compare";
      } else {
        el.diffBanner.classList.add("hidden");
        state.bannerTarget = null;
      }

      // Sync diff folder checkboxes with current folder settings
      el.diffFolderChecks.forEach((cb) => {
        cb.checked = state.folders.includes(cb.dataset.folder);
      });
    } else {
      el.diffBanner.classList.add("hidden");
    }

    // Keep the base / comparison pickers in sync with the status (selection
    // values derive from state, so re-rendering never loses the user's pick).
    if (state.mode === "diff") renderDiffAccountSelects();
    return res;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Render the index status badge (script count, storage usage, staleness).
 * @param {{ scriptCount?: number, meta?: object, usage?: { bytes?: number, ratio?: number }, resumable?: boolean } | null | undefined} status - Status object from the service worker.
 * @returns {void}
 */
const renderStatus = (status) => {
  const count = status?.scriptCount || 0;
  const meta = status?.meta || null;
  const usage = status?.usage || null;

  if (!count && !meta) {
    el.indexStatus.textContent = "No index yet";
    el.indexStatus.className = "index-status";
    return;
  }

  // Cache was built for a different account — warn instead of presenting its
  // script count as the current account's.
  const currentAccount = status?.currentAccount || null;
  if (currentAccount && meta?.accountId && meta.accountId !== currentAccount) {
    el.indexStatus.textContent = `No index for ${currentAccount} — click Build / Refresh`;
    el.indexStatus.className = "index-status warn";
    return;
  }

  const parts = [`${count.toLocaleString()} script${count === 1 ? "" : "s"}`];
  if (usage?.bytes) parts.push(formatBytes(usage.bytes));
  if (meta?.builtAt) parts.push(`updated ${formatWhen(meta.builtAt)}`);
  el.indexStatus.textContent = parts.join(" · ");

  const nearQuota = usage && usage.ratio >= 0.85;
  const incomplete = status?.resumable;
  if (nearQuota) {
    el.indexStatus.className = "index-status warn";
    el.indexStatus.textContent += " · storage almost full";
  } else if (incomplete) {
    el.indexStatus.className = "index-status warn";
    el.indexStatus.textContent += " · incomplete — click Build / Refresh to resume";
  } else {
    el.indexStatus.className = "index-status ok";
  }
};

// ---- Account resolution (Phase 1) ----

/**
 * Detect an active NetSuite tab and display the account ID.
 * @returns {Promise<void>}
 */
const resolveAccount = async () => {
  try {
    // Check for origin URL parameter (passed when opening from popup as a tab)
    const params = new URLSearchParams(location.search);
    const originParam = params.get("origin");

    if (originParam) {
      // Only trust the parameter when it is an https NetSuite origin;
      // anything else is ignored and falls through to the round-trip below.
      let originUrl = null;
      try {
        originUrl = new URL(originParam);
      } catch {
        originUrl = null;
      }
      if (originUrl && originUrl.protocol === "https:" && NETSUITE_HOST_RE.test(originUrl.hostname)) {
        // Construct account info from the URL parameter
        const firstLabel = originUrl.hostname.split(".")[0] || "";
        const idMatch = firstLabel.match(/^(\d+)(?:-[a-z0-9]+)?$/i);
        const accountId = idMatch ? idMatch[1] : firstLabel;

        el.accountLabel.textContent = `Account ${firstLabel}`;
        el.accountDot.classList.add("ok");
        el.buildBtn.disabled = false;
        state.accountOrigin = originParam;
        return;
      }
    }

    // Fall back to querying the background service worker. It should answer
    // in milliseconds (a tabs query); if it never does (worker crash loop,
    // wedged startup) fail the label instead of sitting on "Checking…"
    // forever.
    const res = await Promise.race([
      send({ type: MSG.RESOLVE_ACCOUNT }),
      new Promise((resolve) =>
        setTimeout(() => resolve({ type: "RESOLVE_TIMEOUT" }), 8000)
      ),
    ]);
    if (res?.type === "RESOLVE_TIMEOUT") {
      el.accountLabel.textContent = "Error";
      el.accountDot.classList.add("warn");
      el.buildBtn.disabled = true;
      state.accountOrigin = null;
      showToast("Service worker did not respond — reload the extension.");
      return;
    }
    if (res?.account) {
      el.accountLabel.textContent = `Account ${res.account.accountLabel || res.account.accountId}`;
      el.accountDot.classList.add("ok");
      el.buildBtn.disabled = false;
      state.accountOrigin = res.account.origin || null;
    } else {
      el.accountLabel.textContent = "No NetSuite tab";
      el.accountDot.classList.add("warn");
      el.buildBtn.disabled = true;
      state.accountOrigin = null;
    }
  } catch (err) {
    el.accountLabel.textContent = "Error";
    showToast(err.message);
  }
}

// ---- Build index (Phase 2 inventory + Phase 3 content, resumable) ----

/**
 * Handler for the "Build / Refresh" button. Triggers a delta or full rebuild
 * of the script index via the service worker.
 * @param {"delta" | "rebuild"} [mode="delta"] - Build mode.
 * @returns {Promise<void>}
 */
const onBuild = async (mode = "delta", folders = null) => {
  const useFolders = folders || state.folders;
  if (!useFolders.length) {
    showToast("Select at least one folder to index (⋯ menu).");
    return;
  }
  setBuildingUI(true, mode);
  showProgress(mode === "rebuild" ? "Rebuilding…" : "Starting…", true);
  try {
    const res = await send({
      type: MSG.BUILD_INDEX,
      mode,
      skipMinified: state.skipMinified,
      folders: useFolders,
      origin: state.accountOrigin,
    });
    if (res?.type === MSG.ERROR) {
      showToast(res.message);
      hideProgress();
      return;
    }
    if (res?.type === MSG.BUILD_STARTED) {
      // Fire-and-forget: the worker acked immediately and will broadcast the
      // final result (INDEX_READY / CANCELLED / ERROR). Resolving this message
      // channel right away keeps the service worker alive for the whole build —
      // holding the channel open for minutes was what got the worker killed
      // (Chrome terminates keepalive workers after ~5 min) and froze the popup
      // at the last progress tick.
      state.buildActive = true;
      state.buildKind = "base";
      state.buildId += 1;
      state.buildStartedAt = Date.now();
      state.lastProgressAt = Date.now();
      startBuildWatchdog();
      return;
    }
    // Legacy fallback: an older service worker replies directly with the final
    // result instead of BUILD_STARTED.
    if (res?.type === MSG.CANCELLED) {
      setProgress(1, 1, res.message || "Cancelled.");
      setTimeout(hideProgress, 4500);
      await refreshStatus();
      if (state.lastTerm) onSearch();
    } else if (res?.type === MSG.INDEX_READY) {
      setProgress(1, 1, res.message || `Indexed ${res.scriptCount} scripts.`);
      setTimeout(hideProgress, 4500);
      await refreshStatus();
      if (state.lastTerm) onSearch();
    }
  } catch (err) {
    showToast(err.message);
    hideProgress();
  } finally {
    if (!state.buildActive) setBuildingUI(false);
  }
}

/**
 * Handle the final result of a fire-and-forget build, delivered via broadcast
 * (INDEX_READY / CANCELLED / ERROR). Also invoked by the build watchdog when a
 * broadcast was lost (e.g., the popup was closed and reopened mid-build).
 * @param {{ type: string, message?: string, phase?: string, scriptCount?: number }} res - Final build result.
 * @returns {void}
 */
const onBuildFinished = (res) => {
  const wasActive = state.buildActive;
  state.buildActive = false;
  state.buildKind = null;
  stopBuildWatchdog();
  if (res?.type === MSG.ERROR) {
    showToast(res.message || "Build failed.");
    hideProgress();
  } else if (res?.type === MSG.CANCELLED) {
    setProgress(1, 1, res.message || "Cancelled.");
    setTimeout(hideProgress, 4500);
    refreshStatus();
    if (state.lastTerm) onSearch();
  } else if (res?.type === MSG.INDEX_READY) {
    if (res.phase === "comparison-ready") {
      state.comparisonFilesCache = null;
      setProgress(1, 1, res.message || "Comparison index updated.");
      setTimeout(hideProgress, 4500);
      // Refresh so the diff banner/labels reflect the finished comparison
      // index (the base branch does the same).
      refreshStatus();
    } else {
      setProgress(1, 1, res.message || `Indexed ${res.scriptCount} scripts.`);
      setTimeout(hideProgress, 4500);
      refreshStatus();
      if (state.lastTerm) onSearch();
    }
  }
  if (wasActive) setBuildingUI(false);
  // Keep the accounts page in sync once a build (e.g. a per-account Refresh)
  // has finished. In diff mode, re-fetch the cached-accounts list so the
  // base / comparison pickers reflect the just-finished build.
  if (state.mode === "accounts") refreshAccountsView();
  if (state.mode === "diff") refreshDiffAccounts().then(renderDiffAccountSelects);
};

/**
 * How often the popup re-checks build status while a build is active (ms).
 * @type {number}
 */
const BUILD_WATCHDOG_MS = 20000;

/**
 * How long a build may sit without progress before the popup assumes the
 * service worker died and resets the UI (ms).
 * @type {number}
 */
const BUILD_STALL_MS = 90000;

/**
 * Start polling build status so the popup can recover if a broadcast is lost
 * or the service worker dies mid-build (e.g., Chrome terminated it).
 * @returns {void}
 */
const startBuildWatchdog = () => {
  stopBuildWatchdog();
  state.buildWatchdog = setInterval(async () => {
    const buildId = state.buildId;
    let res = null;
    try {
      res = await send({
        type: MSG.GET_STATUS,
        origin: state.accountOrigin,
      });
    } catch (err) {
      /* transient failure — the stall check below still runs */
    }
    if (state.buildId !== buildId) return; // a newer build replaced this one
    try {
      if (res) {
        // The worker is authoritative about whether a build is running
        // (res.building). Only trust a ready meta that this build actually
        // wrote (built after we started tracking it) so a stale ready meta
        // from an earlier build cannot clear the UI mid-build; a cancelled
        // meta also counts as finished (the CANCELLED broadcast may have
        // been lost if the popup was closed at that moment).
        const meta = res.buildMeta ?? res.meta;
        const readyFresh =
          meta?.status === "ready" &&
          (!meta.builtAt || meta.builtAt >= state.buildStartedAt - 5000);
        const finished =
          !res.building && (readyFresh || meta?.status === "cancelled");
        if (finished) {
          const wasCancelled = meta?.status === "cancelled";
          onBuildFinished({
            type: wasCancelled ? MSG.CANCELLED : MSG.INDEX_READY,
            phase: wasCancelled
              ? "cancelled"
              : state.buildKind === "comparison"
                ? "comparison-ready"
                : undefined,
            message: wasCancelled
              ? "Build cancelled."
              : state.buildKind === "comparison"
                ? "Comparison index updated."
                : "Index build completed.",
          });
          return;
        }
      }
      if (Date.now() - state.lastProgressAt > BUILD_STALL_MS) {
        stopBuildWatchdog();
        state.buildActive = false;
        state.buildKind = null;
        hideProgress();
        setBuildingUI(false);
        showToast("Build stalled — check the service worker and try again.");
      }
    } catch (err) {
      /* ignore — the next poll retries */
    }
  }, BUILD_WATCHDOG_MS);
};

/**
 * Stop the build status watchdog (no-op if it isn't running).
 * @returns {void}
 */
const stopBuildWatchdog = () => {
  if (state.buildWatchdog !== null) {
    clearInterval(state.buildWatchdog);
    state.buildWatchdog = null;
  }
};

// ---- Open the popup as a full browser tab ----

/**
 * Open the Navigator in a dedicated browser tab.
 * @returns {void}
 */
const onOpenTab = () => {
  let url = chrome.runtime.getURL("popup/popup.html?tab=1");
  // A diff view can be popped out into its own full tab; the tab opens
  // directly in diff mode and stays locked to it.
  if (state.mode === "diff") url += "&diff=1";
  if (state.accountOrigin) {
    url += `&origin=${encodeURIComponent(state.accountOrigin)}`;
  }
  chrome.tabs.create({ url });
  window.close();
};

/**
 * Request the service worker to cancel an in-progress build.
 * @returns {Promise<void>}
 */
const onCancel = async () => {
  el.cancelBtn.disabled = true;
  el.cancelBtn.textContent = "Cancelling…";
  showProgress("Cancelling…", true);
  try {
    const res = await send({ type: MSG.CANCEL_BUILD });
    if (res?.type === MSG.ERROR) showToast(res.message);
  } catch (err) {
    showToast(err.message);
  }
}

/**
 * Clear the cached script index for the current account.
 * @returns {Promise<void>}
 */
const onClear = async () => {
  if (!confirm("Clear the cached script index for this account?")) return;
  // Pin the tab's own account: in a full search tab the active tab is the
  // extension page, so without the hint the worker would fall back to
  // last-used/first-tab resolution and could clear the wrong account.
  const res = await send({ type: MSG.CLEAR_INDEX, origin: state.accountOrigin });
  if (res?.type === MSG.ERROR) {
    showToast(res.message);
    return;
  }
  state.hits = [];
  state.cards = [];
  renderResults();
  // The cleared account may be the diff base or the default comparison side
  // (the active tab's account) — invalidate the cached file list.
  state.comparisonFilesCache = null;
  await refreshStatus();
  showToast("Cache cleared.");
};

/**
 * Clear the cached script index for ALL accounts.
 * @returns {Promise<void>}
 */
const onClearAll = async () => {
  if (!confirm("Clear cache for ALL accounts?")) return;
  const res = await send({ type: MSG.CLEAR_ALL_CACHE });
  if (res?.type === MSG.ERROR) {
    showToast(res.message);
    return;
  }
  state.hits = [];
  state.cards = [];
  renderResults();
  // Every cache went — so did whichever accounts the diff sides point at.
  state.diffCompLabel = null;
  state.comparisonFilesCache = null;
  await refreshStatus();
  if (state.mode === "accounts") await refreshAccountsView();
  showToast("All account caches cleared.");
};

// ---- Accounts view ----

/**
 * Fetch and render the list of cached accounts.
 * @returns {Promise<void>}
 */
const refreshAccountsView = async () => {
  const res = await send({
    type: MSG.GET_CACHED_ACCOUNTS,
    origin: state.accountOrigin,
  });
  if (res?.type !== MSG.CACHED_ACCOUNTS) return;
  state.accountsData = res;
  renderAccounts(
    el.accountsList,
    el.accountsUsage,
    el.accountsFooter,
    res,
    {},
  );
};

/**
 * Best-known origin for a cached account label: prefers the origin stored in
 * the account's index meta (correct for non-standard hosts), falls back to
 * synthesizing the standard URL from the label.
 * @param {string} label - Account label (e.g. "1234567-sb1").
 * @returns {string}
 */
const accountOriginForLabel = (label) => {
  const acc = state.accountsData?.accounts?.find((a) => a.accountId === label);
  return accountOriginFor(label, acc?.meta?.origin);
};

/**
 * Clear one account's cached data (per-account row action).
 * @param {string} label - Account label (e.g. "1234567-sb1").
 * @returns {Promise<void>}
 */
const onClearAccount = async (label) => {
  if (!confirm(`Clear the cached data for account ${label}?`)) return;
  const res = await send({
    type: MSG.CLEAR_INDEX,
    origin: accountOriginForLabel(label),
  });
  if (res?.type === MSG.ERROR) {
    showToast(res.message);
    return;
  }
  // The comparison file list depends on both sides. Clearing either side's
  // cache invalidates it; a picked comparison side that lost its cache also
  // resets the pick (the base can stay — the banner offers to pull it again).
  const wasPickedComp = state.diffCompLabel === label;
  const wasDefaultComp =
    state.diffCompLabel === null && label === state.currentAccount;
  if (wasPickedComp) state.diffCompLabel = null;
  if (wasPickedComp || wasDefaultComp) state.comparisonFilesCache = null;
  showToast(`Cache cleared for ${label}.`);
  await refreshStatus();
  await refreshAccountsView();
};

/**
 * Set an account (per-account row action) as the diff base.
 * @param {string} label - Account label.
 * @returns {Promise<void>}
 */
const onSetBaseAccount = async (label) => {
  const res = await send({
    type: MSG.SET_DIFF_BASE_ACCOUNT,
    origin: accountOriginForLabel(label),
  });
  if (res?.type === MSG.ERROR) {
    showToast(res.message);
    return;
  }
  state.comparisonFilesCache = null; // the file list depends on the base
  showToast(`Diff base set to ${label}.`);
  await refreshStatus();
  await refreshAccountsView();
};

/**
 * Re-pull inventory and sources for one account (per-account row action).
 * Fire-and-forget like other builds: the worker broadcasts INDEX_READY.
 * @param {string} label - Account label.
 * @returns {Promise<void>}
 */
const onRefreshAccount = async (label) => {
  if (state.buildActive) {
    showToast("A build is already running.");
    return;
  }
  if (!state.folders.length) {
    showToast("Select at least one folder to index (⋯ menu).");
    return;
  }
  setBuildingUI(true, "delta");
  showProgress("Refreshing…", true);
  // The current account's cache is refreshed through the regular index build
  // (phase "ready"); any other account goes through the comparison build,
  // which accepts an explicit origin and targets that account's cache slot.
  const isCurrent = label === state.currentAccount;
  try {
    const res = await send({
      type: isCurrent ? MSG.BUILD_INDEX : MSG.BUILD_COMPARISON_INDEX,
      origin: accountOriginForLabel(label),
      skipMinified: state.skipMinified,
      folders: state.folders,
    });
    if (res?.type === MSG.ERROR) {
      showToast(res.message);
      hideProgress();
      return;
    }
    if (res?.type === MSG.BUILD_STARTED) {
      state.buildActive = true;
      state.buildKind = isCurrent ? "base" : "comparison";
      state.buildId += 1;
      state.buildStartedAt = Date.now();
      state.lastProgressAt = Date.now();
      startBuildWatchdog();
      return;
    }
    // Legacy fallback: an older worker replies directly with the final result
    // instead of BUILD_STARTED.
    if (res?.type === MSG.CANCELLED || res?.type === MSG.INDEX_READY) {
      setProgress(1, 1, res.message || "Refreshed.");
      setTimeout(hideProgress, 4500);
      await refreshStatus();
      await refreshAccountsView();
    }
  } catch (err) {
    showToast(err.message);
    hideProgress();
  } finally {
    if (!state.buildActive) setBuildingUI(false);
  }
};

/**
 * Toggle button states and visibility during a build operation.
 * @param {boolean} building - True while a build is in progress.
 * @param {"delta" | "rebuild"} [mode] - Current build mode (affects button text).
 * @returns {void}
 */
const setBuildingUI = (building, mode) => {
  el.buildBtn.disabled = building;
  el.rebuildBtn.disabled = building;
  el.clearBtn.disabled = building;
  el.buildBtn.textContent = building
    ? mode === "rebuild"
      ? "Rebuilding…"
      : "Building…"
    : "Build / Refresh";
  el.cancelBtn.classList.toggle("hidden", !building);
  el.cancelBtn.disabled = false;
  el.cancelBtn.textContent = "Cancel";
}

// ---- Progress ----

/**
 * Handle progress broadcasts from the service worker during index builds.
 * @param {{ phase: string, done: number, total?: number, failed?: number }} msg - Progress message.
 * @returns {void}
 */
const onProgress = (msg) => {
  if (msg.phase === "content") {
    const failedSuffix = msg.failed ? ` · ${msg.failed} failed` : "";
    const label =
      msg.done >= msg.total
        ? `Finalizing…${failedSuffix}`
        : `Downloading ${msg.done.toLocaleString()}/${msg.total.toLocaleString()} scripts${failedSuffix}`;
    setProgress(msg.done, msg.total, label);
    state.lastProgressAt = Date.now();
    return;
  }
  const label = `Inventorying scripts… ${msg.done.toLocaleString()} found`;
  showProgress(label, true);
  el.progressText.textContent = label;
  state.lastProgressAt = Date.now();
};

/**
 * Show the progress bar with an optional indeterminate state.
 * @param {string} text - Label to display.
 * @param {boolean} [indeterminate=false] - Whether to show an animated/indeterminate bar.
 * @returns {void}
 */
const showProgress = (text, indeterminate = false) => {
  el.progress.classList.remove("hidden");
  el.progressText.textContent = text;
  el.progressFill.style.width = indeterminate ? "35%" : el.progressFill.style.width;
  el.progressFill.classList.toggle("indeterminate", indeterminate);
};

/**
 * Update the progress bar to a specific percentage.
 * @param {number} done - Number of completed items.
 * @param {number} total - Total number of items.
 * @param {string} [text] - Optional label override.
 * @returns {void}
 */
const setProgress = (done, total, text) => {
  el.progress.classList.remove("hidden");
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  el.progressFill.classList.remove("indeterminate");
  el.progressFill.style.width = `${pct}%`;
  if (text) el.progressText.textContent = text;
};

/**
 * Hide the progress bar and reset its width.
 * @returns {void}
 */
const hideProgress = () => {
  el.progress.classList.add("hidden");
  el.progressFill.style.width = "0%";
  el.progressFill.classList.remove("indeterminate");
};

// ---- Search ----

/**
 * Handler for search input changes (debounced). Queries the service worker
 * and renders matching hits.
 * @returns {Promise<void>}
 */
/**
 * Add a term to the chip list and re-run the search.
 * @param {string} value - Term to add as a chip.
 * @returns {void}
 */
const addChip = (value) => {
  const clean = String(value).trim();
  if (!clean) return;
  if (state.chips.includes(clean)) {
    el.search.value = "";
    return;
  }
  state.chips.push(clean);
  el.search.value = "";
  renderChips();
  onSearch();
};

/**
 * Re-render the chip container from {@link state.chips} and sync the AND/OR
 * toggle label. The row is hidden when there are no chips.
 * @returns {void}
 */
const renderChips = () => {
  el.chipContainer.replaceChildren();
  for (const value of state.chips) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const text = document.createElement("span");
    text.className = "chip-text";
    text.textContent = value;
    const remove = document.createElement("button");
    remove.className = "chip-remove";
    remove.type = "button";
    remove.dataset.value = value;
    remove.title = "Remove chip";
    remove.textContent = "×";
    chip.append(text, remove);
    el.chipContainer.appendChild(chip);
  }
  el.chipModeToggle.parentElement.classList.toggle("hidden", state.chips.length === 0);
  el.chipClearAll.classList.toggle("hidden", state.chips.length === 0);
  el.chipContainer.classList.toggle("hidden", state.chips.length === 0);
  el.chipModeLabel.textContent = state.chipMode === "and" ? "AND" : "OR";
};

const onSearch = async () => {
  // Skip search if in diff mode
  if (state.mode === "diff") {
    renderResults();
    return;
  }

  const term = el.search.value.trim();
  state.lastTerm = term;
  saveQuery();

  if (!term && !state.chips.length) {
    state.hits = [];
    state.cards = [];
    renderResults();
    return;
  }

  const res = await send({
    type: MSG.SEARCH,
    origin: state.accountOrigin,
    term,
    chips: state.chips,
    chipMode: state.chipMode,
    caseSensitive: el.caseToggle.checked,
    regex: el.regexToggle.checked,
    wholeWord: el.wholeWordToggle.checked,
    sort: "relevance",
  });

  if (res?.type === MSG.ERROR) {
    showToast(res.message);
    return;
  }

  // Background reported no valid index for this account — show the build prompt.
  if (res?.noIndex) {
    state.indexReadyForAccount = false;
  } else if (state.indexReadyForAccount !== undefined) {
    state.indexReadyForAccount = true;
  }

  state.hits = res.hits || [];
  state.cards = buildCards(state.hits);
  state.filteredCards = state.cards;
  state.filteredGroups = groupCards(state.cards, state.groupBy);
  state.collapsedCards.clear();
  state.collapsedGroups.clear();
  renderResults(res.truncated);
};

// ---- Rendering ----

/**
 * Group flat hits into cards keyed by file (internalId), preserving the order
 * in which each file's first hit appears. Within a card, hits are sorted by
 * line number so the compact view reads top-to-bottom.
 * @param {object[]} hits - Sorted flat search hits.
 * @returns {{ internalId: string, name: string, folderPath: string, hits: object[] }[]}
 */
const buildCards = (hits) => {
  const byId = new Map();
  for (const hit of hits) {
    if (!byId.has(hit.internalId)) {
      byId.set(hit.internalId, {
        internalId: hit.internalId,
        name: hit.name,
        folderPath: hit.folderPath,
        hits: [],
      });
    }
    byId.get(hit.internalId).hits.push(hit);
  }
  const cards = [...byId.values()];
  for (const card of cards) {
    card.hits.sort((a, b) => a.lineNumber - b.lineNumber);
  }
  return cards;
};

// ---- Grouping helpers ----

/**
 * Classify a file name into a NetSuite script-type label.
 * @param {string} name - file name (e.g. "myUE.js", "customer.js")
 * @returns {string} script type label
 */
const scriptTypeOf = (name) => {
  const base = name.replace(/\.[^.]+$/, "");
  // Detect uppercase suffix at end of name (e.g. "myUE" → "UE", "_CS" → "CS")
  const upper = base.match(/[A-Z]{2,}$/);
  const suf = upper ? upper[0] : "";
  const long = base.toUpperCase();

  const shortMap = {
    UE: "User Event Script",
    CS: "Client Script",
    SS: "Scheduled Script",
    SL: "Suitelet",
    MR: "Map/Reduce Script",
    RE: "RESTlet",
    PL: "Portlet",
    MS: "Mass Update Script",
    WF: "Workflow Action Script",
  };
  if (suf && shortMap[suf]) return shortMap[suf];

  // Long-form checks (use [^A-Za-z] instead of \b since _ is a word char)
  if (/(?:^|[^A-Z])USEREVENT(?:[^A-Z]|$)/.test(long)) return "User Event Script";
  if (/(?:^|[^A-Z])CLIENTS?(?:_SCRIPT)?(?:[^A-Z]|$)/.test(long)) return "Client Script";
  if (/(?:^|[^A-Z])SCHEDULED(?:[^A-Z]|$)/.test(long)) return "Scheduled Script";
  if (/(?:^|[^A-Z])SUITELET(?:[^A-Z]|$)/.test(long)) return "Suitelet";
  if (/(?:^|[^A-Z])MAP[_\-]?REDUCE(?:[^A-Z]|$)/.test(long)) return "Map/Reduce Script";
  if (/(?:^|[^A-Z])RESTLET(?:[^A-Z]|$)/.test(long)) return "RESTlet";
  if (/(?:^|[^A-Z])PORTLET(?:[^A-Z]|$)/.test(long)) return "Portlet";
  if (/(?:^|[^A-Z])MASS[_\-]?UPDATE(?:[^A-Z]|$)/.test(long)) return "Mass Update Script";
  if (/(?:^|[^A-Z])WORKFLOW(?:[^A-Z]|$)/.test(long)) return "Workflow Action Script";
  return "Library / Other";
};

/**
 * Group cards by folder or script type. Returns empty array for "none".
 * @param {{ internalId, name, folderPath, hits }[]} cards
 * @param {"none"|"folder"|"type"} mode
 * @returns {{ key: string, label: string, cards: object[] }[]}
 */
const groupCards = (cards, mode) => {
  if (mode === "none") return [];
  const map = new Map();
  for (const card of cards) {
    const key = mode === "folder" ? (card.folderPath || "(no folder)") : scriptTypeOf(card.name);
    if (!map.has(key)) map.set(key, { key, label: key, cards: [] });
    map.get(key).cards.push(card);
  }
  const groups = [...map.values()];
  groups.sort((a, b) => a.label.localeCompare(b.label));
  for (const g of groups) g.cards.sort((a, b) => a.name.localeCompare(b.name));
  return groups.filter((g) => g.cards.length > 0);
};

/**
 * Build a render plan from filteredGroups. Each item is { type: "group"|"card", ... }.
 * @returns {{ type: string }[]}
 */
const buildPlan = () => {
  const plan = [];
  const groups = state.filteredGroups;
  if (groups.length === 0) {
    for (const card of state.filteredCards) plan.push({ type: "card", card });
    return plan;
  }
  for (const group of groups) {
    plan.push({ type: "group", group });
    if (!state.collapsedGroups.has(group.key)) {
      for (const card of group.cards) plan.push({ type: "card", card });
    }
  }
  return plan;
};

/**
 * Build a collapsible group header + body wrapper.
 * @param {{ key: string, label: string, cards: object[] }} group
 * @returns {HTMLDivElement}
 */
const buildGroupHeader = (group) => {
  const div = document.createElement("div");
  div.className = "group-head";
  div.dataset.groupKey = group.key.replace(/"/g, '&quot;');

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "group-toggle";
  btn.textContent = state.collapsedGroups.has(group.key) ? "+" : "−";

  const label = document.createElement("span");
  label.className = "group-label";
  label.textContent = group.label;

  const count = document.createElement("span");
  count.className = "group-count";
  count.textContent = `${group.cards.length} file${group.cards.length === 1 ? "" : "s"}`;

  div.append(btn, label, count);
  div.addEventListener("click", () => {
    const k = group.key;
    if (state.collapsedGroups.has(k)) state.collapsedGroups.delete(k);
    else state.collapsedGroups.add(k);
    reRenderResults();
  });
  return div;
};

/**
 * Re-render results using current filter + group state (without re-querying).
 * @returns {void}
 */
const reRenderResults = () => {
  el.results.replaceChildren();
  state.plan = buildPlan();
  state.rendered = 0;
  appendMore();
};

/**
 * Handle group-by dropdown change — re-group without re-querying.
 * @returns {void}
 */
const onGroupChange = () => {
  state.groupBy = el.sortSelect.value;
  saveQuery();
  if (state.cards.length === 0) return;
  state.filteredGroups = groupCards(state.filteredCards, state.groupBy);
  reRenderResults();
};

/**
 * Render the search results list. Clears previous results and calls {@link appendMore}.
 * @param {boolean} [truncated=false] - True if the server truncated the hit list.
 * @returns {void}
 */
/**
 * Collapse all rendered search result cards.
 * @returns {void}
 */
const collapseAllCards = () => {
  document.querySelectorAll("#results .card").forEach((article) => {
    if (article.toggle && !article.classList.contains("card-collapsed")) article.toggle();
  });
};

/**
 * Expand all collapsed search result cards.
 * @returns {void}
 */
const expandAllCards = () => {
  document.querySelectorAll("#results .card").forEach((article) => {
    if (article.toggle && article.classList.contains("card-collapsed")) article.toggle();
  });
};

const renderResults = (truncated = false) => {
  el.results.replaceChildren();
  state.rendered = 0;

  if (!state.lastTerm && !state.chips.length) {
    el.resultCount.textContent = "";
    el.empty.classList.remove("hidden");
    el.exportCsvBtn.classList.add("hidden");
    el.resultsCollapseAll.classList.add("hidden");
    el.resultsExpandAll.classList.add("hidden");
    state.collapsedCards.clear();
    state.collapsedGroups.clear();
    updateEmptyPrompt();
    return;
  }

  const count = state.hits.length;
  const files = state.cards.length;
  el.resultCount.textContent = files
    ? `${files} file${files === 1 ? "" : "s"}${truncated ? "+" : ""} · ${count} match${count === 1 ? "" : "es"}`
    : "No matches";
  el.empty.classList.toggle("hidden", files > 0);

  // Show/hide export and bulk toggle buttons
  el.exportCsvBtn.classList.toggle("hidden", count === 0);
  el.resultsCollapseAll.classList.toggle("hidden", count === 0);
  el.resultsExpandAll.classList.toggle("hidden", count === 0);

  if (!files) updateEmptyPrompt();

  state.filteredCards = state.cards;
  state.filteredGroups = groupCards(state.cards, state.groupBy);
  state.plan = buildPlan();

  appendMore();
}

/**
 * Fill the empty-state box: build prompt when the active account has no
 * indexed cache, generic text otherwise.
 * @returns {void}
 */
const updateEmptyPrompt = () => {
  if (state.indexReadyForAccount === false) {
    const account = state.currentAccount || "this account";
    el.emptyTitle.textContent = "No index for this account";
    el.emptySub.textContent =
      `${account} has no cached index. Click Build / Refresh to index its scripts, then search here.`;
    el.emptyBuildBtn.classList.remove("hidden");
  } else {
    el.emptyTitle.textContent = "No results yet";
    el.emptySub.textContent =
      "Search SuiteScript files in this account. Results will appear here.";
    el.emptyBuildBtn.classList.add("hidden");
  }
};

/**
 * Lazily append the next batch of 50 result cards and update the "Show more"
 * button. Called initially by {@link renderResults} and on each "Show more" click.
 * @returns {void}
 */
const appendMore = () => {
  const plan = state.plan || [];
  const frag = document.createDocumentFragment();
  const end = Math.min(state.rendered + 50, plan.length);
  for (let i = state.rendered; i < end; i++) {
    const item = plan[i];
    if (item.type === "group") {
      frag.appendChild(buildGroupHeader(item.group));
    } else {
      frag.appendChild(buildCard(item.card));
    }
  }
  state.rendered = end;
  el.results.appendChild(frag);

  const existing = el.results.querySelector(".show-more");
  if (existing) existing.remove();

  if (state.rendered < plan.length) {
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost show-more";
    btn.textContent = `Show more (${plan.length - state.rendered} left)`;
    btn.addEventListener("click", appendMore);
    el.results.appendChild(btn);
  }
};

/**
 * Export the currently visible search results as a CSV file download.
 * Columns: File Name, Folder Path, Line Number, Matched Line.
 * Respects the secondary filter (exports filtered hits, not all hits).
 * @returns {void}
 */
const exportCsv = () => {
  const hits = state.filteredCards.flatMap((card) => card.hits);
  if (!hits.length) return;

  // CSV header
  const rows = [["File Name", "Folder Path", "Line Number", "Matched Line"]];

  for (const hit of hits) {
    // Find the matched line from context
    const matchedRow = hit.context[hit.matchIndexInContext];
    const matchedLine = matchedRow ? matchedRow.text : "";

    rows.push([
      hit.name,
      hit.folderPath,
      String(hit.lineNumber),
      matchedLine,
    ]);
  }

  // Escape CSV fields: wrap in quotes if contains comma, quote, or newline
  const csvText = rows
    .map((row) =>
      row
        .map((field) => {
          const str = String(field);
          if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
            return '"' + str.replace(/"/g, '""') + '"';
          }
          return str;
        })
        .join(",")
    )
    .join("\r\n");

  // Trigger download (prepend UTF-8 BOM so Excel reads Chinese chars correctly)
    const blob = new Blob(["\uFEFF" + csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const timestamp = new Date().toISOString().slice(0, 10);
  link.download = `suite-script-search-${timestamp}.csv`;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/**
 * Create a DOM card for a group of hits in one file. A single-hit file renders
 * the full ±context window; a multi-hit file renders a compact list of just the
 * matched lines with "gaps" between non-adjacent ones.
 * @param {{ name: string, internalId: string, folderPath: string, hits: object[] }} card
 * @returns {HTMLArticleElement}
 */
const buildCard = (card) => {
  const article = document.createElement("article");
  article.className = "card";

  const head = document.createElement("div");
  head.className = "card-head";

  // Toggle button (first child)
  const isCollapsed = state.collapsedCards.has(card.internalId);
  if (isCollapsed) article.classList.add("card-collapsed");

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "card-toggle";
  toggleBtn.textContent = isCollapsed ? "+" : "−";
  head.appendChild(toggleBtn);

  const toggleCard = () => {
    const id = card.internalId;
    const collapsed = state.collapsedCards.has(id);
    if (collapsed) state.collapsedCards.delete(id);
    else state.collapsedCards.add(id);
    article.classList.toggle("card-collapsed");
    toggleBtn.textContent = collapsed ? "−" : "+";
  };
  // Expose the toggle so "Collapse all" / "Expand all" can drive rendered cards.
  article.toggle = toggleCard;
  head.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    toggleCard();
  });

  const fileUrl = buildFileUrl(card.internalId);
  let name;
  if (fileUrl) {
    name = document.createElement("a");
    name.href = fileUrl;
    name.target = "_blank";
    name.rel = "noopener noreferrer";
    name.title = "Open the file record in NetSuite (background tab — keeps this open)";
    name.addEventListener("click", (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      chrome.tabs.create({ url: fileUrl, active: false });
    });
  } else {
    name = document.createElement("span");
  }
  name.className = "card-name";
  name.textContent = card.name;

  head.appendChild(name);

  const path = document.createElement("span");
  path.className = "card-path";
  path.textContent = card.folderPath || "";

  if (card.hits.length === 1) {
    const hit = card.hits[0];
    const line = document.createElement("span");
    line.className = "card-line";
    line.textContent = `line ${hit.lineNumber}`;
    head.appendChild(line);
    head.appendChild(path);
    article.append(head);

    const code = document.createElement("div");
    code.className = "code";
    const dedent = hit.context.length > 1 ? commonIndent(hit.context) : 0;
    hit.context.forEach((row, idx) => {
      const isMatch = idx === hit.matchIndexInContext;
      const text = dedent ? row.text.slice(dedentLen(row.text, dedent)) : row.text;
      const ranges = isMatch
        ? hit.matchRanges.map((r) => ({ start: Math.max(0, r.start - dedent), len: r.len }))
        : [];
      code.appendChild(buildCodeRow({ n: row.n, text }, isMatch, ranges));
    });

    if (hit.context.length === 1) {
      const note = document.createElement("div");
      note.className = "card-note";
      note.textContent = "Minified / single-line file — showing text around the match.";
      article.append(note);
    }
    article.appendChild(code);
    return article;
  }

  // Compact card: multiple matches in one file.
  article.classList.add("card-compact");
  const count = document.createElement("span");
  count.className = "card-count";
  count.textContent = `${card.hits.length} matches`;
  head.appendChild(count);
  head.appendChild(path);
  article.append(head);

  const code = document.createElement("div");
  code.className = "compact-code";

  // Context preview: show up to COMPACT_CONTEXT_RADIUS lines above/below each
  // match. Overlapping windows are merged so shared lines aren't repeated.
  const rowsByLine = new Map();
  const matchedLines = new Set();
  const addRow = (n, text) => {
    if (!rowsByLine.has(n)) rowsByLine.set(n, { text, ranges: [] });
  };
  for (const hit of card.hits) {
    const ctx = hit.context || [];
    const matchRow = ctx[hit.matchIndexInContext];
    if (!matchRow) continue;
    matchedLines.add(matchRow.n);
    for (const row of ctx) {
      if (Math.abs(row.n - matchRow.n) <= COMPACT_CONTEXT_RADIUS) {
        addRow(row.n, row.text);
      }
    }
  }
  for (const hit of card.hits) {
    const matchRow = hit.context?.[hit.matchIndexInContext];
    if (!matchRow) continue;
    const row = rowsByLine.get(matchRow.n);
    if (row) row.ranges = row.ranges.concat(hit.matchRanges);
  }

  const lineNums = [...rowsByLine.keys()].sort((a, b) => a - b);
  let prevLine = 0;
  for (const n of lineNums) {
    if (prevLine && n - prevLine > 1) {
      const gap = document.createElement("div");
      gap.className = "gap-row";
      const missing = n - prevLine - 1;
      gap.textContent = `${missing} more line${missing === 1 ? "" : "s"}`;
      code.appendChild(gap);
    }
    const row = rowsByLine.get(n);
    const isMatch = matchedLines.has(n);
    const rowEl = buildCodeRow({ n, text: row.text }, isMatch, row.ranges);
    rowEl.classList.add("compact-row");
    code.appendChild(rowEl);
    prevLine = n;
  }
  article.appendChild(code);
  return article;
}

/**
 * Build a single code row (line number + source span). If `isMatch`, wraps
 * the matched ranges in `<mark>` via {@link renderMatchLine}.
 * @param {{ n: number, text: string }} row - Line data.
 * @param {boolean} isMatch - True for the matched line.
 * @param {Array<{ start: number, len: number }>} [ranges=[]] - Highlight ranges.
 * @returns {HTMLDivElement}
 */
const buildCodeRow = (row, isMatch, ranges = []) => {
  const rowEl = document.createElement("div");
  rowEl.className = "code-row" + (isMatch ? " is-match" : "");

  const ln = document.createElement("span");
  ln.className = "ln";
  ln.textContent = String(row.n);

  const src = document.createElement("span");
  src.className = "src";
  if (isMatch) {
    renderMatchLine(src, row.text, ranges);
  } else {
    const text =
      row.text.length > LONG_LINE_CHARS
        ? row.text.slice(0, LONG_LINE_CHARS) + " …"
        : row.text;
    renderCode(src, text, []);
  }

  rowEl.append(ln, src);
  return rowEl;
};

/**
 * Render a matched line with highlight ranges wrapped in `<mark>`. Long lines
 * (e.g. minified files) are windowed to a readable slice around the first match.
 * @param {HTMLElement} container - Element to append content to.
 * @param {string} text - Full line text.
 * @param {Array<{ start: number, len: number }>} ranges - Highlight ranges in `text`.
 * @returns {void}
 */
const renderMatchLine = (container, text, ranges = []) => {
  const first = ranges[0];
  if (text.length <= LONG_LINE_CHARS || !first) {
    renderCode(container, text, ranges);
    return;
  }

  container.classList.add("src-wrap");
  const start = Math.max(0, first.start - CHAR_CONTEXT);
  const end = Math.min(text.length, first.start + first.len + CHAR_CONTEXT);

  if (start > 0) container.appendChild(ellipsis());
  const slice = text.slice(start, end);
  const shifted = ranges
    .map((r) => ({ start: r.start - start, len: r.len }))
    .filter((r) => r.start + r.len > 0 && r.start < slice.length);
  renderCode(container, slice, shifted);
  if (end < text.length) container.appendChild(ellipsis());
}

/**
 * Create a `<span>` element containing an ellipsis for truncated lines.
 * @returns {HTMLSpanElement}
 */
const ellipsis = () => {
  const span = document.createElement("span");
  span.className = "ellipsis";
  span.textContent = " … ";
  return span;
};

/**
 * Calculate the common leading indentation across all non-blank lines in a
 * context window.
 * @param {{ text: string }[]} context - Array of context rows.
 * @returns {number} Number of leading whitespace chars shared by all lines.
 */
const commonIndent = (context) => {
  let min = Infinity;
  for (const row of context) {
    const t = row.text || "";
    if (!t.trim()) continue; // ignore blank lines
    const m = t.match(/^[ \t]*/);
    const n = m ? m[0].length : 0;
    if (n < min) min = n;
    if (min === 0) break;
  }
  return Number.isFinite(min) ? min : 0;
}

/**
 * Count how many leading whitespace characters in `text` can be removed to
 * satisfy a dedent of `n` (never strips non-whitespace).
 * @param {string} text - Line text.
 * @param {number} n - Desired dedent amount.
 * @returns {number} Number of characters to actually slice off.
 */
const dedentLen = (text, n) => {
  let i = 0;
  while (i < n && i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  return i;
};

/**
 * Render a line of code with syntax highlighting and optional search-term
 * marks. Uses {@link tokenizeLine} from highlight.js for tokenization.
 * @param {HTMLElement} container - Element to append tokens to.
 * @param {string} text - Source text.
 * @param {Array<{ start: number, len: number }>} [ranges=[]] - Highlight ranges to wrap in `<mark>`.
 * @returns {void}
 */
const renderCode = (container, text, ranges = []) => {
  // Normalize to [start, end) intervals, dropping empty ones.
  const his = ranges
    .filter((r) => r && r.len > 0)
    .map((r) => ({ start: r.start, end: r.start + r.len }));

  const tokens = tokenizeLine(text);
  let pos = 0; // absolute offset of the current token within `text`

  for (const tok of tokens) {
    const value = tok.value;
    const tStart = pos;
    const tEnd = pos + value.length;
    pos = tEnd;

    const isPlain = tok.type === "text" || tok.type === "ws";
    const target = isPlain ? container : document.createElement("span");
    if (!isPlain) target.className = "tok-" + tok.type;

    // Find which mark intervals overlap this token.
    const overlaps = his.filter((hi) => hi.start < tEnd && hi.end > tStart);
    if (!overlaps.length) {
      target.appendChild(document.createTextNode(value));
    } else {
      let cursor = 0;
      for (const hi of overlaps) {
        const hs = Math.max(hi.start, tStart) - tStart; // start within token
        const he = Math.min(hi.end, tEnd) - tStart; // end within token
        if (hs < 0 || he <= 0 || hs >= value.length) continue;
        const lo = Math.max(cursor, hs);
        const hiClamped = Math.min(value.length, he);
        if (lo > hiClamped) continue;
        if (lo > 0 && lo > cursor) {
          target.appendChild(document.createTextNode(value.slice(cursor, lo)));
        }
        const mark = document.createElement("mark");
        mark.textContent = value.slice(lo, hiClamped);
        target.appendChild(mark);
        cursor = hiClamped;
      }
      if (cursor < value.length) {
        target.appendChild(document.createTextNode(value.slice(cursor)));
      }
    }

    if (!isPlain) container.appendChild(target);
  }
}

// ---- Diff view ----

/**
 * Switch between Search, Diff, and Accounts modes.
 * When entering diff mode, auto-set the current account as the diff base
 * if no base is already set. The Accounts mode (popup-only) lists every
 * cached account with per-account actions.
 * @param {"search"|"diff"|"accounts"} mode
 * @returns {Promise<void>}
 */
const switchMode = async (mode) => {
  // Pop-out search tabs are single-purpose and must not initiate diff mode.
  if (mode === "diff" && state.isSearchTab) return;
  // Full tabs are single-purpose: the accounts page is popup-only.
  if (mode === "accounts" && state.isTab) return;
  state.mode = mode;
  const isDiff = mode === "diff";
  const isAccounts = mode === "accounts";
  state.diffVisible = isDiff;
  el.diffSection.classList.toggle("visible", isDiff);

  // The diff banner lives outside the diff section, so hide it explicitly
  // when leaving diff mode — it must never linger in search mode.
  if (!isDiff && el.diffBanner) el.diffBanner.classList.add("hidden");

  // Update the toggle button label to reflect current mode
  if (el.modeToggleBtn) {
    el.modeToggleBtn.textContent = mode === "diff" ? "Diff" : "Search";
    el.modeToggleBtn.title = isDiff
      ? "Toggle to Search mode"
      : "Toggle to Diff mode";
    el.modeToggleBtn.classList.toggle("active", true);
    // The accounts page gets its back affordance on the Accounts button.
    el.modeToggleBtn.classList.toggle("hidden", isAccounts);
  }
  if (el.accountsBtn) {
    el.accountsBtn.textContent = isAccounts ? "← Back" : "Accounts";
    el.accountsBtn.title = isAccounts
      ? "Back to search"
      : "View cached accounts";
  }

  // Hide search-related UI when in diff mode (or on the accounts page), but
  // keep the toolbar visible so the mode toggle (and ⋯ menu) remain
  // accessible.
  const hideSearch = isDiff || isAccounts;
  const display = hideSearch ? "none" : "";
  if (el.results) el.results.style.display = display;
  if (el.empty) el.empty.style.display = display;
  if (el.resultsToolbar) el.resultsToolbar.style.display = display;
  if (el.searchWrap) el.searchWrap.style.display = display;
  if (el.buildBtn) el.buildBtn.style.display = display;
  if (el.cancelBtn) el.cancelBtn.style.display = display;
  if (el.searchOptions) el.searchOptions.style.display = display;
  if (el.chipRow) el.chipRow.style.display = display;
  if (el.menu) el.menu.classList.toggle("diff-mode", isDiff);

  // The accounts section replaces the results area.
  if (el.accountsSection)
    el.accountsSection.classList.toggle("hidden", !isAccounts);

  if (isAccounts) {
    await refreshAccountsView();
  }

  // Ensure diff is usable: refresh the cached-accounts list for the base /
  // comparison pickers, set base if missing, then re-evaluate status while
  // in diff mode so the banner prompts to pull/build a missing cache.
  if (isDiff) {
    await refreshDiffAccounts();
    if (!state.diffBaseAccount) {
      // No diff base set — auto-set the current account
      try {
        const result = await send({
          type: MSG.SET_DIFF_BASE_ACCOUNT,
          origin: state.accountOrigin,
        });
        if (result.type === MSG.ERROR) {
          showToast(result.message || "Failed to set diff base account.");
        }
      } catch (err) {
        showToast(err.message || "Failed to set diff base account.");
      }
    }
    // Always refresh: with state.mode === "diff", refreshStatus decides whether
    // to show the pull/build banner (missing base index or comparison cache).
    await refreshStatus();
  }
  saveQuery();
};

// ---- Diff account pickers ----
//
// The diff controls offer the base and comparison accounts as pickers over
// the cached accounts list (GET_CACHED_ACCOUNTS) instead of only ever using
// the active tab's account. The base is persisted by the worker (diff
// state); the comparison side is popup-local and defaults to the active
// tab's account (state.diffCompLabel === null).

/** @returns {Array<{ accountId: string, meta?: object, bytes?: number }>} */
const cachedAccountsList = () => state.accountsData?.accounts || [];

/**
 * Fetch the cached accounts list into state.accountsData (no rendering).
 * @returns {Promise<void>}
 */
const refreshDiffAccounts = async () => {
  try {
    const res = await send({
      type: MSG.GET_CACHED_ACCOUNTS,
      origin: state.accountOrigin,
    });
    if (res?.type === MSG.CACHED_ACCOUNTS) state.accountsData = res;
  } catch {
    /* keep whatever we had — the pickers still work with stale data */
  }
};

/**
 * Whether an account has a ready cached index. The active tab's account uses
 * the live GET_STATUS meta; cached accounts use their list entry.
 * @param {string} label - Account label (e.g. "1234567-sb1").
 * @returns {boolean}
 */
const accountReady = (label) => {
  if (!label) return false;
  if (label === state.currentAccount) return state.indexReadyForAccount;
  const a = cachedAccountsList().find((x) => x.accountId === label);
  return !!a?.meta && a.meta.status === "ready";
};

/**
 * Script count for an account label (see accountReady for the data sources).
 * @param {string} label
 * @returns {number}
 */
const accountScriptCount = (label) => {
  if (label === state.currentAccount) return state.scriptCount;
  const a = cachedAccountsList().find((x) => x.accountId === label);
  return a?.meta?.scriptCount ?? 0;
};

/**
 * Origin hint for the comparison side: the picked cached account's stored
 * origin (falls back to the synthesized standard URL), or the active tab's
 * account when nothing is picked.
 * @returns {string | null}
 */
const compOrigin = () =>
  state.diffCompLabel
    ? accountOriginForLabel(state.diffCompLabel)
    : state.accountOrigin;

/**
 * Populate the base/comparison account pickers from the cached accounts
 * list. The base picker always offers the current base and the active tab's
 * account even without a cached index (the banner then offers to pull one);
 * the comparison picker defaults to the active tab's account.
 * @returns {void}
 */
const renderDiffAccountSelects = () => {
  const accounts = cachedAccountsList();
  const base = state.diffBaseAccount || null;
  const current = state.currentAccount || null;

  const dedupe = (labels) => {
    const seen = new Set();
    const out = [];
    for (const l of labels) {
      if (l && !seen.has(l)) {
        seen.add(l);
        out.push(l);
      }
    }
    return out;
  };
  const baseLabels = dedupe([base, current, ...accounts.map((a) => a.accountId)]);
  const compLabels = dedupe([current, ...accounts.map((a) => a.accountId)]);

  const optionText = (label, isCurrent) =>
    `${label}${isCurrent ? " (current tab)" : ""} — ${
      accountReady(label)
        ? `${accountScriptCount(label).toLocaleString()} scripts`
        : "no index"
    }`;

  const fill = (select, labels, selected) => {
    select.textContent = "";
    select.disabled = labels.length === 0;
    for (const label of labels) {
      const opt = document.createElement("option");
      opt.value = label;
      opt.textContent = optionText(label, label === current);
      select.append(opt);
    }
    if (selected && labels.includes(selected)) select.value = selected;
    else if (labels.length) select.value = labels[0];
  };

  fill(el.diffBaseSelect, baseLabels, base);

  // The comparison side defaults to the active tab's account (null). If the
  // previously picked account is no longer cached (and is not the active
  // tab), heal the selection to whatever the picker actually shows.
  const compSel = state.diffCompLabel || current;
  fill(el.diffCompSelect, compLabels, compSel);
  if (el.diffCompSelect.value !== compSel) {
    const healed = el.diffCompSelect.value;
    state.diffCompLabel = healed && healed !== current ? healed : null;
    state.comparisonFilesCache = null;
  }
};

/**
 * Base picker: point the worker's diff state at the picked cached account.
 * Picking the comparison account as the base is legal — the banner explains
 * there is nothing to diff until one side changes.
 * @returns {Promise<void>}
 */
const handleDiffBaseSelect = async () => {
  const label = el.diffBaseSelect.value;
  if (!label || label === state.diffBaseAccount) return;
  try {
    const res = await send({
      type: MSG.SET_DIFF_BASE_ACCOUNT,
      origin: accountOriginForLabel(label),
    });
    if (res?.type === MSG.ERROR) {
      showToast(res.message || "Failed to set diff base account.");
      renderDiffAccountSelects(); // revert the visible selection
      return;
    }
    state.comparisonFilesCache = null; // the file list depends on the base too
    await refreshStatus();
  } catch (err) {
    showToast(err.message || "Failed to set diff base account.");
    renderDiffAccountSelects();
  }
};

/**
 * Comparison picker: switch which account the diff compares against.
 * Popup-local (not persisted); picking the active tab's account restores
 * the historical default (state.diffCompLabel = null).
 * @returns {void}
 */
const handleDiffCompSelect = () => {
  const label = el.diffCompSelect.value;
  state.diffCompLabel = label && label !== state.currentAccount ? label : null;
  state.comparisonFilesCache = null; // the file list depends on this side
  refreshStatus();
};

/**
 * Handle the compare button click.
 * @returns {Promise<void>}
 */
const handleCompare = async () => {
  // Comparing while an index build is running reads a half-written cache and
  // surfaces a misleading "no cached sources" error — block it up front.
  if (state.buildActive) {
    el.diffOutput.innerHTML =
      '<div class="diff-empty">Index build in progress — wait for it to finish before comparing.</div>';
    return;
  }
  const filePath = el.diffFilePath.value.trim();
  if (!filePath) {
    el.diffOutput.innerHTML = '<div class="diff-empty">Enter a file path, folder path ending with /, or just / to compare all</div>';
    return;
  }

  // Detect folder diff mode: path ends with /
  const isFolderDiff = filePath.endsWith("/");

  if (isFolderDiff) {
    // Folder diff mode
    const folderPath = filePath.slice(0, -1); // remove trailing /

    state.comparing = true;
    state.folderDiffMode = true;
    el.diffCompareBtn.textContent = "Comparing folder…";
    el.diffCompareBtn.disabled = true;

    try {
      const result = await send({
        type: MSG.COMPARE_FOLDER,
        folderPath,
        origin: compOrigin(),
      });

      if (result.type === MSG.ERROR) {
        const empty = document.createElement("div");
        empty.className = "diff-empty";
        empty.textContent = result.message || "Folder comparison failed";
        el.diffOutput.appendChild(empty);
      } else if (result.type === MSG.COMPARE_FOLDER_RESULT) {
        renderFolderDiffResult(result);
      } else {
        el.diffOutput.innerHTML = '<div class="diff-empty">Unexpected response from background</div>';
      }
    } catch (err) {
      const empty = document.createElement("div");
      empty.className = "diff-empty";
      empty.textContent = `Error: ${err.message || String(err)}`;
      el.diffOutput.appendChild(empty);
    } finally {
      state.comparing = false;
      state.folderDiffMode = false;
      el.diffCompareBtn.textContent = "Compare";
      el.diffCompareBtn.disabled = false;
    }
  } else {
    // Single file diff mode (existing behavior)
    const lastSlash = filePath.lastIndexOf("/");
    const folderPath = lastSlash >= 0 ? filePath.substring(0, lastSlash) : "";
    const name = lastSlash >= 0 ? filePath.substring(lastSlash + 1) : filePath;

    state.comparing = true;
    state.folderDiffMode = false;
    el.diffCompareBtn.textContent = "…";
    el.diffCompareBtn.disabled = true;

    try {
      const result = await send({
        type: MSG.COMPARE_FILES,
        folderPath,
        name,
        origin: compOrigin(),
      });

      if (result.type === MSG.ERROR) {
        const empty = document.createElement("div");
        empty.className = "diff-empty";
        empty.textContent = result.message || "Comparison failed";
        el.diffOutput.appendChild(empty);
      } else if (result.type === MSG.COMPARE_RESULT) {
        renderDiffResult(result);
      } else {
        el.diffOutput.innerHTML = '<div class="diff-empty">Unexpected response from background</div>';
      }
    } catch (err) {
      const empty = document.createElement("div");
      empty.className = "diff-empty";
      empty.textContent = `Error: ${err.message || String(err)}`;
      el.diffOutput.appendChild(empty);
    } finally {
      state.comparing = false;
      el.diffCompareBtn.textContent = "Compare";
      el.diffCompareBtn.disabled = false;
    }
  }
};

/**
 * Handle the diff banner build button — pulls the base index or builds
 * the comparison index depending on context.
 * @returns {Promise<void>}
 */
const handleBannerBuild = async () => {
  // Collect selected folders
  const folders = el.diffFolderChecks
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.folder);

  if (folders.length === 0) {
    showToast("Select at least one folder.");
    return;
  }

  // Which per-account cache does the banner build button target? "base"
  // pulls the diff base account's index remotely; "compare" pulls the picked
  // comparison account's index remotely; "current" (the default) builds the
  // active tab's account index.
  const target =
    state.bannerTarget === "base" || state.bannerTarget === "compare"
      ? state.bannerTarget
      : "current";
  const compLabel = state.diffCompLabel || state.currentAccount;
  const sameAccount = !!(
    state.diffBaseAccount && compLabel && compLabel === state.diffBaseAccount
  );
  // Same-account needs-base-index case: the comparison side IS the diff base
  // and the active tab, so a regular base build (BUILD_INDEX) writes the
  // same per-account slot.
  const needsBaseIndex =
    target === "current" && sameAccount && !state.indexReadyForAccount;

  el.diffBanner.classList.add("hidden");
  setBuildingUI(true, "delta");

  try {
    if (needsBaseIndex) {
      // Pull the base index for the diff base account (== current account)
      await onBuild("delta", folders);
    } else {
      // Fire-and-forget index build; the final result arrives via broadcast
      // and onBuildFinished. A "base" target points the worker at the diff
      // base's origin directly (credentials include lets a remote-account
      // pull work from any logged-in NetSuite tab); "current" uses the
      // current account's origin.
      const origin =
        target === "base" && state.diffBaseAccount
          ? state.diffBaseOrigin || `https://${state.diffBaseAccount}.app.netsuite.com`
          : target === "compare" && state.diffCompLabel
            ? accountOriginForLabel(state.diffCompLabel)
            : state.accountOrigin;
      const result = await send({
        type: MSG.BUILD_COMPARISON_INDEX,
        folders,
        skipMinified: state.skipMinified,
        origin,
      });

      if (result.type === MSG.ERROR) {
        showToast(result.message || "Comparison index build failed.");
      } else if (result.type === MSG.BUILD_STARTED) {
        state.buildActive = true;
        state.buildKind = "comparison";
        state.buildId += 1;
        state.buildStartedAt = Date.now();
        state.lastProgressAt = Date.now();
        startBuildWatchdog();
        return;
      } else if (result.type === MSG.INDEX_READY && result.phase === "comparison-ready") {
        // Legacy direct response (older service worker)
        state.comparisonFilesCache = null;
        showToast(result.message || "Comparison index ready.");
        await refreshStatus();
      } else {
        showToast("Unexpected response from background.");
      }
    }
  } catch (err) {
    showToast(err.message || "Build failed.");
  } finally {
    if (!state.buildActive) setBuildingUI(false);
  }
};

/**
 * Handle "Set as diff base" menu item click.
 * @returns {Promise<void>}
 */
const handleSetDiffBase = async () => {
  try {
    const result = await send({
      type: MSG.SET_DIFF_BASE_ACCOUNT,
      origin: state.accountOrigin,
    });
    if (result.type === MSG.ERROR) {
      showToast(result.message || "Failed to set diff base account.");
    } else {
      state.comparisonFilesCache = null; // the file list depends on the base
      closeMenu();
      await refreshStatus();
      if (result.needsBaseBuild) {
        showToast("No cached script index for this account — pulling files…");
        await onBuild("delta");
      }
    }
  } catch (err) {
    showToast(err.message || "Failed to set diff base account.");
  }
};

/**
 * Render diff hunks into a container element.
 * @param {DiffHunk[]} hunks - Array of diff hunks to render.
 * @param {HTMLElement} container - Container to append hunks into.
 */
/**
 * Filter hunk lines to show at most `ctxLimit` context lines around each
 * group of changes, deduplicating overlapping context between adjacent changes.
 * @param {DiffLine[]} lines
 * @param {number} ctxLimit
 * @returns {DiffLine[]}
 */
const filterHunkLines = (lines, ctxLimit) => {
  const changes = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== "|") changes.push(i);
  }
  if (changes.length === 0) return lines;
  const include = new Set();
  for (const ci of changes) {
    include.add(ci);
    for (let j = ci - ctxLimit; j < ci; j++) {
      if (j >= 0 && lines[j].type === "|") include.add(j);
    }
    for (let j = ci + 1; j <= ci + ctxLimit; j++) {
      if (j < lines.length && lines[j].type === "|") include.add(j);
    }
  }
  const sorted = [...include].sort((a, b) => a - b);
  return sorted.map(i => lines[i]);
};

const renderHunks = (hunks, container, ctxLimit) => {
  for (const hunk of hunks) {
    // Optionally filter context lines
    const lines = (ctxLimit !== undefined && ctxLimit !== null)
      ? filterHunkLines(hunk.lines, ctxLimit)
      : hunk.lines;

    // Compute header counts from (possibly filtered) lines
    let filtOld = 0, filtNew = 0;
    for (const l of lines) {
      if (l.type !== "+") filtOld++;
      if (l.type !== "-") filtNew++;
    }

    // Hunk header
    const hunkHeader = document.createElement("div");
    hunkHeader.className = "diff-hunk-header";
    hunkHeader.textContent = `@@ -${hunk.oldStart},${filtOld} +${hunk.newStart},${filtNew} @@`;
    container.appendChild(hunkHeader);

    // Render lines
    let oldLineNum = hunk.oldStart;
    let newLineNum = hunk.newStart;
    for (const line of lines) {
      const row = document.createElement("div");
      let rowClass = "diff-row";
      let lnText = "";

      if (line.type === "|") {
        rowClass += " diff-context";
        lnText = `${oldLineNum}  ${newLineNum}`;
        oldLineNum++;
        newLineNum++;
      } else if (line.type === "-") {
        rowClass += " diff-removed";
        lnText = `${oldLineNum}  `;
        oldLineNum++;
      } else {
        rowClass += " diff-added";
        lnText = `    ${newLineNum}`;
        newLineNum++;
      }

      row.className = rowClass;

      const lnSpan = document.createElement("span");
      lnSpan.className = "diff-ln";
      lnSpan.textContent = lnText;

      const contentSpan = document.createElement("span");
      contentSpan.className = "diff-content";
      contentSpan.textContent = line.value;

      row.appendChild(lnSpan);
      row.appendChild(contentSpan);
      container.appendChild(row);
    }
  }
};

/**
 * Count additions and removals across hunks.
 * @param {DiffHunk[]} hunks
 * @returns {{additions: number, removals: number}}
 */
const countChanges = (hunks) => {
  let additions = 0, removals = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === "+") additions++;
      else if (line.type === "-") removals++;
    }
  }
  return { additions, removals };
};

/**
 * Render a diff result in the diff output area.
 * @param {{filePath: string, hunks: DiffHunk[], onlyInBase: boolean, onlyInComparison: boolean, error?: string}} result
 */

/**
 * Create a collapsible file region with header (file path + toggle button) and body.
 * @param {string} filePath - The file path to display.
 * @param {boolean} isCollapsed - Whether the body should start collapsed.
 * @param {Function} [onToggle] - Optional callback when the toggle state changes (receives filePath, isNowCollapsed).
 * @returns {{region: HTMLElement, header: HTMLElement, body: HTMLElement}}
 */
const createFileRegion = (filePath, isCollapsed = false, onToggle, stats = null) => {
  const region = document.createElement("div");
  region.className = "diff-file-region";

  const header = document.createElement("div");
  header.className = "diff-file-header";

  const left = document.createElement("span");
  left.className = "diff-file-header-left";

  const btn = document.createElement("button");
  btn.className = "diff-toggle-btn";
  btn.textContent = isCollapsed ? "+" : "\u2212";

  const pathSpan = document.createElement("span");
  pathSpan.className = "diff-file-path";
  pathSpan.textContent = filePath;

  left.appendChild(btn);
  left.appendChild(pathSpan);
  header.appendChild(left);

  // Add stats if provided
  if (stats && (stats.additions > 0 || stats.removals > 0)) {
    const statsDiv = document.createElement("span");
    statsDiv.className = "diff-stats";

    if (stats.additions > 0) {
      const added = document.createElement("span");
      added.className = "diff-stat-added";
      added.textContent = `+${stats.additions}`;
      statsDiv.appendChild(added);
    }
    if (stats.removals > 0) {
      const removed = document.createElement("span");
      removed.className = "diff-stat-removed";
      removed.textContent = `-${stats.removals}`;
      statsDiv.appendChild(removed);
    }

    header.appendChild(statsDiv);
  }

  region.appendChild(header);

  const body = document.createElement("div");
  body.className = "diff-file-body";
  if (isCollapsed) {
    body.classList.add("hidden");
  }
  region.appendChild(body);

  header.toggle = () => {
    isCollapsed = !isCollapsed;
    btn.textContent = isCollapsed ? "+" : "\u2212";
    body.classList.toggle("hidden", isCollapsed);
    if (onToggle) onToggle(filePath, isCollapsed);
  }

  header.addEventListener("click", () => header.toggle())

  return { region, header, body };
};

/**
 * Collapse all visible diff file bodies.
 * @returns {void}
 */
const collapseAllFiles = () => {
  document.querySelectorAll(".diff-file-header").forEach((header) => {
    if (header.toggle && header.querySelector(".diff-toggle-btn")?.textContent === "\u2212") {
      header.toggle()
    }
  })
};

/**
 * Expand all collapsed diff file bodies.
 * @returns {void}
 */
const expandAllFiles = () => {
  document.querySelectorAll(".diff-file-header").forEach((header) => {
    if (header.toggle && header.querySelector(".diff-toggle-btn")?.textContent === "+") {
      header.toggle()
    }
  })
};

/**
 * Show or hide the bulk collapse/expand buttons.
 * @param {boolean} visible
 * @returns {void}
 */
const setBulkTogglesVisible = (visible) => {
  state.bulkTogglesVisible = visible;
  if (visible) {
    el.diffBulkCollapse.classList.remove("hidden");
    el.diffBulkExpand.classList.remove("hidden");
  } else {
    el.diffBulkCollapse.classList.add("hidden");
    el.diffBulkExpand.classList.add("hidden");
  }
};

/**
 * Render a diff result in the diff output area.
 * @param {{filePath: string, hunks: DiffHunk[], onlyInBase: boolean, onlyInComparison: boolean, error?: string}} result
 */
const renderDiffResult = (result) => {
  const { filePath, hunks, onlyInBase, onlyInComparison, error } = result;

  el.diffOutput.innerHTML = "";

  // Hide bulk toggles in single-file mode
  setBulkTogglesVisible(false);

  // File header with toggle
  const isCollapsed = state.collapsedFileIds.has(filePath);
  const stats = hunks && hunks.length > 0 ? countChanges(hunks) : { additions: 0, removals: 0 };
  const { region, body } = createFileRegion(filePath, isCollapsed, (path, collapsed) => {
    if (collapsed) state.collapsedFileIds.add(path);
    else state.collapsedFileIds.delete(path);
  }, stats);
  el.diffOutput.appendChild(region);

  if (error) {
    const empty = document.createElement("div");
    empty.className = "diff-empty";
    empty.textContent = error;
    body.appendChild(empty);
    return;
  }

  if (onlyInBase) {
    const badge = document.createElement("div");
    badge.className = "diff-empty";
    badge.innerHTML = `<span class="diff-only-badge only-base">Only in base account</span>`;
    body.appendChild(badge);
    if (hunks.length > 0) {
      const lineCount = hunks[0].oldLines;
      const info = document.createElement("div");
      info.className = "diff-file-header";
      info.style.background = "var(--surface)";
      info.innerHTML = `<span style="color: var(--muted); font-size: 10.5px;">${lineCount} line${lineCount !== 1 ? 's' : ''}${lineCount >= 2000 ? ' (capped at 2000)' : ''}</span>`;
      body.appendChild(info);
      renderHunks(hunks, body, 2);
    }
    return;
  }

  if (onlyInComparison) {
    const badge = document.createElement("div");
    badge.className = "diff-empty";
    badge.innerHTML = `<span class="diff-only-badge only-comparison">Only in comparison account</span>`;
    body.appendChild(badge);
    if (hunks.length > 0) {
      const lineCount = hunks[0].newLines;
      const info = document.createElement("div");
      info.className = "diff-file-header";
      info.style.background = "var(--surface)";
      info.innerHTML = `<span style="color: var(--muted); font-size: 10.5px;">${lineCount} line${lineCount !== 1 ? 's' : ''}${lineCount >= 2000 ? ' (capped at 2000)' : ''}</span>`;
      body.appendChild(info);
      renderHunks(hunks, body, 2);
    }
    return;
  }

  if (hunks.length === 0) {
    const identical = document.createElement("div");
    identical.className = "diff-empty diff-identical";
    identical.textContent = "Files are identical";
    body.appendChild(identical);
    return;
  }

  // Render hunks
  renderHunks(hunks, body, 2);
};

/**
 * Render a folder diff result showing diffs for all files in a folder.
 * @param {{folderPath: string, fileResults: Array<{filePath: string, hunks: DiffHunk[], onlyInBase: boolean, onlyInComparison: boolean}>, totalFiles: number, filesWithDiffs: number}} result
 */
const renderFolderDiffResult = (result) => {
  const { folderPath, fileResults, totalFiles, filesWithDiffs } = result;

  el.diffOutput.innerHTML = "";

  // Folder header with summary
  const folderHeader = document.createElement("div");
  folderHeader.className = "diff-folder-header";

  const pathSpan = document.createElement("span");
  const pathStrong = document.createElement("strong");
  pathStrong.textContent = (folderPath || "/") + "\u2009/";
  pathSpan.appendChild(pathStrong);

  const summarySpan = document.createElement("span");
  summarySpan.className = "diff-summary";
  summarySpan.textContent = `${totalFiles} file${totalFiles !== 1 ? "s" : ""}, ${filesWithDiffs} with diff${filesWithDiffs !== 1 ? "s" : ""}`;

  folderHeader.appendChild(pathSpan);
  folderHeader.appendChild(summarySpan);
  el.diffOutput.appendChild(folderHeader);

  if (fileResults.length === 0) {
    const identical = document.createElement("div");
    identical.className = "diff-empty diff-identical";
    identical.textContent = "All files identical";
    el.diffOutput.appendChild(identical);
    setBulkTogglesVisible(false);
    return;
  }

  // Show bulk toggles only when there are 2+ files
  setBulkTogglesVisible(fileResults.length >= 2);

  // Render each file result
  for (let i = 0; i < fileResults.length; i++) {
    const file = fileResults[i];

    // Divider between files (except before the first one)
    if (i > 0) {
      const divider = document.createElement("div");
      divider.className = "diff-file-divider";
      el.diffOutput.appendChild(divider);
    }

    // Create collapsible file region
    const isCollapsed = state.collapsedFileIds.has(file.filePath);
    const fileStats = file.hunks && file.hunks.length > 0 ? countChanges(file.hunks) : { additions: 0, removals: 0 };
    const { region, body } = createFileRegion(file.filePath, isCollapsed, (path, collapsed) => {
      if (collapsed) state.collapsedFileIds.add(path);
      else state.collapsedFileIds.delete(path);
    }, fileStats);
    el.diffOutput.appendChild(region);

    if (file.onlyInBase) {
      const badge = document.createElement("div");
      badge.className = "diff-empty";
      badge.innerHTML = `<span class="diff-only-badge only-base">Only in base account</span>`;
      body.appendChild(badge);
      if (file.hunks.length > 0) {
        const lineCount = file.hunks[0].oldLines;
        const info = document.createElement("div");
        info.className = "diff-file-header";
        info.style.background = "var(--surface)";
        info.innerHTML = `<span style="color: var(--muted); font-size: 10.5px;">${lineCount} line${lineCount !== 1 ? 's' : ''}${lineCount >= 2000 ? ' (capped at 2000)' : ''}</span>`;
        body.appendChild(info);
        renderHunks(file.hunks, body, 2);
      }
      continue;
    }

    if (file.onlyInComparison) {
      const badge = document.createElement("div");
      badge.className = "diff-empty";
      badge.innerHTML = `<span class="diff-only-badge only-comparison">Only in comparison account</span>`;
      body.appendChild(badge);
      if (file.hunks.length > 0) {
        const lineCount = file.hunks[0].newLines;
        const info = document.createElement("div");
        info.className = "diff-file-header";
        info.style.background = "var(--surface)";
        info.innerHTML = `<span style="color: var(--muted); font-size: 10.5px;">${lineCount} line${lineCount !== 1 ? 's' : ''}${lineCount >= 2000 ? ' (capped at 2000)' : ''}</span>`;
        body.appendChild(info);
        renderHunks(file.hunks, body, 2);
      }
      continue;
    }

    if (file.hunks.length === 0) {
      // Shouldn't happen since identical files are filtered, but handle gracefully
      const identical = document.createElement("div");
      identical.className = "diff-empty diff-identical";
      identical.textContent = "No changes";
      body.appendChild(identical);
      continue;
    }

    // Render hunks for this file
    renderHunks(file.hunks, body, 2);
  }
};

// ---- Utils ----

/**
 * Create a debounced version of `fn` that delays invocation by `ms` milliseconds.
 * @template {...any} Args
 * @param {(...args: Args) => void} fn - Function to debounce.
 * @param {number} ms - Delay in milliseconds.
 * @returns {(...args: Args) => void}
 */
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Build a URL to the NetSuite file record page for a given internal ID.
 * Returns null when account origin is unknown.
 * @param {string} [internalId] - File internal ID.
 * @returns {string | null}
 */
const buildFileUrl = (internalId) => {
  if (!state.accountOrigin || !internalId) return null;
  return `${state.accountOrigin}/app/common/media/mediaitem.nl?id=${encodeURIComponent(
    internalId
  )}`;
};

/**
 * Format a byte count as a human-readable string (e.g. "1.2 MB").
 * @param {number} [bytes] - Number of bytes.
 * @returns {string}
 */
const formatBytes = (bytes) => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
};

/**
 * Format a timestamp as a relative time string (e.g. "3h ago").
 * @param {number} ts - Millisecond timestamp.
 * @returns {string}
 */
const formatWhen = (ts) => {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(ts).toLocaleDateString();
};

/**
 * Display a toast notification. Auto-hides after 5s.
 * @param {string} message - Message to display.
 * @returns {void}
 */
const showToast = (message) => {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    el.progress.after(toast);
  }
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 5000);
};

// ---- Diff autocomplete ----

/**
 * Load the list of comparison files from the service worker and cache it.
 * @returns {Promise<void>}
 */
const loadComparisonFiles = async () => {
  if (state.comparisonFilesCache !== null) return;
  try {
    const res = await send({
      type: MSG.GET_COMPARISON_FILES,
      origin: compOrigin(),
    });
    if (res?.type === MSG.GET_COMPARISON_FILES_RESULT) {
      state.comparisonFilesCache = res.files || [];
    }
  } catch {
    /* ignore */
  }
};

/**
 * Fuzzy-match `query` against cached comparison files and render the dropdown.
 * @param {string} query - Search query from the input.
 * @returns {void}
 */
const showAutocomplete = async (query) => {
  if (!query) {
    hideAutocomplete();
    return;
  }

  await loadComparisonFiles();
  if (!state.comparisonFilesCache?.length) {
    hideAutocomplete();
    return;
  }

  // Fuzzy match against all cached file paths
  const matches = [];
  for (const file of state.comparisonFilesCache) {
    const result = fuzzyMatch(query, file.fullPath);
    if (result) {
      matches.push({ file, score: result.score, indices: result.indices });
    }
  }

  // Sort by score descending, limit to 20
  matches.sort((a, b) => b.score - a.score);
  const top = matches.slice(0, 20);

  if (!top.length) {
    hideAutocomplete();
    return;
  }

  state.autocompleteItems = top.map((m) => m.file.fullPath);
  state.autocompleteHighlighted = -1;

  // Render dropdown
  el.diffAutocomplete.innerHTML = "";
  for (const match of top) {
    el.diffAutocomplete.appendChild(renderAutocompleteItem(match.file.fullPath, match.indices));
  }

  el.diffAutocomplete.classList.remove("hidden");
};

/**
 * Hide the autocomplete dropdown.
 * @returns {void}
 */
const hideAutocomplete = () => {
  el.diffAutocomplete.classList.add("hidden");
  state.autocompleteItems = [];
  state.autocompleteHighlighted = -1;
};

/**
 * Select an autocomplete item: set input value and auto-trigger compare.
 * @param {string} fullPath - Full file path to select.
 * @returns {void}
 */
const selectAutocompleteItem = (fullPath) => {
  el.diffFilePath.value = fullPath;
  hideAutocomplete();
  handleCompare();
};

/**
 * Navigate autocomplete highlights by +1 (down) or -1 (up), wrapping around.
 * @param {number} direction - +1 for down, -1 for up.
 * @returns {void}
 */
const navigateAutocomplete = (direction) => {
  if (!state.autocompleteItems.length) return;

  const len = state.autocompleteItems.length;
  state.autocompleteHighlighted =
    (state.autocompleteHighlighted + direction + len) % len;

  // Update visual highlight
  const children = el.diffAutocomplete.children;
  for (let i = 0; i < children.length; i++) {
    children[i].classList.toggle("highlighted", i === state.autocompleteHighlighted);
  }
};

/**
 * Create a dropdown item div with matched characters wrapped in `<mark>` tags.
 * @param {string} fullPath - File path text.
 * @param {number[]} indices - Character indices that matched.
 * @returns {HTMLDivElement}
 */
const renderAutocompleteItem = (fullPath, indices) => {
  const div = document.createElement("div");
  div.className = "diff-autocomplete-item";
  div.dataset.path = fullPath;

  if (!indices || !indices.length) {
    div.textContent = fullPath;
    return div;
  }

  // Build HTML with <mark> tags around matched characters
  const set = new Set(indices);
  let html = "";
  for (let i = 0; i < fullPath.length; i++) {
    const ch = fullPath[i];
    if (ch === "<") html += "&lt;";
    else if (ch === ">") html += "&gt;";
    else if (ch === "&") html += "&amp;";
    else if (set.has(i)) {
      html += `<mark>${ch}</mark>`;
    } else {
      html += ch;
    }
  }

  div.innerHTML = html;
  return div;
};



init();
