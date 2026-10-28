// Muse Dashboard · lib/spend.js
// Author: Adam S. Barnett
//
// Token spend per project folder, and the dollar estimate built from the
// user's own price table. Meta publishes no prices through its API (checked
// 2026-10-27: model/list cost = null on the subscription and on the API key;
// no usage, billing or credit endpoint; completions carry token counts only),
// so the dashboard records facts (tokens per model, under the connection each
// step ran on) and prices them at display time with whatever the user typed
// in Settings. Only API-key use becomes dollars: the subscription is a flat fee.
import path from "node:path";

export const SPEND_MODES = ["api", "sub"];

/** One key per folder, however a chat spelled its path. */
export function folderKey(p) {
  const r = path.resolve(String(p));
  return process.platform === "win32" ? r.toLowerCase() : r;
}

export const emptySpend = (folder) => ({ folder, api: {}, sub: {}, updatedAt: null });

/** Add one step's tokens ([fresh, cached, output]) to a folder's record. Returns the same object when nothing was added. */
export function addTokens(entry, mode, modelId, tokens) {
  const base = entry && typeof entry === "object" ? entry : emptySpend("");
  if (!SPEND_MODES.includes(mode) || typeof modelId !== "string" || !modelId) return base;
  const add = [0, 1, 2].map((i) => Math.max(0, Math.round(Number(tokens?.[i]) || 0)));
  if (!add.some(Boolean)) return base;
  const cur = base[mode]?.[modelId] || [0, 0, 0];
  return { ...base, [mode]: { ...(base[mode] || {}), [modelId]: cur.map((v, i) => (Number(v) || 0) + add[i]) }, updatedAt: new Date().toISOString() };
}

/**
 * The price table as saved: { enabled, updatedAt, models: { id: { input, cached, output } } },
 * USD per 1 million tokens. Rows with no number at all are dropped; a bad number throws.
 */
export function normalizePrices(input, now = new Date()) {
  const src = input && typeof input === "object" ? input : {};
  const models = {};
  for (const [id, row] of Object.entries(src.models && typeof src.models === "object" ? src.models : {})) {
    if (!id.trim() || !row || typeof row !== "object") continue;
    const out = {};
    for (const k of ["input", "cached", "output"]) {
      const v = row[k];
      if (v === undefined || v === null || v === "") continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${id}: ${k} price must be a number of dollars per 1M tokens (got ${JSON.stringify(v)}).`);
      out[k] = n;
    }
    if (Object.keys(out).length) models[id.trim()] = out;
  }
  const prev = src.updatedAt || null;
  return { enabled: src.enabled !== false, updatedAt: src.touch ? now.toISOString() : prev, models }; // on unless switched off: Muse's catalog supplies prices
}

/** One record out of several ({ api, sub } maps summed per model): every project folder together, for the sidebar total. */
export function sumEntries(entries) {
  const out = emptySpend("");
  for (const e of entries) for (const mode of SPEND_MODES) for (const [id, t] of Object.entries(e?.[mode] || {})) out[mode][id] = (out[mode][id] || [0, 0, 0]).map((v, i) => v + (Number(t[i]) || 0));
  return out;
}

/**
 * Prices Muse reports from Meta's catalog (model/list cost blocks: decimal
 * strings per 1M tokens), as a price table { id: { input, cached, output } }.
 * Rows without a cost block are left out, so a late catalog never erases
 * prices seen earlier.
 */
export function catalogPrices(models) {
  const out = {};
  for (const m of Array.isArray(models) ? models : []) {
    const c = m?.cost;
    if (!m?.modelId || !c || typeof c !== "object") continue;
    const row = {};
    for (const k of ["input", "cached", "output"]) { const n = Number(c[k]); if (c[k] !== null && c[k] !== undefined && c[k] !== "" && Number.isFinite(n) && n >= 0) row[k] = n; }
    if (Object.keys(row).length) out[m.modelId] = row;
  }
  return out;
}

/** The table estimates use: the user's numbers where typed, Meta's catalog where not. */
export function mergePrices(user, catalog) {
  const models = {};
  for (const id of new Set([...Object.keys(catalog || {}), ...Object.keys(user || {})])) {
    const row = { ...(catalog?.[id] || {}), ...(user?.[id] || {}) };
    if (Object.keys(row).length) models[id] = row;
  }
  return { models };
}

const sum = (rows) => Object.values(rows || {}).reduce((t, v) => [t[0] + (Number(v[0]) || 0), t[1] + (Number(v[1]) || 0), t[2] + (Number(v[2]) || 0)], [0, 0, 0]);

/**
 * Dollars for a folder's API-key use from the price table: { usd, partial,
 * missing: [modelIds with no price], models: { id: { usd, tokens } }, tokens:
 * { api: [fresh, cached, output], sub: [...] } }. A model with a partial
 * price row is priced for the parts it has and listed as missing.
 */
export function estimate(entry, prices) {
  const api = entry?.api || {};
  const table = prices?.models || {};
  const models = {};
  const missing = [];
  let usd = 0;
  for (const [id, t] of Object.entries(api)) {
    const p = table[id] || {};
    const parts = [["input", 0], ["cached", 1], ["output", 2]];
    let m = 0;
    let gap = false;
    for (const [k, i] of parts) {
      if (typeof p[k] === "number") m += ((Number(t[i]) || 0) / 1e6) * p[k];
      else if (Number(t[i]) > 0) gap = true;
    }
    if (gap) missing.push(id);
    models[id] = { usd: m, tokens: t };
    usd += m;
  }
  return { usd, partial: missing.length > 0, missing, models, tokens: { api: sum(api), sub: sum(entry?.sub) } };
}

/** "$3.42", "$12.3", "$120", "<$0.01", "$0.00". */
export function fmtUsd(usd) {
  const n = Number(usd) || 0;
  if (n >= 100) return `$${Math.round(n).toLocaleString()}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return n > 0 ? "<$0.01" : "$0.00";
}
