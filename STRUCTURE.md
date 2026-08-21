# STRUCTURE.md — Architecture & File Guide

> Quick-reference for AI agents and new contributors. Explains how the project is built, what each file does, and how data flows through the system.

---

## Project Summary

**SuiteScript Navigator** is a Chrome Manifest V3 extension that indexes all SuiteScript (`.js`) files in a NetSuite account and provides fast, grep-like text search with context windows. It also includes a diff checker for comparing files between two accounts (e.g., Sandbox vs Production) — both the base and the comparison account can be picked from the cached-accounts list — and a popup-only **Accounts** page that lists every cached account with per-account Refresh / Set-as-diff-base / Clear actions.

- **Stack:** Vanilla JavaScript + CSS, no build tools, no NPM, no frameworks
- **Runtime:** Chrome Extension Manifest V3 (ES Modules)
- **Storage:** `chrome.storage.local` (per-account, per-script shards + metadata)
- **Auth:** Reuses NetSuite session cookies (`credentials: "include"`), stores no credentials

---

## File Tree

```
SuiteScriptNavigator/
├── manifest.json              # MV3 manifest: permissions, action, service worker
├── background.js              # Service worker: message router + build orchestrator
├── STRUCTURE.md               # This file
├── PLAN.md                    # Implementation plan + future enhancements roadmap
├── README.md                  # User-facing install + usage instructions
├── AUDIT.md                   # Audit trail of recent changes
│
├── popup/
│   ├── popup.html             # Extension popup markup (toolbar, results, diff section, accounts section)
│   ├── popup.css              # Light + dark themes via CSS variables, layout, result cards, diff view
│   ├── popup.js               # UI logic: events, messaging, rendering, diff UI, accounts-view wiring
│   ├── accounts.js            # Accounts page: fetch + render of the cached-accounts list (delegated row actions)
│   └── accounts.css           # Accounts page styling (cards, status/role badges, footer)
│
└── lib/
    ├── constants.js           # Endpoints, folder IDs, batch sizes, storage keys, message types, @typedefs
    ├── accountResolver.js     # Detect NetSuite account from active tab URL
    ├── netsuiteClient.js      # Inventory pagination + content download with retry/backoff
    ├── searchEngine.js        # In-memory line search + context window builder
    ├── storage.js             # chrome.storage.local wrapper (per-account meta/inventory/sources, settings, diff state)
    ├── highlight.js           # Lightweight JS tokenizer for syntax highlighting
    ├── diffEngine.js          # LCS-based line-level diff algorithm
    ├── fuzzyMatch.js          # Fuzzy string matching for file path autocomplete
    └── demoData.js            # Placeholder/demo data (not actively used in production)
```

---

## Architecture Overview

### Two-Process Model (Manifest V3)

```
┌─────────────────────────────┐
│  Popup (popup.html/.js)     │  ← UI layer, destroyed when popup closes
│  - Renders search results   │
│  - Renders diff + accounts  │
│  - Sends messages to worker │
└──────────────┬──────────────┘
               │ chrome.runtime.sendMessage
               │ (request/response pattern)
               ▼
┌─────────────────────────────┐
│  Service Worker             │  ← Long-running (until idle), can be terminated
│  (background.js)            │
│  - Message router           │
│  - Build orchestrator       │
│  - Search executor          │
│  - Diff comparator          │
└──────────────┬──────────────┘
               │
    ┌──────────┼──────────┐
    ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌────────┐
│Client │ │Search  │ │Storage │  ← lib/ modules (imported as ES modules)
│(NetSuite)│(Engine) │(Wrapper)│
└────────┘ └────────┘ └────────┘
```

### Key Design Decisions

1. **Service worker does heavy lifting** — popup DOM is ephemeral; long downloads must live in the worker
2. **Per-script storage shards** — each script source is stored under `ssnav.src.{label}:{internalId}` (per account) to avoid rewriting one giant blob
3. **Lines pre-split at store time** — sources are split into line arrays when downloaded, so search never re-splits
4. **Resumable builds** — inventory cursor and download progress are checkpointed; re-opening the extension resumes
5. **Delta refresh** — only scripts with changed `modified` timestamps are re-downloaded
6. **Message-based IPC** — popup sends `{type, ...}` messages, worker returns `{type, ...}` responses
7. **Per-account cache scoping** — all cached index data (meta, inventory, source shards) is keyed by the account `label` (the `baseHost` prefix, e.g. `1234567-sb1`); a cache pulled for an account from either page is immediately usable for that account's search AND diffing, and multiple accounts' caches coexist (see Per-Account Cache Scoping under Key Patterns)
8. **Dark mode via variable overrides** — one light/dark toggle, not a theme system: the light palette lives as CSS custom properties on `:root` (values exactly the original hardcoded colors), and a single `html[data-theme="dark"]` block overrides those same variables with dark navy-gray surfaces and a brighter blue accent. Two themes is all we need, so a variable override keeps light mode pixel-identical and makes dark mode one auditable block instead of a full theming framework

---

## Module Details

### `manifest.json`
- Declares MV3, permissions (`storage`, `unlimitedStorage`, `activeTab`)
- Background service worker: `background.js` (ES module)
- Action: `popup/popup.html`
- Host permissions: `*.app.netsuite.com`, `*.netsuite.com`

### `background.js` — Service Worker Entry Point
**Role:** Message router + orchestrator for all async work.

**Key exports/behavior:**
- `chrome.runtime.onMessage.addListener()` — routes incoming messages by `type`
- **Message handlers** (see Message Types table below):
  - `RESOLVE_ACCOUNT` → calls `resolveAccount()` from `accountResolver.js`
  - `BUILD_INDEX` → runs the unified build core `runIndexBuild()` for the current account (completion phase `"ready"`)
  - `SEARCH` → validates the cached index belongs to the active account (resolved from the tab origin), then loads that account's source shards, optionally filters minified, calls `search()` from `searchEngine.js`; returns `noIndex` + empty results when the account has no ready index
  - `COMPARE_FILES` / `COMPARE_FOLDER` → require the popup to send `origin` (identifies the current account); load the diff base account's shards and the current account's shards, call `diffLines()` from `diffEngine.js`
  - `BUILD_COMPARISON_INDEX` → runs the same `runIndexBuild()` core for the account named by the `origin` hint — may be **any** account (the Diff page can remote-pull the diff base account's index; the worker fetches that origin directly with `credentials: "include"`, so it works from any logged-in NetSuite tab). A valid explicit `origin` does not require a diff base to be set (the guard errors only when neither is present) — this is what the Accounts page's per-account Refresh uses for non-current accounts (completion phase `"comparison-ready"`)
  - `SET_DIFF_BASE_ACCOUNT` → set the diff base (label + origin); the base account's cached index is always preserved by this — it still serves that account's search page (the base is changed by picking a different account; the diff state is simply overwritten)
  - `GET_COMPARISON_FILES` → requires `origin`; returns the deduplicated union of the diff base account's and the current account's file lists for autocomplete
  - `GET_STATUS` → returns `meta` (current account's `IndexMeta` or null), `currentAccount` (label or null), `scriptCount`, `usage`, `resumable`, `purged` (whether the spawn-time purge cleared anything — status queries never trigger a purge), `diffState` (base label or null), `diffBaseOrigin` (base account's origin or null), `baseMeta` (base account's `IndexMeta` or null), `baseReady`, `baseScriptCount`, `buildMeta` (meta of the account a **running** build targets; null when idle), `buildAccount`, `building`, `buildKind`
  - `CLEAR_INDEX` → clears only the resolved account's cache (target via the message's `origin` hint, else the usual resolution)
  - `CLEAR_ALL_CACHE` → clears every account's cache (all per-account slots)
  - `GET_CACHED_ACCOUNTS` → lists every account with cached index data (`accounts` — each `meta` includes the build's `origin` —, `currentAccount`, `diffBase`, `diffBaseOrigin`, `usage`) for the Accounts page (`origin` hint on the request pins `currentAccount` in full tabs)
  - `CANCEL_BUILD` → sets `cancelRequested` flag (checked at build checkpoints)
- **Build lifecycle (unified core):** both `BUILD_INDEX` and `BUILD_COMPARISON_INDEX` run through one build core, `runIndexBuild()`, which scopes every read/write to the target account's per-account slot:
  1. Phase "inventory" — calls `inventoryAll()` with pagination
  2. Phase "content" — calls `downloadContent()` with batched fetches
  3. On success — calls `setMeta(label, ...)` with `status: "ready"` and `builtAt` timestamp; completion phase is `"ready"` for `BUILD_INDEX` and `"comparison-ready"` for `BUILD_COMPARISON_INDEX`
  4. On cancel — one shared cancellation finalizer writes a per-account `status: "cancelled"` meta to the target account's slot only
- **Broadcasts** progress via `chrome.runtime.sendMessage` (popup listens for `PROGRESS`, `INDEX_READY`)
- **Legacy migration:** at service-worker startup, `migrateLegacyCache()` runs as a `migrationPromise` (NOT top-level await — older Chrome builds reject TLA in service workers at registration and the worker would never start). Every `onMessage` handler and both purges gate on that promise, preserving the original migrate-before-anything-else ordering. It moves legacy flat keys (`ssnav.meta`, `ssnav.inventory`, `ssnav.src.{internalId}` without a colon, and all `ssnav.comparison.*` keys) into the per-account slot of the accountId recorded in each slot's meta (comparison slot falls back to the stored comparison account id), then deletes the legacy keys. A quick 5-key probe runs first; if no legacy keys exist it returns without a full storage scan. Runs on every worker start, but is a no-op after the first migration.
- **Auto-purge:** On worker spawn (fire-and-forget, chained onto the `migrationPromise` so it never interleaves with the migration on storage) and on `chrome.runtime.onStartup`, `purgeIfStale()` purges each expired per-account cache independently if its `builtAt` is older than `CACHE_TTL_MS` (4 hours) and `autoPurgeStale` is enabled. Status queries never trigger a purge — `GET_STATUS` only reports the spawn-time result via the `purged` flag (view switches used to delete stale caches; the spawn-time purge replaces that)
- **State variables:** `buildInProgress` (mutex), `cancelRequested` (flag checked at checkpoints), `purgeCleared` / `purgePromise` (spawn-time purge result and in-flight promise, awaited by `GET_STATUS` so `purged` is accurate)

### `popup/popup.js` — UI Logic
**Role:** Renders the popup UI, handles user interactions, sends messages to worker, renders results.

**Key responsibilities:**
- **Account detection** on load — sends `RESOLVE_ACCOUNT`, displays account chip
- **Build management** — "Build / Refresh" button triggers `BUILD_INDEX`, progress bar updates; the completion watchdog reads `buildMeta ?? meta` from `INDEX_READY` so builds targeting another account (e.g. a base-index pull from the Diff page) also complete the UI
- **Search** — debounced input sends `SEARCH`; chips (Tab to add) combine via AND/OR, and the typed term filters chip results live
- **Diff view** — toggle between search results and diff section, base/comparison account pickers (populated from `GET_CACHED_ACCOUNTS`; the base picker writes the worker's diff state via `SET_DIFF_BASE_ACCOUNT`, the comparison picker is popup-local and defaults to the active tab's account), file autocomplete, compare buttons
- **Diff banner** — from `GET_STATUS` fields (`meta`, `diffState`, `diffBaseOrigin`, `baseMeta`, `baseReady`) decides which banner to show and which build to start (the pull-base build uses the stored `diffBaseOrigin`, not a label-synthesized URL) — see the Diff Banner Decision table under Key Patterns
- **Diff rendering** — renders file headers with collapsible regions, line-level diff with +/- badges
- **Accounts view** — the Accounts toolbar button opens the cached-accounts page (popup-only; hidden in full tabs): fetches `GET_CACHED_ACCOUNTS`, renders via `popup/accounts.js`, and delegates per-row Refresh / Set as diff base / Clear; the footer shows total usage plus a Clear-all-accounts button. The one-shot "Cleared cache older than 4 hours" toast (from the spawn-time purge) is shown at init only
- **Tab mode** — "Open in tab" opens `popup.html` as a full-width browser tab, passes account ID via URL parameter
- **Settings** — folder checkboxes, skip minified, auto-purge
- **Theme** — `applyTheme()` reads `settings.theme` (`"light"` | `"dark"`, default `"light"`) and sets `document.documentElement.dataset.theme`; called early on load, before rendering, so the popup never opens in the wrong theme. The header's theme toggle button (`#theme-toggle-btn`, "☾" in light mode / "☀" in dark mode) flips the setting and re-applies immediately; a `chrome.storage.onChanged` listener keeps the popup and the full-tab view in sync when both are open
- **State management** — stores diff state, search query, filter, and UI visibility in local storage

### `popup/popup.html` — Markup
**Structure (top to bottom):**
1. Header — brand name, account indicator chip, and theme toggle button (`#theme-toggle-btn`, "☾" / "☀")
2. Toolbar — mode toggle, search input, case/regex/word toggles, Build/Refresh, Cancel, Accounts button, "..." menu
3. Subbar — index status line + "Open in tab" button + diff toggle
4. Result count bar
5. Diff banner (hidden until diff base is set) — one of: pull-current-index prompt, "pull base index" prompt, "build the comparison index for P?" prompt, or same-account notice; hidden when both sides have a ready index (see Diff Banner Decision under Key Patterns)
6. Progress bar (hidden until build starts)
7. Diff section (hidden by default) — base/comparison account pickers, file path input, autocomplete, compare button, output area
8. Accounts section (hidden by default; popup-only) — cached-accounts list, usage line, footer with Clear-all-accounts button
9. Results container — scrollable list of result cards
10. Empty state — "No results yet" placeholder

### `popup/popup.css` — Styling
- Palette defined as CSS custom properties on `:root` (`--accent`, `--highlight`, etc.) — every previously hardcoded color is routed through a named palette variable (code/menu backgrounds, danger/success text and soft backgrounds, diff add/delete line tints, code token colors, status dots, line-number gutter, notice background, result pills, text on accent highlights, hover tints, menu/dropdown shadows); light values are exactly the original hardcoded colors, so light mode is visually unchanged
- Dark mode — a single `html[data-theme="dark"]` override block redefines the same variables with dark navy-gray surfaces, a brighter blue accent, brightened token colors, and dark red/green diff tints
- Result card layout with file name, folder, line number, context window
- Diff view styling: file headers, collapsible regions, green/red line badges, hunk headers
- Progress bar with determinate/indeterminate states
- Responsive layout for tab mode (`body.tab-mode` class)

---

### `lib/constants.js` — Configuration & Types
**Role:** Single source of truth for all configuration and shared TypeScript-style `@typedef` documentation.

**Key exports:**
- **Endpoints:** `INVENTORY_PATH`, `MEDIA_PATH`
- **Script folders:** `SCRIPT_FOLDERS` (`["-15", "-16", "-19"]`), `SCRIPT_FOLDER_DEFS` (with labels)
- **Pagination/throttling:** `PAGE_SIZE` (1000), `BATCH_SIZE` (5), `BATCH_DELAY_MS` (200), `MAX_RETRIES` (4)
- **UI:** `RESULT_CAP` (200), `SEARCH_DEBOUNCE_MS` (200), `CONTEXT_RADIUS` (5), `COMPACT_CONTEXT_RADIUS` (3), `LONG_LINE_CHARS` (200), `MINIFIED_MAX_LINE` (5000)
- **Storage keys:** `STORAGE_KEYS` object (per-account key prefixes for meta / inventory / source, settings, diff state)
- **Message types:** `MSG` object (message types for popup ↔ worker communication; the active set is documented in the table below)
- **Cache TTL:** `CACHE_TTL_MS` (4 hours)
- **@typedefs:** `AccountInfo`, `InventoryEntry`, `SourceRecord`, `IndexMeta`, `ProgressState`, `SearchHit`, `Settings`, `DiffLine`, `DiffHunk`, `CompareResult`

### `lib/accountResolver.js` — Account Detection
**Role:** Detect which NetSuite account the user is on by inspecting browser tabs.

**Exports:**
- `parseAccountFromUrl(urlString)` → `{baseHost, accountId, origin}` or `null`
  - Parses subdomain `1234567.app.netsuite.com` → extracts numeric account ID
  - Handles sandbox suffixes (e.g., `1234567-sb1`)
- `recordLastAccount(origin)` → records the most-recently-used NetSuite origin in `chrome.storage.session` (`ssnav.lastAccount`); the worker calls it on every successful resolution
- `resolveAccount()` → `Promise<AccountInfo | null>`
  - Resolution order: active NetSuite tab → most-recently-used origin (`ssnav.lastAccount`) → first open NetSuite tab (last-resort scan). The middle step makes resolution deterministic inside the extension's own full tabs, where the active tab is the extension page and "first NetSuite tab" is arbitrary

### `lib/netsuiteClient.js` — NetSuite API Client
**Role:** Inventory pagination + content download with retry/backoff.

**Exports:**
- `buildSearchBody(cursor, folders)` → JSON-RPC payload for `nlapijsonhandler.nl`
  - Builds HashMap-style filters: folder anyof, filetype JAVASCRIPT, isavailable=T, internalidnumber>cursor
- `fetchInventoryPage(account, cursor, folders)` → POST request, returns parsed JSON
- `parseInventoryResponse(data)` → `InventoryEntry[]`
  - Handles multiple response shapes (cells, columns, values)
  - Extracts `internalId`, `name`, `folderPath`, `url`, `modified`
- `inventoryAll(account, opts)` → paginated inventory loop with cursor checkpointing
- `buildMediaUrl(account, entry)` → resolves the fetchable URL from inventory `url` column
- `fetchSource(account, entry)` → GET with exponential backoff on 429/5xx
- `toSourceRecord(entry, text)` → splits text into lines array
- `isMinifiedSource(text)`, `isMinifiedRecord(record)`, `looksLikeBundleName(name)` → minification detection
- `downloadContent(account, entries, opts)` → batched download with progress callbacks

### `lib/searchEngine.js` — In-Memory Search
**Role:** Search cached source records for a term, build context windows.

**Exports:**
- `search(sources, term, options)` → `{hits, truncated, scanned}`
  - Iterates all source records, all lines within each
  - Respects `caseSensitive` flag (lowercases both needle and haystack otherwise)
  - Builds ±`CONTEXT_RADIUS` context window per hit
  - Caps results at `cap` (default `RESULT_CAP` = 200)
  - Returns `SearchHit` objects with line numbers, match position, context array

### `lib/storage.js` — chrome.storage.local Wrapper
**Role:** All read/write operations for extension data. All index data is scoped per account by `label` (the account's `baseHost` prefix, e.g. `1234567-sb1`) — there are no more "primary"/"comparison" slots.

**Exports:**
- **Settings:** `getSettings()`, `setSettings(patch)` — the settings object also carries `theme` (`"light"` | `"dark"`, default `"light"` in `DEFAULT_SETTINGS`); since `getSettings()` merges stored values over `DEFAULT_SETTINGS`, settings saved before the theme field existed resolve to `"light"` with no migration
- **Per-account cache:** `getMeta(label)`, `setMeta(label, meta)`, `getInventory(label)`, `setInventory(label, inv)`, `putSource(label, record)`, `getSource(label, internalId)`, `getAllSources(label)`, `getSourceMetaMap(label)` — each reads/writes only that account's slot
- **Cache management:** `clearAccountCache(label)` (one account's slot), `clearAllCaches()` (every account's slot), `getCachedAccountIds()` → array of cached `label`s, `getCachedAccounts()` → `[{ accountId, meta, shardCount, bytes }]` for every account with cached data, sorted by `meta.updatedAt` desc (`bytes` = in-memory JSON size of that account's stored values). `setMeta()` stores the build's `origin` in the meta, so the Accounts page's per-row actions can target non-standard hosts without synthesizing a URL
- **Migration:** `migrateLegacyCache()` — one-shot legacy → per-account migration (see background.js); no-op after the first migration
- **Diff state:** `getDiffStateObj()` → `{ label, origin }` (legacy plain-string values normalize to `{ label, origin: null }`), `getDiffState()` → base label (thin wrapper over `getDiffStateObj`), `setDiffState(label, origin)` → stores `{ label, origin, setAt }`, `clearDiffState()`
- **Utility:** `getUsage()` (storage bytes/quota estimate)
- **Find:** `findSourceByPath(sources, folderPath, name)` → match by folder + name

### `lib/diffEngine.js` — Line-Level Diff Algorithm
**Role:** Compare two arrays of lines, produce unified diff hunks.

**Exports:**
- `diffLines(linesA, linesB)` → `DiffHunk[]`
  - Uses LCS (Longest Common Subsequence) via bottom-up DP with `Float64Array`
  - Backtracks to produce edit opcodes (equal, delete, insert)
  - Groups changes into hunks with ±`CONTEXT_RADIUS` context padding
  - Merges overlapping hunks
  - Returns empty array for identical inputs

### `lib/fuzzyMatch.js` — Fuzzy String Matching
**Role:** Fuzzy-match search queries against file paths for autocomplete.

**Exports:**
- `fuzzyMatch(query, text)` → `{score, indices}` or `null`
  - Prefers consecutive characters, start-of-word, and start-of-string matches
  - Scores 0-100 (100 = exact match)
  - Returns character indices for highlight rendering

### `lib/highlight.js` — JavaScript Tokenizer
**Role:** Lightweight per-line tokenizer for syntax highlighting (not yet active in search results, available for future use).

**Exports:**
- `tokenizeLine(line)` → `Array<{type, value}>` with types: comment, string, template, number, keyword, function, punct, ws, text

---

## Message Types (Popup ↔ Worker)

All communication uses `chrome.runtime.sendMessage({type, ...})` → response.

| Direction      | Message Type                  | Purpose                                                 |
|----------------|-------------------------------|---------------------------------------------------------|
| Popup → Worker | `RESOLVE_ACCOUNT`             | Detect current NetSuite account                         |
| Popup → Worker | `BUILD_INDEX`                 | Run `runIndexBuild()` for the current account (`mode: "rebuild"` for full) |
| Popup → Worker | `CANCEL_BUILD`                | Stop current build at next checkpoint                   |
| Popup → Worker | `SEARCH`                      | Search cached sources (`term`, `caseSensitive`)         |
| Popup → Worker | `GET_STATUS`                  | Get current account meta, script count, usage, diff base (+ origin), build info; reports the spawn-time purge via `purged` |
| Popup → Worker | `CLEAR_INDEX`                 | Clear the resolved account's cached data (`origin` hint optional) |
| Popup → Worker | `CLEAR_ALL_CACHE`             | Clear every account's cached data                       |
| Popup → Worker | `GET_CACHED_ACCOUNTS`         | List all cached accounts (meta, shard count, bytes) + current/diff-base context, for the Accounts page (`origin` hint optional) |
| Popup → Worker | `COMPARE_FILES`               | Diff specific file path: base account vs current account (requires `origin`) |
| Popup → Worker | `COMPARE_FOLDER`              | Diff all files in a folder path: base vs current (requires `origin`) |
| Popup → Worker | `BUILD_COMPARISON_INDEX`      | Run `runIndexBuild()` for the account named by the `origin` hint (any account — Diff page can remote-pull the base index; a valid `origin` works without a diff base set, which powers the Accounts page's per-account Refresh) |
| Popup → Worker | `SET_DIFF_BASE_ACCOUNT`       | Mark current account as diff base                       |
| Popup → Worker | `GET_COMPARISON_FILES`        | Get the union of base + current account file lists (identified by `origin`) for autocomplete |
| Worker → Popup | `ACCOUNT`                     | Resolved account info                                   |
| Worker → Popup | `BUILD_STARTED`               | Build acknowledged; it runs in the background and finishes via `INDEX_READY` / `CANCELLED` / `ERROR` |
| Worker → Popup | `PROGRESS`                    | Build progress (`phase`, `done`, `total`)               |
| Worker → Popup | `INDEX_READY`                 | Build complete with the target account's meta summary   |
| Worker → Popup | `RESULTS`                     | Search hits                                             |
| Worker → Popup | `STATUS`                      | Current account status + base/build info + usage        |
| Worker → Popup | `CLEARED`                     | Cache cleared confirmation                              |
| Worker → Popup | `CANCELLED`                   | Build cancelled confirmation                            |
| Worker → Popup | `COMPARE_RESULT`              | Diff result for single file                             |
| Worker → Popup | `COMPARE_FOLDER_RESULT`       | Diff results for folder                                 |
| Worker → Popup | `GET_COMPARISON_FILES_RESULT` | Union of base + current account file lists (for diff autocomplete) |
| Worker → Popup | `CACHED_ACCOUNTS`             | Cached-accounts list for the Accounts page (`accounts`, `currentAccount`, `diffBase`, `diffBaseOrigin`, `usage`) |
| Worker → Popup | `ERROR`                       | Error message                                           |

---

## Storage Keys (chrome.storage.local)

`label` = the account's `baseHost` prefix (e.g. `1234567-sb1`) — the same value used as `meta.accountId` and the diff state.

| Key Pattern                         | Content                                                             |
|-------------------------------------|---------------------------------------------------------------------|
| `ssnav.meta.{label}`                | `IndexMeta` — status, cursor, script count, timestamps for that account |
| `ssnav.inventory.{label}`           | `InventoryEntry[]` — full inventory array for that account          |
| `ssnav.src.{label}:{internalId}`    | `SourceRecord` — cached source per script; the colon after the label distinguishes per-account keys from legacy keys |
| `ssnav.settings`                    | `Settings` — folder selection, skip minified, auto-purge, theme (`"light"` | `"dark"`, default `"light"`) |
| `ssnav.diff.state`                  | `{ label, origin, setAt }` — diff base account label + origin (or null); legacy plain-string values still read |

All `ssnav.comparison.*` keys are gone from the live design. The legacy flat keys (`ssnav.meta`, `ssnav.inventory`, `ssnav.src.{internalId}` without a colon) are migrated into the per-account slot of their recorded accountId and deleted by `migrateLegacyCache()` at service-worker startup (see background.js).

`ssnav.lastAccount` (in `chrome.storage.session`, not local) holds the most-recently-used NetSuite origin for deterministic account resolution inside the extension's own full tabs (see `lib/accountResolver.js`).

---

## Data Flow: Index Build

```
User clicks "Build / Refresh"
  → popup.js sends BUILD_INDEX
  → background.js runIndexBuild() (target = current account):
    1. Resolve account (active tab)
    2. If rebuild mode: clearAccountCache(label)
    3. Phase "inventory": inventoryAll()
       - Paginated POST to nlapijsonhandler.nl
       - Checkpoint cursor + entries after each page
       - Emit PROGRESS messages
    4. Phase "content": downloadContent()
       - Batched GET with retry/backoff
       - Skip unchanged scripts (delta refresh via `modified`)
       - Skip minified if setting enabled
       - Store each source as putSource(label, record)
       - Emit PROGRESS messages
    5. setMeta(label, { status: "ready", builtAt: Date.now() })
    6. Broadcast INDEX_READY (completion phase "ready"; "comparison-ready"
       for BUILD_COMPARISON_INDEX)
  → popup.js renders "Index ready" summary

The Diff page's BUILD_COMPARISON_INDEX runs the same runIndexBuild() core
against the account named by its origin hint — its own account, or the diff
base account pulled remotely (the worker fetches that origin directly with
credentials: "include", so it works from any logged-in NetSuite tab).
```

## Data Flow: Search

```
User types in search box (debounced 200ms)
  → popup.js sends SEARCH { term, chips, chipMode, caseSensitive }
  → background.js:
    1. getAllSources(label) — current account's slot only
    2. Filter minified if setting enabled
    3. search(sources, term, chips, options)
    4. Return RESULTS { hits, truncated, scanned }
  → popup.js renders result cards
  → With chips active, the typed term ANDs with the chip group, filtering
    results live as the user types
```

## Data Flow: Diff Comparison

```
User sets "Set as diff base" in menu
  → popup.js sends SET_DIFF_BASE_ACCOUNT
  → background.js: setDiffState(currentLabel)

User opens diff view; the base/comparison pickers populate from
  GET_CACHED_ACCOUNTS (plus the active tab's account); the comparison
  picker defaults to the active tab's account
  → Picking a base account: SET_DIFF_BASE_ACCOUNT { origin: <stored meta
    origin, or synthesized https://label.app.netsuite.com> }
User decides the banner from GET_STATUS
  (see Diff Banner Decision under Key Patterns)
  → For the active tab's account: popup.js sends BUILD_COMPARISON_INDEX
    { origin: currentAccountOrigin }
  → For the diff base account: popup.js sends BUILD_COMPARISON_INDEX
    { origin: <the base account's stored origin, from the diff state> }
    (remote pull — the worker fetches that origin directly with
    credentials: "include"; the origin is read from the stored diff state,
    not synthesized from the label)
  → For a picked (non-active) comparison account: BUILD_COMPARISON_INDEX
    { origin: <that account's stored meta origin from GET_CACHED_ACCOUNTS> }
  → background.js: runIndexBuild() stores inventory + sources in the target
    account's per-account slot (ssnav.meta.{label} / ssnav.inventory.{label} /
    ssnav.src.{label}:{internalId})

User types file path in diff input
  → Autocomplete from combined file list (both accounts)
  → popup.js sends COMPARE_FILES { filePath, origin }
  → background.js:
    1. Find source by path in the diff base account's slot and the current
       account's slot
    2. diffLines(base.lines, comp.lines)
    3. Return COMPARE_RESULT { filePath, hunks, onlyInBase, onlyInComparison }
  → popup.js renders diff with collapsible file headers

User types folder path (e.g., "ACS/")
  → popup.js sends COMPARE_FOLDER { folderPath, origin }
  → background.js: diffs all files in that folder (base slot vs current slot)
  → Returns COMPARE_FOLDER_RESULT { results[] }
```

---

## State Management

### Build State
- `buildInProgress` (boolean in background.js) — mutex to prevent concurrent builds
- `cancelRequested` (boolean in background.js) — checked at build checkpoints
- Per-account `meta.status` — `"ready"`, `"inventory"`, `"content"`, `"cancelled"` (a cancelled build writes `"cancelled"` to its target account's slot only)

### UI State (popup.js)
- `currentAccount` — detected account label
- `diffBaseAccount` / `diffBaseOrigin` — diff base label + origin for diff operations
- `diffCompLabel` — comparison account label picked in the diff pickers (popup-local, not persisted; `null` = the active tab's account)
- `mode` — `"search"` | `"diff"` | `"accounts"` (accounts is popup-only)
- `accountsData` — last `CACHED_ACCOUNTS` response (Accounts page)
- `diffVisible` — boolean, toggles diff section visibility
- `hits` — cached search results
- `diffCollapsedFiles` — Set of collapsed file paths in diff view

### Persistence
- Settings persist via `ssnav.settings` (folder checkboxes, skip minified, auto-purge, theme)
- Diff state persists via `ssnav.diff.state` (`{ label, origin, setAt }`)
- Per-account index caches persist via `ssnav.meta.{label}`, `ssnav.inventory.{label}`, and `ssnav.src.{label}:{internalId}`
- Query and the last-used NetSuite origin (`ssnav.lastAccount`) are remembered via `chrome.storage.session`

---

## Key Patterns

### Minification Detection
Three-layer check (pre-fetch, post-fetch, retroactive):
1. `looksLikeBundleName()` — name matches `.min.js` or content-hash pattern
2. `isMinifiedSource()` — any line ≥ 5000 characters
3. `isMinifiedRecord()` — retroactive check on cached records (for setting toggle)

### Error Handling
- Non-fatal errors (429, 5xx) → exponential backoff + jitter, max 4 retries
- Fatal errors (4xx except 429, no URL) → skip file, record in `failures` array
- Build never hard-stops on one file failure

### Tab Mode
"Open in tab" opens `popup.html` as a full browser tab. Account ID is passed via `?account=XXXXX` URL parameter. CSS class `body.tab-mode` adjusts layout for full-viewport rendering. Full tabs are single-purpose: the Accounts page (popup-only) is hidden in them.

### Auto-Purge
On worker spawn (in `background.js`, chained onto the `migrationPromise`) and on browser startup (`chrome.runtime.onStartup`): if `autoPurgeStale` is enabled, `purgeIfStale()` clears each expired per-account cache independently when its own `builtAt` is older than 4 hours (`CACHE_TTL_MS`). Status queries never trigger a purge — view switches used to, which deleted stale caches while the user was still looking at them; instead `GET_STATUS` reports the spawn-time result via `purged`, and the popup toasts once at init. Does NOT auto-rebuild — user clicks Build/Refresh manually.

### Last-Used Account Resolution
`resolveAccount()` order: active NetSuite tab → most-recently-used origin (`ssnav.lastAccount` in `chrome.storage.session`) → first open NetSuite tab (last resort). The worker records the origin via `recordLastAccount()` on every successful resolution, so the extension's own full tabs (where the active tab is the extension page) deterministically resolve to the account the popup last used instead of an arbitrary open NetSuite tab.

### Per-Account Cache Scoping
All cached index data is scoped per account by `label` (the account's `baseHost` prefix, e.g. `1234567-sb1` — the same value used as `meta.accountId` and the diff state):
- A cache pulled for an account (from the search page or the Diff page) is immediately usable for that account's search AND for diffing
- Multiple accounts' caches coexist; building one account never touches another's slot
- The old "primary" slot is no longer special: the diff base account's cache is simply that account's own per-account cache (compare = base account's slot vs current account's slot)
- "Clear cache" (`CLEAR_INDEX`) clears only the resolved account's slot; the explicit all-accounts action is `CLEAR_ALL_CACHE` (the ⋯ menu's "Clear all accounts" and the Accounts page footer button, each with its own confirm)
- One-shot legacy migration at worker startup (`migrateLegacyCache()`) moves the old flat keys (`ssnav.meta`, `ssnav.inventory`, `ssnav.src.{internalId}` without a colon) and all `ssnav.comparison.*` keys into the per-account slot of the accountId recorded in each slot's meta (comparison slot falls back to the stored comparison account id), then deletes them; a quick 5-key probe makes it a no-op after the first migration

### Diff Banner Decision
Diff page banner, for diff base B and comparison side P — the account picked in the comparison picker, or the active tab's account when nothing is picked (decided from `GET_STATUS`: `meta`, `diffState`, `baseMeta`, `baseReady`, plus `GET_CACHED_ACCOUNTS` readiness for non-active P):

| Base B | Comparison P     | Banner |
|--------|------------------|--------|
| B = P  | no index         | "Diff base (B) has no cached index" pull banner — builds P (the active tab's account when P is it, otherwise a remote pull of B) |
| B = P  | ready            | Same-account notice (base = comparison → pick a different comparison account or navigate) |
| B ≠ P  | base not ready   | "Diff base (B) has no cached index. Pull the base index now…" — "Pull base index" button (remote pull of B) |
| B ≠ P  | base ready, P not ready | "Build the comparison index for P?" banner — builds P (remotely when P is not the active tab) |
| B ≠ P  | both ready       | Hidden |

The build-completion watchdog reads `buildMeta ?? meta` from `INDEX_READY`, so builds targeting another account also complete the UI.

---

## Code Conventions

- **Vanilla JS only** — no frameworks, no transpilers, no bundlers
- **ES Modules** — `import`/`export` syntax (manifest declares `"type": "module"`)
- **JSDoc @typedefs** — shared type definitions in `constants.js`
- **No `innerHTML` for source code** — all DOM construction uses `textContent` and `document.createElement`
- **CSS custom properties** — all theming via CSS variables in `:root`; dark mode is a single `html[data-theme="dark"]` block overriding the same variables
- **Message-based IPC** — popup and worker communicate only via structured messages
