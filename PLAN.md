# SuiteScript Navigator — Implementation Plan

> A Manifest V3 Chrome Extension that performs fast, "grep-like" text searches across
> **all** SuiteScript files in a NetSuite account, without navigating the NetSuite UI.
> Built with **Vanilla JavaScript + Vanilla CSS only** — no frameworks, no build tools, no NPM.

---

## 1. Product Overview

### 1.1 Goal
Give developers an instant, in-browser way to answer *"Which script contains this text, and where?"*
The extension reuses the logged-in user's existing NetSuite session, downloads every available
SuiteScript file once, caches the raw source locally, and then searches the cache in-memory for
sub-second results.

### 1.2 Core User Story
1. User is logged into their NetSuite account in the active tab.
2. User clicks the extension icon and sees a clean white UI with modest pastel accents.
3. User clicks **Build / Refresh Index** (first run) → the extension inventories and downloads all scripts.
4. User types a search term.
5. Results render as a scrollable list. Each result card shows:
   - **Script File Name**
   - **Folder Path** to the file
   - **Line Number** of the occurrence
   - **Context Window**: the 5 lines above and 5 lines below the matching line.

### 1.3 Non-Goals (v1)
- No editing / saving scripts back to NetSuite (read-only).
- No regex UI toggle in v1 (plain substring + case toggle). Regex is a documented v2 stretch goal.
- No cross-account search (one account per active tab/session).

---

## 2. Technical Constraints

| Constraint  | Decision                                                                      |
|-------------|-------------------------------------------------------------------------------|
| Manifest    | **Manifest V3** (`service_worker` background, no persistent background page). |
| Language    | Vanilla JS (ES Modules where the runtime allows).                             |
| Styling     | Vanilla CSS, single `popup.css`, CSS custom properties for the pastel theme.  |
| Build tools | **None.** Files are loaded directly. No transpiler, no bundler, no NPM.       |
| Auth        | Reuse the user's NetSuite cookie session via `credentials: "include"`.        |
| Storage     | `chrome.storage.local` for the script index + cached source.                  |

---

## 3. Architecture

### 3.1 High-Level Component Diagram

```
┌───────────────────────────────────────────────────────────┐
│                        Popup (UI)                          │
│  popup.html · popup.css · popup.js                         │
│  - Search box, buttons, results list, progress bar         │
│  - Sends messages to the service worker                    │
│  - Renders results + context windows                       │
└───────────────▲───────────────────────────┬───────────────┘
                │ chrome.runtime.sendMessage │ (search/index)
                │                            ▼
┌───────────────┴───────────────────────────────────────────┐
│                 Service Worker (background.js)             │
│  - Resolves active NetSuite account domain (accountId)     │
│  - Orchestrates the 2-step retrieval pipeline              │
│  - Writes index + source to chrome.storage.local           │
│  - Runs the search over the cache, returns hits            │
└───────────────┬───────────────────────────┬───────────────┘
                │                            │
                ▼                            ▼
┌───────────────────────────┐   ┌───────────────────────────┐
│   netsuiteClient.js       │   │      searchEngine.js       │
│  - inventory (jsonhandler)│   │  - line-based matcher      │
│  - pagination loop        │   │  - context window builder  │
│  - media.nl content fetch │   │  - returns structured hits │
└───────────────────────────┘   └───────────────────────────┘
                │
                ▼
┌───────────────────────────┐
│      storage.js           │
│  - get/set index          │
│  - get/set source chunks  │
│  - metadata (timestamps)  │
└───────────────────────────┘
```

### 3.2 Why a Service Worker Does the Heavy Lifting
- The popup DOM is destroyed every time the popup closes; long-running downloads must **not**
  live there. The service worker survives popup close (subject to MV3 idle limits) and can be
  re-woken by messages.
- Fetches to NetSuite are same-origin *from the browser's cookie perspective* only if the
  request carries the session cookie. In MV3 the service worker `fetch` with
  `credentials: "include"` + host permissions attaches the NetSuite cookies automatically.

### 3.3 MV3 Service Worker Lifecycle Caveats (must handle)
- The worker can be terminated after ~30s idle. Long index builds must be **resumable**:
  persist pagination progress (`lastInternalId`) and the download queue to
  `chrome.storage.local` after each page/batch so a restart can continue.
- Use `chrome.alarms` (optional) to keep long jobs progressing in chunks rather than one
  unbroken loop.

---

## 4. File Tree

```
SuiteScriptNavigator/
├── manifest.json            # MV3 manifest: permissions, action, background worker
├── PLAN.md                  # This document
├── README.md                # Install + usage instructions (unpacked extension)
│
├── background.js            # Service worker entry: message router + job orchestrator
│
├── popup/
│   ├── popup.html           # Extension popup markup
│   ├── popup.css            # White + pastel theme, layout, result cards
│   └── popup.js             # UI logic: events, messaging, rendering
│
├── lib/
│   ├── netsuiteClient.js    # Inventory + pagination + media.nl content fetch
│   ├── searchEngine.js      # In-memory line search + context window builder
│   ├── storage.js           # chrome.storage.local wrapper (index/source/meta)
│   ├── accountResolver.js   # Detect account domain + accountId (c=) from active tab
│   └── constants.js         # Endpoints, folder IDs, batch sizes, storage keys
│
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 5. `manifest.json` — Permissions & Configuration

### 5.1 Required Permissions

| Permission            | Purpose                                                                    |
|-----------------------|----------------------------------------------------------------------------|
| `storage`             | Persist the script index and cached source in `chrome.storage.local`.      |
| `unlimitedStorage`    | Raise the ~10 MB `chrome.storage.local` cap so cached script source fits.  |
| `activeTab`           | Read the current tab URL to derive the NetSuite account domain.            |

### 5.2 Host Permissions
NetSuite account domains are per-account subdomains plus the shared app/system domains.
Use broad NetSuite wildcards so any account works:

```
"host_permissions": [
  "https://*.app.netsuite.com/*",
  "https://*.netsuite.com/*"
]
```

> **Why wildcard subdomains?** The account number is part of the host
> (e.g. `1234567.app.netsuite.com`). A wildcard avoids hard-coding a single account and lets
> the same extension work across sandbox (`*-sb1`) and production domains.

### 5.3 Manifest Skeleton (structure only)

```jsonc
{
  "manifest_version": 3,
  "name": "SuiteScript Navigator",
  "version": "1.0.0",
  "action": { "default_popup": "popup/popup.html", "default_icon": { /* 16/48/128 */ } },
  "background": { "service_worker": "background.js", "type": "module" },
  "permissions": ["storage", "unlimitedStorage", "activeTab"],
  "host_permissions": ["https://*.app.netsuite.com/*", "https://*.netsuite.com/*"],
  "icons": { "16": "...", "48": "...", "128": "..." }
}
```

> Note: `"type": "module"` lets `background.js` `import` the `lib/*.js` helpers.

---

## 6. The Two-Step Retrieval Pipeline

This is the heart of the extension. **Step 1 builds an inventory**; **Step 2 downloads content**.

### 6.1 Account & Session Resolution (prerequisite)
Before any request, `accountResolver.js`:
1. Reads the active tab URL via `chrome.tabs.query`.
2. Extracts:
   - `baseHost` → e.g. `1234567.app.netsuite.com`
   - `accountId` → the numeric account (also the `c=` query param used by `media.nl`).
3. Validates the tab is actually on a NetSuite domain; otherwise the UI shows a
   "Please open a NetSuite tab first" state.

All fetches use `credentials: "include"` so the browser attaches the existing NetSuite
session cookie — **no login handling, no tokens stored by the extension.**

### 6.2 Step 1 — Inventory via `nlapijsonhandler.nl`
- **Endpoint:** `https://{baseHost}/app/common/scripting/nlapijsonhandler.nl?jrr=T`
- **Method:** `POST`, `content-type: text/xml; charset=UTF-8`, `credentials: "include"`.
- **Payload:** the confirmed `remoteObject.searchRecord` body targeting `file` records, filtered by:
  - `folder anyof [-15, -16, -19]` — the SuiteScripts / SuiteBundles / SuiteApps
    file cabinet script folders.
  - `filetype anyof JAVASCRIPT`
  - `isavailable is T`
  - `internalidnumber greaterthan {cursor}` — **the pagination cursor.**
- **Returned columns:** `internalid`, `name`, `folder`, `url`, `modified`.

Each returned row becomes an **inventory entry**:

```jsonc
{
  "internalId": "1234567",
  "name": "customscript_foo.js",
  "folderPath": "SuiteScripts/Foo",   // resolved from folder column/label
  "url": "/core/media/media.nl?id=1234567&c=...&h=...&_xt=.js", // when present
  "modified": "8/1/2026 10:12 am"
}
```

> The `url` column is important: NetSuite returns a **pre-signed media URL** (including the
> `h=` hash + `c=` account). When present, prefer it verbatim for Step 2 — it already contains
> the security hash. Fall back to constructing `media.nl?id=` only if `url` is missing.

### 6.3 Pagination Logic (`internalidnumber greaterthan`)
NetSuite returns results in pages. The traffic confirms cursor-based paging by
**internal id**, sorted ascending:

```
cursor = 0
loop:
    body = buildSearchBody(cursor)          // internalidnumber greaterthan = cursor
    page = POST nlapijsonhandler.nl(body)
    rows = parse(page)
    if rows is empty: break
    append rows to inventory
    cursor = max(internalId in rows)         // greatest id becomes next "greater than"
    persist { inventory, cursor } to storage // resumable checkpoint
    if rows.length < PAGE_SIZE: break        // last partial page
```

Key points:
- **Sort ascending by `internalid`** (already in the payload: `"sortdir": "ASC"`) so the
  "max id this page" is a valid next cursor.
- Checkpoint `cursor` + partial inventory after **every** page so an interrupted worker resumes.
- Guard against infinite loops: if the new cursor ≤ old cursor, break and log a warning.

### 6.4 Step 2 — Content via `media.nl`
For each inventory entry (throttled — see §7):
- **Endpoint:** the pre-signed `url` from Step 1, or
  `https://{baseHost}/core/media/media.nl?id={internalId}&c={accountId}&_xt=.js`.
- **Method:** `GET`, `accept: */*`, `credentials: "include"`.
- **Response:** raw source text (`response.text()`).

Store the source keyed by `internalId`. Pre-split into lines once at store-time so search and
context extraction never re-split the whole corpus:

```jsonc
// stored per script
{
  "internalId": "1234567",
  "name": "customscript_foo.js",
  "folderPath": "SuiteScripts/Foo",
  "modified": "8/1/2026 10:12 am",
  "lineCount": 412,
  "lines": ["/* line 0 */", "define([...", "..."]   // string[]
}
```

### 6.5 Full Pipeline Sequence

```
[Build/Refresh Index click]
   → accountResolver.resolve()
   → netsuiteClient.inventoryAll()      // Step 1 + pagination (checkpointed)
   → netsuiteClient.downloadContent()   // Step 2 (throttled batches)
        for each entry:
           fetch source → split lines → storage.putSource()
           update progress → postMessage to popup
   → storage.setMeta({ builtAt, accountId, scriptCount })
   → notify popup: "Index ready"
```

---

## 7. Performance, Scale & Rate-Limiting Strategy

NetSuite will throttle aggressive traffic, and thousands of scripts can lag the browser.
Mitigations:

### 7.1 Throttled, Batched Downloads
- Download content in **batches** (e.g. `BATCH_SIZE = 5` concurrent requests).
- Insert a small **inter-batch delay** (e.g. 150–300 ms) to stay friendly to NetSuite.
- On HTTP 429 / 5xx, apply **exponential backoff with jitter** and retry (max N attempts);
  after max attempts, mark the entry `failed` and continue — the index build never hard-stops
  on a single file.

### 7.2 Incremental / Delta Refresh
- Store `modified` per script. On **Refresh**, re-run Step 1 inventory, then only re-download
  content whose `modified` changed (or that is missing/failed). This makes subsequent refreshes
  cheap.

### 7.3 Caching Model (`chrome.storage.local`)
- **Index metadata** (`ssnav.meta`): `{ accountId, builtAt, cursor, scriptCount, status }`.
- **Inventory** (`ssnav.inventory`): array of lightweight entries (no source).
- **Source shards** (`ssnav.src.{internalId}`): one key per script to avoid rewriting one giant
  blob on every update and to stay under per-write limits.
  - Rationale: `chrome.storage.local` has generous total quota but writing a single multi-MB
    value repeatedly is slow. Per-script keys keep writes small and enable partial refresh.
- **Search is done in-memory**: on search, the worker loads source shards (or keeps a warm
  in-memory map while the worker is alive) and scans line arrays.

### 7.4 Storage Size Awareness
- Estimate corpus size (# scripts × avg KB). If it approaches quota, the plan supports:
  - Optional `unlimitedStorage` permission (documented as a v2 toggle), **or**
  - Storing only files matching an include-glob (e.g. `SuiteScripts/**`).

### 7.5 Search Performance
- Searching line arrays already in memory is O(total lines) — fast for typical accounts.
- Debounce the search input (~200 ms) so keystrokes don't spawn redundant scans.
- Cap rendered results (e.g. first 200 hits) with a "show more" affordance to protect the DOM.

---

## 8. Search Engine & Context Window

### 8.1 Matching (`searchEngine.js`)
Input: `term`, `options { caseSensitive }`, and the in-memory source map.

For each script, for each line index `i`:
- Test `line` contains `term` (respecting case option).
- On match, build a hit object with a **context window**.

### 8.2 Context Window Construction (5 above / 5 below)
```
start = max(0, i - 5)
end   = min(lineCount - 1, i + 5)
context = lines[start .. end]   // inclusive slice
```
Each hit:
```jsonc
{
  "internalId": "1234567",
  "name": "customscript_foo.js",
  "folderPath": "SuiteScripts/Foo",
  "lineNumber": 88,               // 1-based for display (i + 1)
  "matchIndexInContext": 5,       // which context row is the actual match (for highlight)
  "context": [
    { "n": 83, "text": "..." },
    { "n": 84, "text": "..." },
    { "n": 85, "text": "..." },
    { "n": 86, "text": "..." },
    { "n": 87, "text": "..." },
    { "n": 88, "text": "... MATCH ..." },
    { "n": 89, "text": "..." },
    { "n": 90, "text": "..." },
    { "n": 91, "text": "..." },
    { "n": 92, "text": "..." },
    { "n": 93, "text": "..." }
  ]
}
```
Edge cases handled: match near start/end of file yields a shorter (clamped) window; multiple
matches on the same line produce one hit for that line (still highlights all occurrences).

---

## 9. UI Implementation (Vanilla JS + CSS)

### 9.1 Layout (`popup.html`)
- **Header bar:** title + account indicator (e.g. `Account 1234567`) + status dot.
- **Toolbar:** search input, case-sensitive toggle, **Build/Refresh Index** button.
- **Progress area:** thin progress bar + `"Downloaded 240 / 1,032 scripts"` text (during build).
- **Results container:** scrollable list of **result cards**.
- **Empty / error states:** "Open a NetSuite tab", "No index yet — build one", "No matches".

### 9.2 The White + Pastel Aesthetic (`popup.css`)
Use CSS custom properties so the theme is centralized and easy to tweak:

```css
:root {
  --bg:            #ffffff;
  --surface:       #fbfcfe;   /* card background */
  --border:        #eef1f6;
  --text:          #2b2f36;
  --muted:         #7a828e;
  --accent:        #a9c8ff;   /* pastel blue */
  --accent-soft:   #eaf2ff;   /* pastel blue tint */
  --accent-2:      #cdeede;   /* pastel mint */
  --highlight:     #fff3b0;   /* pastel yellow for matched text */
  --radius:        10px;
  --shadow:        0 1px 3px rgba(30, 40, 60, .06);
}
```
Aesthetic guidelines:
- Predominantly white/near-white backgrounds; pastel used only for accents (buttons, active
  toggle, focus ring, match highlight).
- Soft, small `border-radius`, subtle `box-shadow`, generous white space.
- System font stack for a clean, native feel; monospace font **only** inside context code blocks.

### 9.3 Result Card Structure (rendered per hit)
```
┌─────────────────────────────────────────────────────────┐
│ customscript_foo.js                       line 88        │  ← name (left) · line badge (right)
│ SuiteScripts/Foo                                         │  ← folder path (muted)
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 83 │ ...                                             │ │  ← context (monospace)
│ │ 84 │ ...                                             │ │
│ │ ...                                                  │ │
│ │ 88 │ ...  [MATCH highlighted]                        │ │  ← highlighted row
│ │ ...                                                  │ │
│ │ 93 │ ...                                             │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 9.4 Dynamic Rendering with Vanilla JS (`popup.js`)
- Build cards with `document.createElement` + `textContent` (never `innerHTML` for source code —
  prevents accidental HTML/script injection from file contents).
- For the matched line, split the text around the term and wrap the matched substring(s) in a
  `<mark>` styled with `--highlight`. Use `textContent` for the non-matched segments.
- Render the context lines as rows: a `.ln` line-number cell + a `.code` cell.
- Add the `.is-match` class to the matched row for the accent background.
- **Rendering performance:** append cards via a `DocumentFragment`; cap initial render and
  lazy-append on scroll ("show more") to keep the popup snappy.

### 9.5 Messaging Contract (popup ⇄ worker)
```jsonc
// popup → worker
{ "type": "RESOLVE_ACCOUNT" }
{ "type": "BUILD_INDEX", "mode": "full" | "delta" }
{ "type": "SEARCH", "term": "...", "caseSensitive": false }
{ "type": "GET_STATUS" }

// worker → popup (responses / progress via chrome.runtime messages or ports)
{ "type": "ACCOUNT", "accountId": "1234567", "baseHost": "..." }
{ "type": "PROGRESS", "phase": "inventory"|"content", "done": 240, "total": 1032 }
{ "type": "INDEX_READY", "scriptCount": 1032, "builtAt": 1234567890 }
{ "type": "RESULTS", "hits": [ /* §8 hit objects */ ], "truncated": false }
{ "type": "ERROR", "message": "..." }
```
> Use a **long-lived `chrome.runtime.connect` port** for the index build so progress can stream
> to the popup while it's open, and fall back gracefully if the popup closes mid-build.

---

## 10. Actionable Roadmap (Phased)

### Phase 0 — Scaffold (0.5 day)
- Create the file tree (§4), `manifest.json`, placeholder icons.
- Load unpacked in `chrome://extensions`; confirm popup opens and worker registers.

### Phase 1 — Account Resolution (0.5 day)
- Implement `accountResolver.js`: parse active tab → `baseHost`, `accountId`.
- Popup shows the resolved account or the "open a NetSuite tab" empty state.

### Phase 2 — Inventory + Pagination (1–2 days)
- Implement `netsuiteClient.inventoryAll()` (Step 1 body + cursor loop, §6.2–6.3).
- Parse `nlapijsonhandler.nl` response into inventory entries.
- Persist checkpoints to `chrome.storage.local`; verify full-account inventory completes.

### Phase 3 — Content Download + Cache (1–2 days)
- Implement `downloadContent()` with batching, delay, backoff (§7.1).
- Split lines at store-time; write per-script source shards (§7.3).
- Stream progress to the popup progress bar.

### Phase 4 — Search + Context (1 day)
- Implement `searchEngine.js` matcher + context window builder (§8).
- Wire `SEARCH` message → results back to popup.

### Phase 5 — UI & Theme (1–2 days)
- Build `popup.html` / `popup.css` (white + pastel, §9.2).
- Render result cards + highlighted match + context rows via Vanilla JS (§9.4).
- Empty/error/loading states, debounced search, result cap + "show more".

### Phase 6 — Hardening (1 day)
- Delta refresh via `modified` (§7.2).
- Resumable builds after worker restart; 429/backoff testing.
- Storage-quota estimation + guardrails (§7.4).

### Phase 7 — Polish & Docs (0.5 day)
- `README.md`: install unpacked, usage, limitations.
- Final QA against a real account (small + large).

---

## 11. Constants & Config (`lib/constants.js`)

| Key | Example | Meaning |
| --- | --- | --- |
| `INVENTORY_PATH` | `/app/common/scripting/nlapijsonhandler.nl?jrr=T` | Step 1 endpoint. |
| `MEDIA_PATH` | `/core/media/media.nl` | Step 2 endpoint. |
| `SCRIPT_FOLDERS` | `[-15, -16, -19]` | File cabinet script folder ids (SuiteScripts, SuiteBundles, SuiteApps). |
| `FILE_TYPE` | `JAVASCRIPT` | Inventory filter. |
| `PAGE_SIZE` | `1000` | Expected max rows per inventory page (for last-page detection). |
| `BATCH_SIZE` | `5` | Concurrent content downloads. |
| `BATCH_DELAY_MS` | `200` | Delay between batches. |
| `MAX_RETRIES` | `4` | Backoff attempts per file. |
| `RESULT_CAP` | `200` | Max hits rendered before "show more". |
| `STORAGE_KEYS` | `ssnav.meta / ssnav.inventory / ssnav.src.<id>` | Cache keys. |

---

## 12. Risks & Open Questions

| Risk | Mitigation |
| --- | --- |
| Undocumented `nlapijsonhandler.nl` payload may change between NetSuite releases. | Isolate the request body in `netsuiteClient.js`; treat it as a single point to update. |
| `media.nl` security hash (`h=`) expiry. | Prefer the fresh `url` returned by Step 1; if a fetch 403s, re-run inventory for that id. |
| MV3 worker termination during long builds. | Checkpoint after every page/batch; resumable queue (§3.3, §6.3). |
| Storage quota on huge accounts. | Per-script shards, delta refresh, optional `unlimitedStorage`/include-glob (§7.4). |
| Non-JS SuiteScript assets (e.g. `.mjs`, libraries). | v1 scopes to `filetype JAVASCRIPT`; broaden filter in v2 if needed. |
| Injecting file text into DOM. | Always use `textContent`/`<mark>` wrapping — never `innerHTML` for source (§9.4). |

---

## 13. Stretch Goals (v2+)
- Regex search toggle (with safe, timeout-guarded evaluation).
- Click a result to open the file in NetSuite (`/app/common/media/mediaitem.nl?id=`).
- Filter by folder / script type facets.
- Export results (copy as Markdown / JSON).
- Multi-account cache with an account switcher.

## 14. Future Enhancements

> Ideas for post-v1 releases. Items marked `[v2]` are likely candidates for the next release;
> `[v3+]` are longer-term.
>
> **Completion summary:** Completed items are marked with ~~strikethrough~~ and **✅ Done**.
> See `STRUCTURE.md` for architecture details of implemented features.

### 14.1 Search Enhancements

| Feature                               | Priority | Notes                                                                                                                                                                                                  |
|---------------------------------------|----------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Regex search toggle**               | v2       | Safe, timeout-guarded `RegExp` with an option to disable if the account has very large scripts.                                                                                                        |
| **Boolean operators**                 | v2       | `AND`, `OR`, `NOT` (e.g. `customer AND createRecord -"throw"`) for multi-token queries.                                                                                                                |
| **Whole-word / word-boundary**        | v2       | Toggle that wraps the term in `\b` before regex matching.                                                                                                                                              |
| **Multi-line search**                 | v3+      | Match patterns spanning more than one line (e.g. function signatures split across lines).                                                                                                              |
| ~~**Search result sorting**~~         | ~~v2~~   | **✅ Done** — Group by folder / script type dropdown replaces "line" relevance option.                                                                                                                 |
| **Multi-term chip search**            | v2       | Type a phrase and press Tab to add it as a removable chip. Add multiple chips to search for several terms simultaneously. Chips display in the search bar with a close button to remove.               |
| **AND / OR chip toggle**              | v2       | Button next to the case-sensitive toggle that switches chips between OR mode (any chip matches — default) and AND mode (all chips must match).                                                         |
| **Compacted preview for multi-match** | v2       | When a script matches multiple search terms, compact the preview to show only the relevant matched lines with gaps between different match areas, rather than showing a full context window per match. |
| ~~**Search / Diff toggle button**~~   | ~~v2~~   | **✅ Done** — Single toggle button replaces overlapping tabs; persists diff mode across popup reopen.                                                                                                  |

### 14.2 Navigation & Productivity

| Feature | Priority | Notes |
|---------|----------|-------|
| ~~**Click-to-open in NetSuite**~~ | ~~v2~~ | **✅ Done** — File name link opens in a background tab, popup stays open. |
| **Keyboard shortcuts** | v2 | `Ctrl+K` to focus search, `Enter` to open the highlighted result, `Esc` to clear. |
| **Copy matched line + context** | v2 | Button or right-click option on a result card to copy the context window to clipboard. |
| **Bookmarks / favorites** | v3+ | Star frequently accessed scripts; show them in a quick-access list. |
| **Recent searches** | v2 | Dropdown of last N searches (stored in `chrome.storage.session`) for quick re-run. |
| **Search history persistence** | v3+ | Persist search history across browser sessions in `chrome.storage.local`. |

### 14.3 Indexing & Scope

| Feature | Priority | Notes |
|---------|----------|-------|
| **Support additional file types** | v3+ | Index `.mjs`, `.html` (for Suitelet templates), or other NetSuite scriptable assets. |
| **Include / exclude glob patterns** | v2 | Allow the user to narrow the index with patterns like `SuiteScripts/myproject/**` or exclude `**/vendor/**`. |
| **Auto-refresh schedule** | v3+ | Background job that re-runs delta refresh on a configurable schedule (e.g. every 4 hours). |
| **Index health dashboard** | v2 | Show build success rate, oldest cached file, storage trending (growing/shrinking). |
| **Per-file change detection** | v2 | Compare `modified` timestamps at search time (not just build time) to warn when a cached file is stale. |

### 14.4 UI & Presentation

| Feature | Priority | Notes |
|---------|----------|-------|
| **Collapsible context window** | v2 | Default to showing only the matched line with a "show context" toggle. |
| ~~**Collapsible card / file groups**~~ | ~~v2~~ | **✅ Done** — Search result cards group by file and support collapse/expand. |
| ~~**Compact toolbar layout**~~ | ~~v2~~ | **✅ Done** — Build/Refresh and menu buttons moved next to search box. |
| **Result card facets** | v2 | Filter results by folder (`SuiteScripts`, `SuiteBundles`, `SuiteApps`) or by script type post-build. |
| **Dark mode** | v3+ | Toggle between light (default) and dark theme via CSS custom properties. |
| **Persistent side-pane mode** | v2 | Use the Chrome Side Panel API (`chrome.sidePanel`) for a persistent sidebar that stays open while navigating NetSuite. Add a preference in the ⋯ menu to toggle between popup (default) and side-pane mode. Side-pane mode auto-opens alongside NetSuite tabs. |
| **Side-pane layout** | v2 | When in side-pane mode, adjust layout (width, scrolling) to fit the sidebar constraints. Reuse existing components with responsive sizing. |
| **Full-screen / tab mode** | v2 | Keep the existing "Open in tab" feature as an alternative for maximum workspace. |
| **Syntax highlighting in context** | v3+ | Apply the existing `highlight.js` tokenizer output with CSS classes for a richer code view. |

### 14.5 Integration & Export

| Feature | Priority | Notes |
|---------|----------|-------|
| **Export results** | v2 | Copy results as Markdown, plain text, or JSON for sharing or ticket attachments. |
| **Open in external editor** | v3+ | If the user has VS Code installed, open the file (requires a companion local server or protocol handler). |
| **Clipboard integration** | v2 | Copy the full source of a result file to clipboard for quick pasting into an IDE. |

### 14.6 Multi-Account & Collaboration

| Feature | Priority | Notes |
|---------|----------|-------|
| **Multi-account cache** | v3+ | Maintain separate caches for sandbox and production accounts with an account switcher. |
| **Per-user settings sync** | v3+ | Sync settings (folder selection, skip minified, etc.) across browsers via a simple cloud profile or export/import JSON. |

### 14.7 Security & Privacy

| Feature | Priority | Notes |
|---------|----------|-------|
| **Sensitive content redaction** | v3+ | Configurable regex patterns (e.g. `NLAuth.*`, `nlapiSetCredentialToken`) to blur matched secrets in the context window. |
| **Encrypted local storage** | v3+ | Optional passphrase-based encryption for `chrome.storage.local` so cached source is not readable on disk. |
| **Cache age indicator per file** | v2 | Show a small badge on result cards when the cached version is significantly older than the server `modified` timestamp. |
### 14.8 Account Comparison & Diff Checker

> Compare scripts between two NetSuite accounts (e.g. Sandbox vs Production) with a line-by-line
> diff view, similar to `git diff`.

| Feature | Priority | Notes |
|---------|----------|-------|
| ~~**Cross-account diff view**~~ | ~~v2~~ | ~~Side-by-side or unified diff of a single file between two cached accounts~~. **✅ Done** — Unified diff with file path input, fuzzy autocomplete from combined file list. |
| ~~**Directory-level diff summary**~~ | ~~v2~~ | ~~Show a list of files that differ between two accounts~~. **✅ Done** — Folder comparison (e.g. `ACS/`) diffs all files in that folder. |
| ~~**Account pairing setup**~~ | ~~v2~~ | ~~User selects a "base" account and a "comparison" account~~. **✅ Done** — "Set as diff base" in ⋯ menu, diff banner prompts to build comparison index. |
| ~~**Diff highlighting**~~ | ~~v2~~ | ~~Line-level diff (additions in green, removals in red, context in gray)~~. **✅ Done** — LCS-based diff engine in `lib/diffEngine.js`. |
| **Export diff** | v3+ | Copy the diff as unified diff text or Markdown for inclusion in tickets or PR descriptions. |

#### Additional diff features implemented (beyond original plan):
| Feature | Status | Notes |
|---------|--------|-------|
| **Collapsible file headers** | ✅ Done | Click anywhere on the file header to toggle collapse. Minus/plus indicator at start of file name. |
| **Collapse all / Expand all buttons** | ✅ Done | Bulk toggle buttons appear when diff results are rendered. |
| **Line change count badges** | ✅ Done | Green `+N` and red `-M` badges on file headers showing additions and removals. |
| **Fuzzy autocomplete** | ✅ Done | `lib/fuzzyMatch.js` powers file path suggestions from combined file list of both accounts. |
| **Secondary search filter** | ✅ Done | Filter bar appears after search results load, filters client-side without worker round-trip. |
| **Comparison build cancel button** | ✅ Done | Cancel button appears during comparison index builds. |
| **Cache TTL (4 hours)** | ✅ Done | Auto-purge setting clears cache older than 4 hours when the background worker starts (browser startup, or popup reopen after the worker went idle) — reported once. |
| **Collapsible file headers in consolidated diff** | ✅ Done | Consistent with diff checker — collapsible file headers in consolidated folder diff view. |
| **Diff mode persistence** | ✅ Done | Diff mode state persists across popup close/reopen. |
| **Account-aware comparison ready check** | ✅ Done | Validates diff base account is set and comparison index exists before allowing diff. |
| **Auto-set diff base on mode entry** | ✅ Done | Automatically sets diff base account when switching to diff mode. |
| **Pull index / Build comparison index banners** | ✅ Done | Banner prompts guide user to pull index or build comparison index when needed. |

#### Recent quality fixes:
| Fix | Notes |
|-----|-------|
| **Comparison rebuild preserving diff base account** | Fixed bug where rebuilding comparison index wiped the diff base account setting. |
| **Dismiss banner symmetric behavior** | Fixed asymmetric dismiss behavior in banner components. |
| **Folder selection in diff banner** | Fixed folder selection not working correctly in diff banner. |
| **Dead code removal** | Cleaned up unused code paths and functions. |
| **Account-caching bug fixes + Accounts page** | ✅ Done (2026-08-18) | TTL purge moved to worker spawn (no longer per-status, which deleted caches on view switch); `CLEAR_INDEX` is per-account with a new explicit `CLEAR_ALL_CACHE`; last-used account resolution for the extension's own full tabs; diff state stores `{ label, origin, setAt }`; `BUILD_COMPARISON_INDEX` accepts an explicit origin without a diff base; new popup-only Accounts page with per-account Refresh / Set as diff base / Clear. See AUDIT.md (2026-08-18 re-audit). |

#### 14.8.1 How it works (actual implementation)

```
[User clicks "Set as diff base" in menu]
  -> background.js: setDiffState(currentAccountId)
  -> settings.diffBaseAccount is also set

[User navigates to a different account]
  -> popup.js detects diff state != current account
  -> Diff banner appears with folder selection + "Build comparison index" button

[User clicks "Build comparison index"]
  -> background.js: inventoryAll() + downloadContent() for comparison account
  -> Stores under ssnav.comparison.* keys
  -> Comparison account has its own Cancel button

[User types file path and clicks Compare]
  -> Autocomplete from combined file list (both accounts, fuzzy matching)
  -> background.js: findSourceByPath() in both caches
  -> diffLines(base.lines, comp.lines) via LCS algorithm
  -> Renders unified diff with collapsible headers, +/- badges

[User types folder path like "ACS/"]
  -> background.js: compares all files matching that folder prefix
  -> Returns array of CompareResult objects
```

#### 14.8.2 Key considerations

- **File matching:** Files in different accounts may have different `internalId`s. Match by
  `folderPath + name` (e.g. `SuiteScripts/foopage.client.js`) rather than internal id.
- **Storage:** Caching two full account indexes doubles storage. Comparison cache is stored
  under `ssnav.comparison.*` keys and cleared when diff base is cleared.
- **Diff algorithm:** LCS (longest common subsequence) implementation in `lib/diffEngine.js`
  using bottom-up DP with `Float64Array`. Context padding via `CONTEXT_RADIUS` constant.
- **Performance:** Diff runs synchronously in the service worker. For very large files,
  consider Web Worker offloading in future iterations.
- **Scope:** File-level and folder-level diff are implemented. Full "account diff" (all files) is v3+.

### 14.9 Saved Searches & Bookmarks

| Feature | Priority | Notes |
|---------|----------|-------|
| **Save current search** | v2 | Button to save the current search (term, case sensitivity, folder filters) as a named bookmark. Store in `chrome.storage.local` with a name chosen by the user. |
| **Saved searches list** | v2 | Dropdown or panel to view and execute saved searches. Clicking a saved search populates the search bar and runs it. |
| **Custom field filtering** | v3+ | Allow saved searches to include filters by script custom fields (e.g. script type, deployment status, custom tags) when those fields are available in the NetSuite inventory response. |
| **Share saved searches** | v3+ | Export saved searches as JSON for team sharing or import from another user's export. |


### 14.10 Rebranding

| Feature | Priority | Notes |
|---------|----------|-------|
| **Name change to SuiteDetective** | v2 | Rename the extension from "SuiteScript Navigator" to "SuiteDetective" (or similar). Update manifest, HTML title, and all branding references. Consider A/B testing or user feedback before finalizing. |

### 14.11 About & Info

| Feature | Priority | Notes |
|---------|----------|-------|
| **About dialog** | v2 | Add an "About" entry in the ⋯ menu that opens a modal or tooltip with: extension name, version/build number, author name, company information, and support contact. |
| **Build/version display** | v2 | Show the current version in the header or footer (e.g. "SuiteDetective v1.0.7"). Pull version from `manifest.json`. |
| **Company branding** | v2 | Include company logo or name in the about dialog for visibility and credibility. |
| **Release notes link** | v3+ | Optional link to changelog or release notes in the about dialog. |
