// lib/accountResolver.js — detect NetSuite account from active tab

import { NETSUITE_HOST_RE } from "./constants.js";

/**
 * Extract account info from a URL string, or null if it is not a NetSuite tab.
 * @param {string} urlString
 * @returns {AccountInfo | null}
 */
export const parseAccountFromUrl = (urlString) => {
  if (!urlString) return null;
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (!NETSUITE_HOST_RE.test(url.hostname)) return null;

  const firstLabel = url.hostname.split(".")[0] || "";
  const idMatch = firstLabel.match(/^(\d+)(?:-[a-z0-9]+)?$/i);
  const accountId = idMatch ? idMatch[1] : firstLabel;

  return {
    baseHost: url.hostname,
    accountId,
    accountLabel: firstLabel,
    origin: `${url.protocol}//${url.hostname}`,
  };
};

// Most-recently-used NetSuite origin, kept in chrome.storage.session so it
// survives popup/worker restarts within a browser session.
const LAST_ACCOUNT_KEY = "ssnav.lastAccount";

// chrome.storage.session is best-effort bookkeeping for account resolution.
// A never-settling promise there (observed in the field — it stuck the
// popup's account label on "Checking…" forever) must not be able to block
// resolution, so every session-storage call is capped.
const SESSION_TIMEOUT_MS = 2000;

/**
 * Wait for a promise, but resolve with null after ms instead of hanging.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T | null>}
 */
const settleWithin = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);

/**
 * Record the most recently used NetSuite origin. Makes later resolution
 * deterministic when no NetSuite tab is active (e.g. the extension's own
 * full tabs), matching the account the popup just used.
 * @param {string} origin - NetSuite origin URL (e.g. https://123456-sb1.app.netsuite.com).
 * @returns {Promise<void>}
 */
export const recordLastAccount = async (origin) => {
  try {
    await settleWithin(
      chrome.storage.session.set({ [LAST_ACCOUNT_KEY]: origin }),
      SESSION_TIMEOUT_MS
    );
  } catch {
    /* session storage unavailable — ignore */
  }
};

/**
 * Resolve the current NetSuite account, in order:
 *   1. the active tab, if it is a NetSuite tab;
 *   2. the most-recently-used origin recorded by recordLastAccount();
 *   3. the first open NetSuite tab (last-resort fallback).
 * Steps 2-3 matter when the extension runs in its own full tabs, where the
 * active tab is the extension page and "first NetSuite tab" is arbitrary.
 * @returns {Promise<AccountInfo | null>}
 */
export const resolveAccount = async () => {
  // tab.url visibility for these queries comes from the manifest host_permissions
  // (https://*.netsuite.com/*), not a `tabs` permission; non-NetSuite tabs have
  // tab.url undefined, which parseAccountFromUrl already treats as "not NetSuite".
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  const fromActive = parseAccountFromUrl(activeTab?.url);
  if (fromActive) return fromActive;

  let lastOrigin = null;
  try {
    const res = await settleWithin(
      chrome.storage.session.get(LAST_ACCOUNT_KEY),
      SESSION_TIMEOUT_MS
    );
    lastOrigin = res ? res[LAST_ACCOUNT_KEY] || null : null;
  } catch {
    /* session storage unavailable — ignore */
  }
  const fromLast = lastOrigin ? parseAccountFromUrl(lastOrigin) : null;
  if (fromLast) return fromLast;

  const netsuiteTabs = await chrome.tabs.query({ url: "https://*.netsuite.com/*" });
  for (const tab of netsuiteTabs) {
    const info = parseAccountFromUrl(tab.url);
    if (info) return info;
  }

  return null;
};

