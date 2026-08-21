# SuiteScript Navigator — Security, Efficiency & Improvement Audit

**Date:** 2026-08-06
**Updated:** 2026-08-14 — per-account cache scoping implemented (see FIXED findings below)
**Updated:** 2026-08-18 — caching re-audit: spawn-time purge, per-account Clear cache, last-used account resolution, diff-base origin, new Accounts page (see the 2026-08-18 Re-Audit section below)
**Updated:** 2026-08-21 — store-readiness Tier-1 fixes: explicit CSP, permission trim (`tabs`/`alarms` removed), `innerHTML` sinks moved to `textContent`, `?origin=` param validated, inventory fetch URLs validated to `*.netsuite.com` (see the FIXED entries below)
**Scope:** Full read-through of `manifest.json`, `background.js`, `lib/*.js`, `popup/*`.
**Method:** Manual static review (no live NetSuite traffic available).

> Severity key: **[HIGH]** security/data-integrity impact · **[MED]** real but bounded
> impact · **[LOW]** hardening/cosmetic · **[SUG]** suggested enhancement.

---

## Executive Summary

The extension is well-structured, defensive in its network handling (backoff,
retry, delta refresh, resumable builds, auto-purge of stale cached source), and
uses safe DOM APIs (`textContent`) for nearly all user/NetSuite-controlled data.
However, there are a handful of issues worth addressing before broad deployment:

1. ~~A **data-integrity bug** in the comparison-index cancellation path that
   corrupts the primary index metadata, and a cache that is **not scoped by
   account**, so switching accounts can mix/overwrite sources.~~
   **FIXED (2026-08-14)** by the per-account cache redesign — every cached
   index is now scoped per account, and one shared cancellation finalizer
   writes only the target account's meta.
2. A **memory ceiling risk** in the diff engine (full O(n·m) LCS table) with no
   input cap for two-sided diffs.
3. Repeated full-storage reads (`chrome.storage.local.get(null)`) on every
   search/build, which is wasteful on large accounts. (The status path no
   longer does a full-storage scan for `scriptCount` — fixed 2026-08-14.)
4. Several `innerHTML` sinks in the popup that interpolate untrusted strings.
5. An over-broad `tabs` permission and a couple of origin-validation gaps.

---

## Security Findings

### [HIGH] Cache is not scoped per account — cross-account source mixing
**Status: FIXED (2026-08-14).** All cached index data is now scoped per
account: `ssnav.meta.{label}`, `ssnav.inventory.{label}`, and
`ssnav.src.{label}:{internalId}`, where `label` is the account's `baseHost`
prefix (e.g. `1234567-sb1`, the same value used as `meta.accountId` and the
diff state). The colon after the label keeps per-account keys distinguishable
from legacy keys. A cache pulled for an account (from the search page or the
Diff page) is immediately usable for that account's search AND for diffing,
and multiple accounts' caches coexist — the old "primary" slot is no longer
special; the diff base account's cache is simply that account's own
per-account cache. A one-shot `migrateLegacyCache()` at service-worker
startup moves the legacy flat keys (`ssnav.meta`, `ssnav.inventory`,
`ssnav.src.{internalId}` without a colon) and all `ssnav.comparison.*` keys
into the per-account slot of the accountId recorded in each slot's meta
(comparison slot falls back to the stored comparison account id), then
deletes them; a quick 5-key probe makes it a no-op after the first
migration. The base account's cached index is preserved whenever the diff
base designation changes — it still serves that account's search page —
while "Clear cache" (`CLEAR_INDEX`) clears only the resolved account's slot
(per-account since the 2026-08-18 re-audit;
the explicit all-accounts action is now `CLEAR_ALL_CACHE`). All
`ssnav.comparison.*` keys are gone from the live
design.

`lib/storage.js` keys every source shard by internal ID only (`ssnav.src.{internalId}`,
`srcKey()` at line 71). There is no account component in the key. `getAllSources()`
(and `statusMsg`, `searchMsg`, diff base reads) load **all** shards regardless of
account. Consequences:
- Building an index for account A and then account B leaves A's shards in place;
  the two accounts' files share key space and can overwrite or mix.
- Search/status counts and diff-base reads silently include sources from whatever
  accounts were built most recently.
- `meta.accountId` is tracked, but nothing enforces that the sources belong to it.

**Recommendation:** Namespace shards by account, e.g. `ssnav.src.{accountId}.{internalId}`,
and have `getAllSources()`/`getSourceMetaMap()` filter by the account in `meta`. At
minimum, clear the primary cache when `buildIndexMsg` detects a different account
than the one `meta` was built for.

### [HIGH] Cancelling a comparison-index build clobbers the primary index metadata
**Status: FIXED (2026-08-14).** Both build paths now run through one unified
build core (`runIndexBuild` in `background.js`) and one shared cancellation
finalizer that writes a `status: "cancelled"` meta to the **target
account's own** per-account slot — cancelling a build can no longer touch
another account's index metadata, and the primary-slot clobber described
below cannot occur because no shared "primary" slot remains.

`background.js` `buildComparisonIndexMsg()` calls `finishCancelled()` on both
cancel paths (inventory-cancel line ~851 and content-cancel line ~883). But
`finishCancelled()` (lines 394–420) writes to the **primary** `META`/sources via
`setMeta()`/`getAllSources()`. Cancelling a comparison build therefore:
- Marks the **primary** index as `status: "cancelled"` (or corrupts its counts),
- Reports primary-source counts, and
- Never writes `setComparisonMeta(...)`.

**Recommendation:** Give the comparison path its own finalizer that writes to
`COMPARISON_META`/`getAllComparisonSources()`, or refactor `finishCancelled()` to
accept a storage target.

### [MED] Unvalidated inventory URLs are fetched with the session cookie
**Status: FIXED (2026-08-21).** `fetchSource()` now runs every resolved URL
through `assertNetsuiteUrl()`: it must parse, use `https:`, and have a
hostname matching `NETSUITE_HOST_RE` (`*.netsuite.com`). Anything else throws
a fatal error before the retry loop, so the file is counted as failed and
never fetched. (MV3 `host_permissions` already blocked cross-origin fetches;
this is explicit defense-in-depth.)
`lib/netsuiteClient.js` `looksLikeFileUrl()` / `cellUrl()` / `findUrlInRow()` accept
**any** `https?://` string from the inventory response, and `buildMediaUrl()`
passes it straight to `fetch(url, { credentials: "include" })`. If a NetSuite
account or a SuiteApp/bundle in a compromised account returns a crafted URL, the
extension will fetch an arbitrary origin with the user's cookies for **that**
origin and store/parse the response as script source. Cookie exfiltration of the
NetSuite cookie is limited (cookies are origin-scoped), but the extension will
still contact and process attacker-controlled endpoints and cache their bodies.

**Recommendation:** Validate/coerce the resolved URL to stay within the resolved
account origin (`account.origin` + host-permission set) before fetching. Reject
`http://`, and reject hosts that are not the account's `.app.netsuite.com` /
`.netsuite.com` host.

### [MED] Several `innerHTML` sinks interpolate untrusted strings
**Status: FIXED (2026-08-21).** The `handleCompare()` error/catch paths and
the `renderFolderDiffResult()` folder header (user-controlled `folderPath`)
now build their DOM with `textContent` instead of interpolating into
`innerHTML`. Every remaining `innerHTML` in the popup is a static string,
numeric-only, or the already-escaped autocomplete builder.
`popup/popup.js` used `innerHTML` with template literals in the error paths
(lines 1036, 1043, 1065, 1072) and, most notably, in `renderFolderDiffResult`
(line 1431) where `folderPath` (user-controlled text from the diff input) is
interpolated directly. Most other sinks are static strings or numeric values and
are safe. `renderAutocompleteItem` (line 1713+) correctly escapes `<`, `>`, `&`,
so that one is fine.

**Recommendation:** Replace the template-literal `innerHTML` sinks with
`textContent`-based DOM construction (the rest of the file already does this
consistently). This removes the self-XSS / injection surface entirely.

### [LOW] No declared Content Security Policy
**Status: FIXED (2026-08-21).** `manifest.json` now declares
`"content_security_policy": { "extension_pages": "script-src 'self'; object-src 'self'" }`.
`manifest.json` did not declare `content_security_policy`. MV3's built-in
default for extension pages is `script-src 'self'; object-src 'self'`, which is
safe and blocks remote script — but an explicit policy makes the intent clear and
guards against regressions (e.g., if a `script` tag or eval is later introduced).

**Recommendation:** Add
`"content_security_policy": { "extension_pages": "script-src 'self'; object-src 'self'" }`.

### [LOW] Message handlers do not validate the sender
`chrome.runtime.onMessage.addListener` in `background.js` never checks
`sender.id === chrome.runtime.id`. With no `externally_connectable` declared,
only this extension's pages can connect today, so impact is minimal, but checking
the sender is a cheap hardening step against a compromised extension page or a
stray listener.

### [LOW] `origin` URL parameter is not validated to be a NetSuite origin
**Status: FIXED (2026-08-21).** The popup's `resolveAccount()` now accepts
the `?origin=` param only when it parses as a URL, uses `https:`, and its
hostname matches `NETSUITE_HOST_RE`; anything else is ignored and falls
through to the normal `RESOLVE_ACCOUNT` background round-trip, so
`state.accountOrigin` (and thus `buildFileUrl()` / `chrome.tabs.create`)
can no longer be pointed at an arbitrary origin.
`resolveAccount()` in `popup.js` accepted an `origin` query param and
uses it verbatim as `state.accountOrigin`, which then feeds `buildFileUrl()` →
`chrome.tabs.create(url)`. A crafted `chrome-extension://…/popup.html?tab=1&origin=https://evil.com`
would make the extension create tabs to an arbitrary origin. User must already
open a malicious URL, but validating against `NETSUITE_HOST_RE` is trivial and
removes the risk.

### [LOW] Credentials/secrets may be cached in plaintext storage
By design the extension caches script source (which may contain embedded API
keys or secrets) in `chrome.storage.local` with `unlimitedStorage`. The 4-hour
auto-purge (`autoPurgeStale`, `CACHE_TTL_MS`) is a good mitigation. Consider:
- Defaulting `autoPurgeStale` to on (it is) and documenting the trade-off clearly.
- Not caching **any** account's sources any longer than necessary (each
  account's cache purges independently on its own TTL).
- Optionally warning users that indexed files may contain secrets and are stored
  in plaintext on disk until purged.

---

## Efficiency Findings

### [HIGH] Diff engine has an unbounded O(n·m) memory/CPU blow-up
`lib/diffEngine.js` `lcsTable()` allocates a full `(m+1) × (n+1)` `Float64Array`
(8 bytes/cell). `FULL_DIFF_LINE_CAP = 2000` only caps the **output hunk** for
only-in-one-account files; it does **not** limit the two-sided `diffLines()` call.
Two similar 5,000-line files → a 25 M-cell table ≈ **200 MB**; two 10,000-line
files ≈ **800 MB**, likely killing the service worker. `compareFolderMsg` runs
this per file in a loop.

**Recommendation:** Cap the line count fed into `diffLines()` (e.g., truncate or
decline with a clear message above a threshold like 4k lines each), or replace the
table-based LCS with a memory-efficient algorithm (Hunt–Szymanski, Myers diff, or
Hirschberg's linear-space LCS) and/or an early equality/prefix/suffix trim before
building the table.

### [MED] Repeated full-storage reads on every operation
`chrome.storage.local.get(null)` (loads the **entire** storage) is called in
`getAllSources(label)`, `getSourceMetaMap(label)`, `clearAccountCache(label)`,
and `clearAllCaches()`, and in `searchMsg`. On a large account this is done
multiple times per action — e.g. `searchMsg` loads every shard into memory
(per-account reads filter by the `ssnav.*.{label}` prefix after the full
read) and then scans every line. This is the dominant scaling cost. (The
`statusMsg` full-storage scan for `scriptCount` was removed in the 2026-08-14
per-account redesign; the count now comes from the per-account meta.)

**Recommendation:**
- Maintain a lightweight index/registry (list of `{internalId, accountId, modified}`
  entries in a single meta key) so delta checks and counts don't need a full dump.
- For `searchMsg`, either search in batches/streaming or build an inverted index
  at download time; loading every source fully into the worker on each keystroke is
  heavy. Consider an `on-screen`/worker-cache with a TTL instead of a full reload.
- `getUsage()` uses `getBytesInUse(null)` which is cheap; keep using that rather
  than counting via full dumps.

### [MED] `getComparisonSourceMetaMap` duplicates storage logic with hardcoded keys
**Status: OBSOLETE (2026-08-14).** The comparison slot no longer exists —
per-account scoping replaced it. `getSourceMetaMap(label)` in `storage.js`
reads a single account's shards from the per-account source prefix, and the
hardcoded `ssnav.comparison.src.` key is gone.

`background.js` lines 554–564 re-implement `getSourceMetaMap` using the
hardcoded string `"ssnav.comparison.src."` instead of the `STORAGE_KEYS` constant.
Move it into `storage.js` alongside `getSourceMetaMap` and use
`STORAGE_KEYS.COMPARISON_SRC_PREFIX`.

### [LOW] `unlimitedStorage` disables the near-quota guard
With `unlimitedStorage`, `getUsage()` reports an infinite quota and `ratio` is
always 0, so the "storage almost full" warning never appears and the cache can
grow without bound. The skip-minified option mitigates this. Consider tracking
`getBytesInUse` against an internal soft cap (e.g., 500 MB) to keep the guard
meaningful, or at least surface actual byte usage in the status line.

### [LOW] Search is a brute-force substring scan
`lib/searchEngine.js` lowercases every line on every search (`line.toLowerCase()`
per line per keystroke). For a large corpus this is CPU-heavy in the worker.
A per-source lowercased snapshot, a bloom filter, or an inverted n-gram index
would make search effectively instant. At minimum, cache the lowercased lines
alongside the source at download time.

### [LOW] `failures` array is collected but never surfaced
`downloadContent` accumulates every failure into `failures` (could grow large on
a flaky account) but only the count is reported. Either surface a sample/retry
list to the UI or drop the array to save memory.

---

## Correctness / Robustness

### [MED] `Rebuild (full)` and `clearAll()` also wipe the comparison/diff index
**Status: RESOLVED (2026-08-14).** Per-account scoping fixed the data loss:
a "Rebuild (full)" now clears only the target account's own slot
(`clearAccountCache(label)`), so rebuilding one account no longer touches
any other account's cache. ~~`CLEAR_INDEX` ("Clear index") intentionally
clears **every** account's cache — that is now the documented behavior of
the explicit clear-all action.~~ *(Superseded 2026-08-18: `CLEAR_INDEX` is
now per-account — it clears only the resolved account's slot — and the
explicit all-accounts action is `CLEAR_ALL_CACHE`; see the 2026-08-18
Re-Audit section below.)*

`clearAll()` (storage.js line 120) removes primary **and** comparison keys, and
the primary "Rebuild (full)" path calls `clearAll()` (background.js line 253).
If a user has built a diff comparison index and then rebuilds the base account,
the comparison data is silently destroyed. If intended, document it; otherwise
scope rebuild clearing to the primary account only.

### [LOW] Source shards are never pruned after delta refresh
When a script disappears from inventory (deleted file), `buildIndexMsg` does not
remove its now-orphaned `ssnav.src.{label}:{id}` shard. Over repeated builds, stale source
accumulates in storage and can surface in search/counts. Prune shards not present
in the latest inventory (or reconcile against `meta.scriptCount`).

### [LOW] `isExpired` never fires when both `builtAt` and `updatedAt` are null
In `purgeIfStale`, if a meta record somehow has neither timestamp, the cache is
never purged. Consider treating a null timestamp on an existing meta as expired.

### [LOW] Inventory `folder` filter values are not validated against allow-list
`buildSearchBody` passes `folders` through unvalidated. Only this extension's
popup sends them, so risk is low, but validating against `SCRIPT_FOLDER_DEFS`
would harden it.

### [LOW] Stale JSDoc reference to `../types` module
`popup.js` line 57 (`import('../types').Hit`) references a module that does not
exist; it's only in comments so it never fails at runtime, but it is misleading.

---

## Improvement Opportunities

- **Per-account caching (see FIXED [HIGH] above)** is now implemented
  (2026-08-14): per-account slots, one-shot legacy migration, and true
  multi-account search without the old mixing bugs.
- ~~**Add an explicit CSP** and **reduce the `tabs` permission** to
  `"activeTab"` + the existing `host_permissions`~~ — **DONE (2026-08-21)**:
  explicit CSP declared; `permissions` is now
  `["storage", "unlimitedStorage", "activeTab"]` (`tabs` was redundant —
  `tab.url` visibility for the `*.netsuite.com` tab queries comes from
  `host_permissions`; the unused `alarms` permission was removed too;
  see `lib/accountResolver.js` comment).
- **Add icons** (the README notes none are shipped) so the action uses a real icon.
- **Surface the failed-file list** (retry-on-request) instead of silently skipping,
  and **show actual storage bytes** even under `unlimitedStorage`.
- **Cap `diffLines` inputs** and **trim equal prefix/suffix lines** before computing
  LCS — a common, cheap optimization that also cuts the memory table dramatically.
- **Account-switch surprises** are handled by per-account scoping
  (implemented 2026-08-14) — builds and searches always read/write the
  active account's own slot, so no cross-account flagging is needed.

---

## Open Questions (need your input to resolve)

1. **Multi-account behavior:** Do you intend the base index to support more than
   one account at a time, or is one base + one comparison the intended model? This
   determines whether per-account keying or a "clear on switch" approach is right.
   *Resolved (2026-08-14): per-account keying — any number of accounts' caches
   coexist.*
2. **Rebuild vs comparison:** Should "Rebuild (full)" on the base account preserve
   the diff-comparison index, or is wiping it acceptable?
   *Resolved (2026-08-14): a rebuild clears only its own account's slot; other
   accounts' caches are preserved. `CLEAR_INDEX` intentionally clears all
   accounts.* *(Superseded 2026-08-18: `CLEAR_INDEX` now clears only the
   resolved account; `CLEAR_ALL_CACHE` is the explicit all-accounts clear —
   see the 2026-08-18 Re-Audit section below.)*
3. **Search scale:** How large are the target accounts (rough script count and avg
   file size)? That informs whether an inverted index or batch search is warranted.
4. **Diff size:** Are there known files large enough to hit the O(n·m) LCS ceiling,
   or is capping input at ~2–4k lines acceptable?

I'm happy to implement any of the fixes above — let me know your priorities.

---

## Re-Audit: Account Caching (2026-08-18)

Re-audit of the account-caching implementation after the 2026-08-14
per-account redesign, prompted by the report that a cached account
**disappears when switching between the search and diff views**. Five root
causes were found and fixed in this round, plus one dead-code cleanup and a
new Accounts page.

### [MED] TTL purge ran on every `GET_STATUS` — the "cache disappears on view switch" bug
**Status: FIXED (2026-08-18).** `statusMsg` called `purgeIfStale()` on every
status refresh — and every search↔diff view switch triggers a status refresh
— so a cached account whose last build was older than 4 hours was silently
deleted at the moment the user merely switched views (the main reported
symptom). The purge now runs **once per worker spawn** (top-level
fire-and-forget in `background.js`, after `migrateLegacyCache()`) and on
`chrome.runtime.onStartup`; `GET_STATUS` only *reports* whether the
spawn-time purge cleared anything (`purged` flag), and the popup shows the
"Cleared cache older than 4 hours" toast once at init only. Refreshing
status can no longer clear a cache.

### [MED] "Clear cache" (`CLEAR_INDEX`) cleared **all** accounts
**Status: FIXED (2026-08-18).** `CLEAR_INDEX` cleared every account's
meta/inventory/source shards while its confirm dialog said "this account" —
a behavior/label mismatch (echoed in the [MED] Rebuild finding's RESOLVED
note and Open Question 2 above, now annotated as superseded). `CLEAR_INDEX`
now resolves the target account (via the message's `origin` hint, else the
usual resolution) and clears only that account's slot. A new explicit
`CLEAR_ALL_CACHE` message clears every account; it is wired to a new "Clear
all accounts" menu item and to the Accounts page footer button, each with
its own confirm.

### [MED] Non-deterministic account resolution in the extension's own full tabs
**Status: FIXED (2026-08-18).** `resolveAccount()` fell back to the *first*
open NetSuite tab whenever the active tab wasn't NetSuite — exactly the case
inside the extension's own full tabs (search/diff pop-outs). With multiple
NetSuite tabs open, that could resolve to the **wrong** account and even
auto-set the wrong diff base. `lib/accountResolver.js` now records the
most-recently-used NetSuite origin in `chrome.storage.session`
(`ssnav.lastAccount`) on every successful resolution, and resolves in order:
active NetSuite tab → last-used origin → first-NetSuite-tab scan (last
resort only).

### [MED] Diff state stored only the label; banner build synthesized the origin
**Status: FIXED (2026-08-18).** `ssnav.diff.state` was a plain label string,
and the diff-banner build synthesized `https://<label>.app.netsuite.com` —
wrong for any non-standard host. The state is now
`{ label, origin, setAt }` (legacy plain-string values still read via
`getDiffStateObj()`), `GET_STATUS` and `CACHED_ACCOUNTS` expose
`diffBaseOrigin`, and the banner build uses the stored origin instead of
synthesizing one.

### [LOW] `BUILD_COMPARISON_INDEX` rejected an explicit `origin` with no diff base set
**Status: FIXED (2026-08-18).** The guard errored whenever no diff base was
set, even when the message named the target account explicitly via `origin`.
The guard now errors only when *neither* is present — this is what enables
the per-account "Refresh" action on the Accounts page for accounts that
aren't the current one.

**Also removed (dead code):** the popup's `loadSettings` read a
`settings.diffBase` key that nothing ever wrote (and didn't even match the
`Settings.diffBaseAccount` field name).

### New feature: Accounts page
A new popup-only view (third mode, toggled by the **Accounts** toolbar
button, which becomes **← Back** while open; hidden in full tabs, which stay
single-purpose) lists every account with cached index data: label, status
badge (ready / pulling inventory / pulling sources / cancelled), script
count, last-updated age, and size, plus "current tab" and "diff base"
badges. Per-account actions: **Refresh** (re-pulls that account's index —
`BUILD_INDEX` when it's the current account, `BUILD_COMPARISON_INDEX` with
an explicit `origin` otherwise), **Set as diff base**, **Clear**. The footer
shows total storage used and a **Clear all accounts** button.

Backed by a new `GET_CACHED_ACCOUNTS` → `CACHED_ACCOUNTS` message:
`accounts: [{ accountId, meta, shardCount, bytes }]` sorted by
`meta.updatedAt` desc (`bytes` = in-memory JSON size of that account's
stored values), plus `currentAccount`, `diffBase`, `diffBaseOrigin`, and
`usage`. New `storage.js` helper `getCachedAccounts()`; new files
`popup/accounts.js` (fetch + render, delegated row actions) and
`popup/accounts.css`.

### [HIGH] Top-level await killed service-worker registration on older Chrome
**Status: FIXED (2026-08-18).** This is the **confirmed root cause** of the
"Checking…" hang on the fleet: `background.js` used a top-level
`await migrateLegacyCache()`, and older Chrome builds (the managed fleet
browsers) reject top-level await in service workers at registration:
`Top-level await is disallowed in service workers. Service worker
registration failed. Status code: 3`. The worker **never started**, so the
popup's `RESOLVE_ACCOUNT` message had no worker to answer it. Fixed by
removing the top-level await: the migration now runs as a
`migrationPromise` and every message handler (plus the `onStartup` and
spawn-time purges, which chain onto it so they never interleave on
storage) gates on it. Registration no longer waits for the migration.
Verified in the harness (`listener-registered-despite-slow-migration`):
with the legacy migration wedged in flight, the fixed worker still
registers its `onMessage` listener, while the pre-fix worker's module
import hangs (the exact TLA behavior). The `"type": "module"` service
worker is kept — the fleet browsers accept module workers, only TLA is
banned.

### [MED] Stuck "Checking…" account label after the 2026-08-18 deploy
**Status: FIXED (2026-08-18, post-deploy).** The header account label hung
on "Checking…" forever. The label is set by the popup's `RESOLVE_ACCOUNT`
round-trip. On the fleet the real cause was the worker never registering
at all (see the [HIGH] entry above — top-level await ban); this entry
records the secondary hardening for when a worker *is* running but a
promise on the response path never settles: the only new call the
round-trip made after this deploy was `chrome.storage.session` in the
worker — `recordLastAccount()` was **awaited** in `resolveAccountMsg`
(and the last-used-origin tier of `resolveAccount()` awaits a
`chrome.storage.session.get`). A session-storage promise that never
settles cannot be caught by `try/catch`, so the handler never called
`sendResponse` and the popup's `await` hung with it. Fixed on
three layers:
1. `lib/accountResolver.js`: every `chrome.storage.session` call is now
   capped by `settleWithin()` (2 s → treated as unavailable), so a wedged
   session store degrades to the next resolution tier instead of hanging.
2. `background.js`: `recordLastAccount()` is now fire-and-forget
   (`void`) in both `resolveAccountMsg` and `resolveAccountWithHint` —
   bookkeeping never holds a response open.
3. `popup.js`: the `RESOLVE_ACCOUNT` send is raced against an 8 s timeout;
   on timeout the label shows "Error" plus a "reload the extension" toast
   instead of "Checking…" forever (covers worker crash loops and wedged
   startup, which no worker-side change can fix).

Reproduced in the harness (`wedged-session-storage-still-resolves`): with a
never-settling `chrome.storage.session`, the pre-fix worker times out on
`RESOLVE_ACCOUNT` (the exact field symptom); the fixed worker resolves via
the active-tab tier immediately and falls through to the first-NetSuite-tab
tier within the 2 s cap.
