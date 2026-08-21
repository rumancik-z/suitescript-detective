# SuiteScript Navigator

A Manifest V3 Chrome extension for fast, grep-like text search across all
SuiteScript files in a NetSuite account. Vanilla JS + CSS, no build tools, no NPM.

See [`STRUCTURE.md`](./STRUCTURE.md) for architecture and code structure, [`PLAN.md`](./PLAN.md) for the roadmap.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Scaffold (manifest, file tree, service worker) | ✅ Done |
| 1 | Account resolution from the active tab | ✅ Done |
| 2 | Inventory + pagination (`nlapijsonhandler.nl`) | ✅ Done |
| 3 | Content download + cache (`media.nl`) | ✅ Done |
| 4 | Search engine + context window | ✅ Done |
| 5 | UI & theme (white + pastel, result cards, context window) | ✅ Done |
| 6 | Hardening (delta refresh, resumable builds, quota guardrails) | ✅ Done |
| 7 | Polish & docs | ✅ Done |

> All planned v1 phases are implemented. The one item that still needs
> confirmation against **live** NetSuite traffic is the shape of the
> `nlapijsonhandler.nl` (`jrr=T`) response — see [Limitations](#limitations).

## What it does

1. Reads the active tab to detect the NetSuite account (`Account <id>` chip).
2. **Build / Refresh** inventories every available JavaScript file via
   `nlapijsonhandler.nl` (cursor-paginated by `internalidnumber`), then downloads
   each file's source via `media.nl` in throttled batches with exponential-backoff
   retries. Sources are cached as per-script shards in `chrome.storage.local`.
3. Type a term to search the cached corpus in-memory. Each result card shows the
   **file name**, **folder path**, **line number**, and a **±5-line context window**
   with the match highlighted. A secondary filter bar narrows results client-side.
4. **Diff checker** compares files between two accounts (e.g. Sandbox vs Production)
   with a unified diff view, collapsible file headers, and change-count badges.
5. **Accounts page** lists every account with cached index data — status,
   script count, last-updated time, and size — with per-account Refresh,
   Set-as-diff-base, and Clear actions.

All requests use `credentials: "include"` to reuse your existing NetSuite session —
the extension stores no credentials or tokens.

## Load the extension (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this project folder.
4. Open a NetSuite tab, then click the extension icon.
   - The account chip shows `Account <id>` when a NetSuite tab is detected.

## Usage

### Search

| Control | Action |
| --- | --- |
| **Search box** | Substring search across all cached scripts (debounced). |
| **Aa** toggle | Case-sensitive matching. |
| **Filter results bar** | Appears after search results load. Filters the already-retrieved results client-side (no additional network calls). |

### Indexing

| Control | Action |
| --- | --- |
| **Build / Refresh** | Runs inventory + content download. Skips scripts whose `modified` timestamp is unchanged, so it's cheap to re-run and **resumes** an interrupted build. |
| **Cancel** | Appears while a build is running. Stops retrieval at the next checkpoint, keeping whatever was already cached. The index is marked incomplete so **Build / Refresh** resumes it. |
| **⋯ → Rebuild (full)** | Clears the cache and re-downloads everything from scratch. |
| **⋯ → Folders to index** | Checkboxes for **SuiteScripts** (`-15`), **SuiteBundles** (`-16`), and **SuiteApps** (`-19`). Only checked folders are inventoried/downloaded on the next build. The selection is remembered and persists correctly across extension reopen. |
| **⋯ → Skip minified / bundle files** | When checked, skips minified/bundled assets (e.g. `*.min.js`, content-hashed bundle files, or any file with a very long line) — the main storage hogs. Applies at **download** time and **retroactively at search time**, so already-cached minified files are excluded from results without re-indexing. The setting is remembered. |
| **⋯ → Clear cache older than 4 hours on open** | *(On by default.)* Security/hygiene: when the background worker starts — browser startup, or the popup reopening after the worker has gone idle — any cache whose last build is older than **4 hours** is cleared, so cached source and any embedded secrets don't linger. The purge runs once at worker start (a plain status/view refresh never clears a cache), and if it cleared anything the popup says so once. It does **not** auto-re-pull — opening stays instant; click **Build / Refresh** when you want fresh data. |
| **⋯ → Clear cache** | Removes the cached data for **this** account only (other accounts' caches are kept). |
| **⋯ → Clear all accounts** | Removes the cached data for **every** account (with its own confirm). |

### Accounts page

The **Accounts** button in the toolbar opens a view of every account with
cached index data; it becomes **← Back** while open. It is popup-only — the
full tabs stay single-purpose.

| Control | Action |
| --- | --- |
| **Accounts** | Opens the cached-accounts list. Each account shows its label, a status badge (ready / pulling inventory / pulling sources / cancelled), script count, last-updated age, and size, with "current tab" and "diff base" badges where applicable. |
| **Refresh** (per account) | Re-pulls that account's inventory and sources. Uses the regular Build for the current account; for any other account it runs a comparison build targeting that account by origin. |
| **Set as diff base** (per account) | Marks that account as the diff base for comparisons. |
| **Clear** (per account) | Deletes that account's cached data (with a confirm). |
| **Clear all accounts** (footer) | Deletes every account's cached data (with a confirm). |

The footer also shows the total storage used by all cached accounts.

### Diff Checker

Compare scripts between two NetSuite accounts (e.g. Sandbox vs Production) with a unified diff view.

| Control | Action |
| --- | --- |
| **⋯ → Set as diff base** | Marks the current account as the "base" for diff comparisons (e.g. your Sandbox account). |
| **Base / comparison pickers** | In the diff view, pick the base and the comparison account from the cached accounts list (the comparison side defaults to the current account). Changing the base or comparison refreshes the banner and the autocomplete file list. |
| **⬌ Diff** | Toggles the diff view panel (appears when a diff base is set). |
| **Diff banner** | Appears when you navigate to a different account with a diff base set. Prompts you to build a comparison index for the new account. |
| **Build comparison index** | Inventories and downloads scripts from the comparison account. Includes folder selection checkboxes. A **Cancel** button appears during the build. |
| **File path input** | Type a file path to compare. Fuzzy autocomplete suggests matching files from both accounts combined. |
| **Compare** | Runs the diff for the specified file path. Shows a unified diff with collapsible file headers, line change counts (`+N`/`-M` badges), and expandable/collapsible regions. |
| **Folder comparison** | Type a folder path (e.g. `ACS/`) to compare all files in that folder at once. |
| **Collapse all / Expand all** | Bulk toggle buttons that appear when diff results are shown. |

### Navigation

| Control | Action |
| --- | --- |
| **Open in tab ⤢** | Opens the interface as a full browser tab that fills the viewport — handy for wider code/context windows. The account ID is preserved when opening from an existing tab. |
| **Result file name (link)** | Opens the file's record in NetSuite in a **background tab**, so the popup stays open and your search is preserved — click several results in a row. Ctrl/⌘/middle-click behaves like a normal link. Your last query is also remembered if the popup is reopened. |

The **index status** line (under the toolbar) shows the cached script count,
approximate storage used, and last-updated time. It warns when storage is nearly
full or when a previous build was left incomplete.

## Hardening details (Phase 6)

- **Resumable builds** — inventory checkpoints after every page; the content phase
  skips already-cached, unchanged scripts, so re-clicking **Build / Refresh** after
  a service-worker restart continues where it left off.
- **Delta refresh** — only scripts with a changed `modified` timestamp are
  re-downloaded.
- **Rate-limit friendliness** — concurrent batches (`BATCH_SIZE`) with an
  inter-batch delay, plus exponential backoff + jitter on HTTP 429/5xx. Individual
  file failures are recorded and skipped; the build never hard-stops on one file.
- **Storage guardrails** — usage is estimated via `getBytesInUse`; the UI warns at
  ≥85% of quota (`QUOTA_WARN_RATIO`).

## Limitations

- **Live response shape (needs confirmation).** The inventory parser
  (`extractRows` / `readColumn` in `lib/netsuiteClient.js`) is written defensively
  but without a captured `jrr=T` response. If **Build / Refresh** reports 0 scripts
  on a real account, that parser is the single place to adjust once a real response
  is available.
- **Scope.** v1 indexes `filetype JAVASCRIPT` files in the script folders
  SuiteScripts (`-15`), SuiteBundles (`-16`), and SuiteApps (`-19`). Other file
  types are out of scope.
- **Storage quota.** The extension requests `unlimitedStorage`, so the ~10 MB
  `chrome.storage.local` cap no longer applies and the near-quota warning is
  disabled. To keep the cache lean anyway, enable **Skip minified / bundle
  files** (⋯ menu) — minified/bundled assets are the biggest space consumers and
  are rarely useful to grep.
- **Read-only.** No editing/saving scripts back to NetSuite.

## Manual QA checklist

- [ ] Load unpacked; popup opens, service worker registers with no console errors.
- [ ] On a NetSuite tab, the account chip shows the correct `Account <id>`.
- [ ] On a non-NetSuite tab, the chip shows "No NetSuite tab" and Build is disabled.
- [ ] **Build / Refresh** shows inventory (indeterminate) then content (determinate)
      progress and finishes with an "Index ready" summary.
- [ ] Searching a known token returns results with correct file/folder/line and a
      highlighted match with context above/below.
- [ ] Re-running **Build / Refresh** reports most scripts as "unchanged" (delta).
- [ ] **Rebuild (full)** clears and re-downloads; **Clear cache** empties the
      current account's index (other accounts' caches are kept).
- [ ] Accounts page lists every cached account; per-account Refresh / Set as
      diff base / Clear and "Clear all accounts" behave as labelled.
- [ ] Index-status line shows count, size, and updated time; warns near quota.

## Icons

The manifest does not reference icons yet, so Chrome uses a default placeholder.
Drop `icon16.png`, `icon48.png`, `icon128.png` into `icons/` and add an `icons`
block + `action.default_icon` to `manifest.json` when ready.

## File layout

```
manifest.json        MV3 manifest (permissions, action, module service worker)
background.js        Service worker: message router + build orchestrator
STRUCTURE.md         Architecture guide for agents and contributors
PLAN.md              Implementation plan + future enhancements roadmap
popup/               popup.html · popup.css · popup.js (UI, theme, rendering)
                     accounts.js · accounts.css (cached-accounts page: fetch + render)
lib/
  constants.js       Endpoints, folder ids, batch/throttle config, message types, @typedefs
  accountResolver.js Active-tab → baseHost + accountId
  netsuiteClient.js  Inventory + pagination + media.nl content download
  searchEngine.js    In-memory line matcher + context window builder
  storage.js         chrome.storage.local wrapper (meta/inventory/source/comparison)
  diffEngine.js      LCS-based line-level diff algorithm
  fuzzyMatch.js      Fuzzy string matching for file path autocomplete
  highlight.js       Lightweight JS tokenizer for syntax highlighting
```

