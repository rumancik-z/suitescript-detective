// lib/storage.js — chrome.storage.local wrapper for per-account index data

import { STORAGE_KEYS } from "./constants.js";

const { META, INVENTORY, SETTINGS, SRC_PREFIX, COMPARISON_ACCOUNT, COMPARISON_META, COMPARISON_INVENTORY, COMPARISON_SRC_PREFIX, DIFF_STATE } = STORAGE_KEYS;

/** @type {Settings} */
const DEFAULT_SETTINGS = {
  skipMinified: false,
  folders: ["-15", "-16", "-19"],
  autoPurgeStale: true,
  regexMaxLines: 0,
  theme: "light",
};

/**
 * Get the current user settings (merged with defaults).
 * @returns {Promise<Settings>}
 */
export const getSettings = async () => {
  const res = await chrome.storage.local.get(SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(res[SETTINGS] || {}) };
};

/**
 * Patch and persist user settings.
 * @param {Partial<Settings>} patch
 * @returns {Promise<Settings>}
 */
export const setSettings = async (patch) => {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS]: next });
  return next;
};

// ---------------------------------------------------------------------------
// Per-account index cache
//
// Every account has its own cache slot, keyed by the account label (the
// baseHost prefix, e.g. "1234567-sb1"):
//   "ssnav.meta.<label>"             → that account's IndexMeta
//   "ssnav.inventory.<label>"        → that account's inventory array
//   "ssnav.src.<label>:<internalId>" → that account's source shards
// The colon after the label distinguishes per-account shard keys from the
// legacy flat "ssnav.src.<internalId>" keys (see migrateLegacyCache()).
// ---------------------------------------------------------------------------

/**
 * Storage key for an account's index metadata.
 * @param {string} accountId - Per-account label (e.g. "1234567-sb1").
 */
const metaKey = (accountId) => `${META}.${accountId}`;

/**
 * Storage key for an account's inventory.
 * @param {string} accountId
 */
const invKey = (accountId) => `${INVENTORY}.${accountId}`;

/**
 * Storage key for one source shard of an account.
 * @param {string} accountId
 * @param {string} internalId
 */
const srcKey = (accountId, internalId) => `${SRC_PREFIX}${accountId}:${internalId}`;

/**
 * Prefix matching every source-shard key of one account.
 * @param {string} accountId
 */
const srcPrefixFor = (accountId) => `${SRC_PREFIX}${accountId}:`;

/**
 * Get an account's index metadata, or null if no index exists for it.
 * @param {string} accountId
 * @returns {Promise<IndexMeta | null>}
 */
export const getMeta = async (accountId) => {
  const key = metaKey(accountId);
  const res = await chrome.storage.local.get(key);
  return res[key] || null;
};

/**
 * Persist an account's index metadata.
 * @param {string} accountId
 * @param {IndexMeta} meta
 * @returns {Promise<IndexMeta>}
 */
export const setMeta = async (accountId, meta) => {
  await chrome.storage.local.set({ [metaKey(accountId)]: meta });
  return meta;
};

/**
 * Load an account's full inventory array.
 * @param {string} accountId
 * @returns {Promise<InventoryEntry[]>}
 */
export const getInventory = async (accountId) => {
  const key = invKey(accountId);
  const res = await chrome.storage.local.get(key);
  return res[key] || [];
};

/**
 * Persist an account's full inventory array.
 * @param {string} accountId
 * @param {InventoryEntry[]} inventory
 */
export const setInventory = async (accountId, inventory) => {
  await chrome.storage.local.set({ [invKey(accountId)]: inventory });
};

/**
 * Persist a single source record shard for an account.
 * @param {string} accountId
 * @param {SourceRecord} record
 */
export const putSource = async (accountId, record) => {
  await chrome.storage.local.set({ [srcKey(accountId, record.internalId)]: record });
};

/**
 * Load a single source record by internal ID for an account.
 * @param {string} accountId
 * @param {string} internalId
 * @returns {Promise<SourceRecord | null>}
 */
export const getSource = async (accountId, internalId) => {
  const key = srcKey(accountId, internalId);
  const res = await chrome.storage.local.get(key);
  return res[key] || null;
};

/**
 * Load every cached source shard of an account, sorted by path then
 * internalId.
 * @param {string} accountId
 * @returns {Promise<SourceRecord[]>}
 */
export const getAllSources = async (accountId) => {
  const all = await chrome.storage.local.get(null);
  const prefix = srcPrefixFor(accountId);
  const out = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(prefix)) out.push(value);
  }
  const pathOf = (s) => (s.folderPath ? `${s.folderPath}/${s.name}` : s.name);
  out.sort((a, b) => {
    const pa = pathOf(a);
    const pb = pathOf(b);
    if (pa !== pb) return pa < pb ? -1 : 1;
    const ia = String(a.internalId);
    const ib = String(b.internalId);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
  return out;
};

/**
 * Map of an account's cached sources keyed by internalId to their modified
 * timestamps.
 * @param {string} accountId
 * @returns {Promise<Map<string, {modified: string}>>}
 */
export const getSourceMetaMap = async (accountId) => {
  const sources = await getAllSources(accountId);
  const map = new Map();
  for (const value of sources) {
    if (value) {
      map.set(String(value.internalId), { modified: value.modified });
    }
  }
  return map;
};

/**
 * Remove one account's cached index (meta, inventory, source shards) in a
 * single remove call.
 * @param {string} accountId
 * @returns {Promise<void>}
 */
export const clearAccountCache = async (accountId) => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(
    (k) =>
      k === metaKey(accountId) ||
      k === invKey(accountId) ||
      k.startsWith(srcPrefixFor(accountId))
  );
  await chrome.storage.local.remove(keys);
};

/**
 * Labels of every account that has a cached index.
 * @returns {Promise<string[]>}
 */
export const getCachedAccountIds = async () => {
  const all = await chrome.storage.local.get(null);
  const ids = [];
  for (const key of Object.keys(all)) {
    if (key.startsWith(`${META}.`)) ids.push(key.slice(META.length + 1));
  }
  return ids;
};

/**
 * Remove every account's cached index.
 * @returns {Promise<void>}
 */
export const clearAllCaches = async () => {
  const ids = await getCachedAccountIds();
  for (const id of ids) {
    await clearAccountCache(id);
  }
};

/**
 * Summary of every account with cached index data, sorted by most recently
 * updated meta first. Groups the single storage dump by account label:
 * "ssnav.meta.<label>", "ssnav.inventory.<label>", and
 * "ssnav.src.<label>:<internalId>" shard keys.
 * @returns {Promise<{ accountId: string, meta: IndexMeta | null, shardCount: number, bytes: number }[]>}
 */
export const getCachedAccounts = async () => {
  const all = await chrome.storage.local.get(null);
  /** @type {Map<string, { meta: IndexMeta | null, shardCount: number, bytes: number }>} */
  const accounts = new Map();
  const entryFor = (label) => {
    let entry = accounts.get(label);
    if (!entry) {
      entry = { meta: null, shardCount: 0, bytes: 0 };
      accounts.set(label, entry);
    }
    return entry;
  };
  for (const [key, value] of Object.entries(all)) {
    /** @type {string | null} */
    let label = null;
    if (key.startsWith(`${META}.`)) {
      label = key.slice(META.length + 1);
    } else if (key.startsWith(`${INVENTORY}.`)) {
      label = key.slice(INVENTORY.length + 1);
    } else if (key.startsWith(SRC_PREFIX)) {
      const rest = key.slice(SRC_PREFIX.length);
      const colon = rest.indexOf(":");
      if (colon > 0) label = rest.slice(0, colon);
    }
    if (label === null) continue;
    const entry = entryFor(label);
    if (key === metaKey(label)) entry.meta = value;
    else if (key.startsWith(srcPrefixFor(label))) entry.shardCount++;
    entry.bytes += JSON.stringify(value).length;
  }
  return [...accounts.entries()]
    .map(([accountId, { meta, shardCount, bytes }]) => ({
      accountId,
      meta,
      shardCount,
      bytes,
    }))
    .sort((a, b) => (b.meta?.updatedAt || 0) - (a.meta?.updatedAt || 0));
};

/**
 * One-shot migration of the pre-per-account cache layout into per-account
 * keys. Called once at service-worker startup (top-level await in
 * background.js). It is idempotent: once the legacy slot keys are gone the
 * quick check below returns immediately.
 *
 * Legacy slots:
 *   "ssnav.meta" / "ssnav.inventory" / "ssnav.src.<internalId>"
 *       → primary slot (moved to the account named in its meta)
 *   "ssnav.comparison.account" / "ssnav.comparison.meta" /
 *       "ssnav.comparison.inventory" / "ssnav.comparison.src.<internalId>"
 *       → comparison slot (moved to the account in its meta, or the stored
 *         comparison account)
 * Slots with no resolvable account are deleted. If both slots map to the
 * same account, the comparison move runs second and its same-named keys win
 * (acceptable).
 * @returns {Promise<void>}
 */
export const migrateLegacyCache = async () => {
  const slotKeys = [META, INVENTORY, COMPARISON_META, COMPARISON_INVENTORY, COMPARISON_ACCOUNT];
  const probe = await chrome.storage.local.get(slotKeys);
  // Quick check: no legacy slot key present at all → nothing to migrate.
  if (!slotKeys.some((k) => probe[k] !== undefined)) return;

  const all = await chrome.storage.local.get(null);
  // Legacy flat shard keys: the remainder after "ssnav.src." contains no ":"
  // (per-account shard keys are "ssnav.src.<label>:<internalId>").
  const legacySrcKeys = Object.keys(all).filter(
    (k) => k.startsWith(SRC_PREFIX) && !k.slice(SRC_PREFIX.length).includes(":")
  );
  const legacyCompSrcKeys = Object.keys(all).filter((k) =>
    k.startsWith(COMPARISON_SRC_PREFIX)
  );

  let shardsMoved = 0;

  /**
   * Move one legacy slot into per-account keys, or delete its keys when no
   * account label can be determined.
   * @param {string} slotMetaKey - Legacy meta key.
   * @param {string} slotInvKey - Legacy inventory key.
   * @param {string} srcPrefix - Prefix of this slot's legacy shard keys.
   * @param {string[]} srcKeys - This slot's legacy shard keys.
   * @param {string|null} account - Target account label, or null.
   */
  const moveSlot = async (slotMetaKey, slotInvKey, srcPrefix, srcKeys, account) => {
    const meta = probe[slotMetaKey];
    const inv = probe[slotInvKey];
    if (!account) {
      // Un-migratable without an account label — drop the legacy keys.
      await chrome.storage.local.remove([slotMetaKey, slotInvKey, ...srcKeys]);
      return;
    }
    const patch = {};
    if (meta !== undefined) patch[metaKey(account)] = meta;
    if (inv !== undefined) patch[invKey(account)] = inv;
    for (const k of srcKeys) {
      patch[srcKey(account, k.slice(srcPrefix.length))] = all[k];
      shardsMoved++;
    }
    if (Object.keys(patch).length) await chrome.storage.local.set(patch);
    await chrome.storage.local.remove([slotMetaKey, slotInvKey, ...srcKeys]);
  };

  const primaryMeta = probe[META];
  await moveSlot(
    META,
    INVENTORY,
    SRC_PREFIX,
    legacySrcKeys,
    primaryMeta && primaryMeta.accountId ? primaryMeta.accountId : null
  );
  await moveSlot(
    COMPARISON_META,
    COMPARISON_INVENTORY,
    COMPARISON_SRC_PREFIX,
    legacyCompSrcKeys,
    probe[COMPARISON_META]?.accountId || probe[COMPARISON_ACCOUNT] || null
  );

  // Delete the legacy slot keys either way.
  await chrome.storage.local.remove(slotKeys);

  console.info(
    `[ssnav] Legacy cache migration: moved ${shardsMoved} source shard(s) to per-account keys.`
  );
};

/**
 * Estimate storage usage for the extension's data.
 * @returns {Promise<{bytes: number, quota: number, ratio: number, unlimited: boolean}>}
 */
export const getUsage = async () => {
  const manifest = chrome.runtime.getManifest();
  const unlimited = (manifest.permissions || []).includes("unlimitedStorage");

  const quota = unlimited
    ? Number.POSITIVE_INFINITY
    : chrome.storage.local.QUOTA_BYTES || 10 * 1024 * 1024;

  let bytes = 0;
  try {
    bytes = await chrome.storage.local.getBytesInUse(null);
  } catch {
    bytes = 0;
  }
  const ratio = Number.isFinite(quota) && quota ? bytes / quota : 0;
  return { bytes, quota, ratio, unlimited };
};

/**
 * Find a source record in an array by matching folder path + file name.
 * @param {SourceRecord[]} sources
 * @param {string} folderPath
 * @param {string} name
 * @returns {SourceRecord | undefined}
 */
export const findSourceByPath = (sources, folderPath, name) => {
  return sources.find(
    (s) => s.folderPath === folderPath && s.name === name
  );
};

// ---------------------------------------------------------------------------
// Diff state management
// ---------------------------------------------------------------------------

/**
 * Get the diff state object (base account label + origin). Backward
 * compatible with the legacy plain-string value, which normalizes to
 * { label: value, origin: null }.
 * @returns {Promise<{ label: string, origin: string | null } | null>}
 */
export const getDiffStateObj = async () => {
  const res = await chrome.storage.local.get(DIFF_STATE);
  const value = res[DIFF_STATE];
  if (!value) return null;
  if (typeof value === "string") return { label: value, origin: null };
  if (value && typeof value === "object" && value.label) {
    return { label: String(value.label), origin: value.origin || null };
  }
  return null;
};

/**
 * Get the diff state (base account label for diff operations).
 * @returns {Promise<string | null>} The diff base account label, or null.
 */
export const getDiffState = async () => {
  const obj = await getDiffStateObj();
  return obj ? obj.label : null;
};

/**
 * Set the diff base account.
 * @param {string} accountId - The account label to set as diff base.
 * @param {string} [origin] - NetSuite origin of the base account (used for remote pulls).
 * @returns {Promise<string>}
 */
export const setDiffState = async (accountId, origin) => {
  const label = String(accountId);
  await chrome.storage.local.set({
    [DIFF_STATE]: { label, origin: origin || null, setAt: Date.now() },
  });
  return label;
};

/**
 * Clear the diff state (the base account designation). The base account's
 * per-account cache is NOT cleared — it stays available for search and
 * diffing; clearing the designation only removes the base marker.
 * @returns {Promise<void>}
 */
export const clearDiffState = async () => {
  await chrome.storage.local.remove([DIFF_STATE]);
};
