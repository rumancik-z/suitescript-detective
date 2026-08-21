// accounts.js — cached-accounts view (fetch + render only; no popup state).
//
// Data comes from the worker's GET_CACHED_ACCOUNTS message; interaction is
// delegated through a handler map supplied by popup.js.

import { MSG } from "../lib/constants.js";

/**
 * Best-known origin for an account label (labels look like "1234567-sb1").
 * Prefers the origin stored in the account's index meta (correct for
 * non-standard hosts); falls back to synthesizing the standard URL.
 * Pass-through for values that already look like origins.
 * @param {string} label
 * @param {string} [storedOrigin] - Origin persisted in the account's meta.
 * @returns {string}
 */
export const accountOriginFor = (label, storedOrigin = "") =>
  storedOrigin ||
  (label && !/^https?:\/\//i.test(label)
    ? `https://${label}.app.netsuite.com`
    : label) || "";

/**
 * Ask the worker for the list of currently cached accounts.
 * @param {string} [origin] hint for resolving the current account
 * @returns {Promise<object>} CACHED_ACCOUNTS response
 */
export const loadAccounts = async (origin) =>
  chrome.runtime.sendMessage({ type: MSG.GET_CACHED_ACCOUNTS, origin });

const fmtBytes = (n) => {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};

const fmtWhen = (ts) => {
  if (!ts) return "never";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const STATUS_BADGE = {
  ready: ["badge-ready", "ready"],
  inventory: ["badge-build", "pulling inventory"],
  content: ["badge-build", "pulling sources"],
  cancelled: ["badge-cancelled", "cancelled"],
};

/**
 * Render the cached-accounts list.
 * @param {HTMLElement} listEl #accounts-list
 * @param {HTMLElement} usageEl #accounts-usage
 * @param {HTMLElement} footerEl #accounts-footer
 * @param {object} data CACHED_ACCOUNTS response ({accounts, currentAccount,
 *   diffBase, diffBaseOrigin, usage})
 * @param {object} handlers { onClear(label), onClearAll(), onSetBase(label),
 *   onRefresh(label) }
 */
export const renderAccounts = (listEl, usageEl, footerEl, data, handlers) => {
  void handlers; // actions are delegated via wireAccountsList
  const accounts = data?.accounts || [];
  const usage = data?.usage || { bytes: 0 };

  listEl.textContent = "";

  if (!accounts.length) {
    usageEl.textContent = "";
    footerEl.classList.add("hidden");
    const empty = document.createElement("div");
    empty.className = "accounts-empty";
    empty.textContent =
      "No accounts cached yet. Open a NetSuite tab and click Build.";
    listEl.append(empty);
    return;
  }

  footerEl.classList.remove("hidden");
  usageEl.textContent = `${fmtBytes(usage.bytes)} used by ${accounts.length} account${
    accounts.length === 1 ? "" : "s"
  }`;

  for (const a of accounts) {
    const isCurrent = !!data?.currentAccount && a.accountId === data.currentAccount;
    const isBase = !!data?.diffBase && a.accountId === data.diffBase;
    const building =
      a.meta?.status === "inventory" || a.meta?.status === "content";

    const card = document.createElement("article");
    card.className =
      "account-card" +
      (isCurrent ? " is-current" : "") +
      (isBase ? " is-base" : "");

    const head = document.createElement("div");
    head.className = "account-head";

    const label = document.createElement("span");
    label.className = "account-label";
    label.textContent = a.accountId;
    head.append(label);

    const [badgeCls, badgeText] =
      STATUS_BADGE[a.meta?.status] || ["badge-build", a.meta?.status || "unknown"];
    const badge = document.createElement("span");
    badge.className = `badge ${badgeCls}`;
    badge.textContent = badgeText;
    head.append(badge);

    if (isCurrent) {
      const b = document.createElement("span");
      b.className = "badge badge-current";
      b.textContent = "current tab";
      head.append(b);
    }
    if (isBase) {
      const b = document.createElement("span");
      b.className = "badge badge-base";
      b.textContent = "diff base";
      head.append(b);
    }

    const meta = document.createElement("p");
    meta.className = "account-meta";
    meta.textContent = `${a.meta?.scriptCount ?? 0} scripts · updated ${
      fmtWhen(a.meta?.updatedAt)
    } · ${fmtBytes(a.bytes)}`;

    const actions = document.createElement("div");
    actions.className = "account-actions";
    const mkBtn = (act, text, title, disabled) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-ghost account-btn";
      b.dataset.act = act;
      b.dataset.label = a.accountId;
      b.textContent = text;
      b.title = title;
      b.disabled = !!disabled;
      actions.append(b);
    };
    mkBtn(
      "refresh",
      "Refresh",
      "Re-pull inventory and sources for this account",
      building,
    );
    mkBtn(
      "base",
      isBase ? "Diff base" : "Set as diff base",
      isBase
        ? "This account is the diff base"
        : "Use this account's cache as the diff base",
      isBase,
    );
    mkBtn("clear", "Clear", "Delete this account's cached data");

    card.append(head, meta, actions);
    listEl.append(card);
  }
};

/**
 * Attach one delegated click handler to the accounts list.
 * @param {HTMLElement} listEl
 * @param {object} handlers { onClear(label), onClearAll(), onSetBase(label),
 *   onRefresh(label) }
 */
export const wireAccountsList = (listEl, handlers) => {
  listEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn || btn.disabled) return;
    const fn = {
      refresh: handlers.onRefresh,
      base: handlers.onSetBase,
      clear: handlers.onClear,
    }[btn.dataset.act];
    if (fn) fn(btn.dataset.label);
  });
};
