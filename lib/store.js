// Muse Dashboard · lib/store.js
// Author: Adam S. Barnett
//
// The dashboard's own small index (data/index.json): chat titles, folders,
// hidden flags, per-chat settings, token totals, token spend per project
// folder with the price table that turns it into estimates, Settings-page
// choices and recent folders. The conversations themselves live in Muse's
// session logs, which this app never writes or deletes. Every change is saved
// with an atomic rename.
import path from "node:path";
import { readJson, writeJsonAtomic, samePath } from "./util.js";
import { folderKey, emptySpend, addTokens, normalizePrices, catalogPrices } from "./spend.js";

export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, "index.json");
    this.data = { chats: {}, recents: [], spend: {}, prices: normalizePrices(null), catalog: { at: null, models: {} }, settings: {} };
    this.saving = Promise.resolve();
  }

  async load() {
    const d = await readJson(this.file, null);
    if (d && typeof d === "object") {
      this.data.chats = d.chats && typeof d.chats === "object" ? d.chats : {};
      this.data.recents = Array.isArray(d.recents) ? d.recents.filter((r) => typeof r === "string") : [];
      if (typeof d.projectsDir === "string") this.data.projectsDir = d.projectsDir; // where Projects/ was last time (moves)
      this.data.spend = d.spend && typeof d.spend === "object" ? d.spend : {}; // token spend per project folder (lib/spend.js)
      try { this.data.prices = normalizePrices(d.prices); } catch { this.data.prices = normalizePrices(null); }
      // An "off" that was never saved from Settings (no stamp) is a default, not a choice: estimates are on.
      if (!this.data.prices.updatedAt) this.data.prices.enabled = true;
      this.data.settings = d.settings && typeof d.settings === "object" ? d.settings : {}; // Settings-page choices that override config.json (e.g. musePreset)
      this.data.catalog = d.catalog && typeof d.catalog?.models === "object" ? { at: d.catalog.at || null, models: d.catalog.models } : { at: null, models: {} }; // prices last seen in Muse's model catalog
    }
  }

  /** Saves are queued so two quick changes can never write out of order. */
  save() {
    const snapshot = JSON.parse(JSON.stringify(this.data));
    this.saving = this.saving.then(() => writeJsonAtomic(this.file, snapshot)).catch((e) => console.error("index save failed:", e.message));
    return this.saving;
  }

  chat(id) {
    return this.data.chats[id];
  }

  upsertChat(id, patch) {
    const cur = this.data.chats[id] || { id, createdAt: new Date().toISOString(), hidden: false };
    this.data.chats[id] = { ...cur, ...patch, id };
    void this.save();
    return this.data.chats[id];
  }

  removeChat(id) {
    delete this.data.chats[id];
    void this.save();
  }

  /** Permanent delete: keep only a tombstone so Muse's session list cannot resurrect the chat in the sidebar. */
  markDeleted(id) {
    const cur = this.data.chats[id];
    this.data.chats[id] = { id, createdAt: cur?.createdAt || new Date().toISOString(), deleted: true, hidden: true };
    void this.save();
    return this.data.chats[id];
  }

  /** A draft got its real Muse session id: move the record over. */
  rekey(from, to, patch = {}) {
    const cur = this.data.chats[from] || { createdAt: new Date().toISOString(), hidden: false };
    delete this.data.chats[from];
    this.data.chats[to] = { ...cur, ...patch, id: to };
    void this.save();
    return this.data.chats[to];
  }

  /** A folder's token record, or null. */
  spendOf(workspace) {
    return workspace ? this.data.spend[folderKey(workspace)] || null : null;
  }

  /** Add one step's tokens to the folder's record; returns the record, or null when nothing was added. */
  addSpend(workspace, mode, modelId, tokens) {
    const key = folderKey(workspace);
    const cur = this.data.spend[key] || emptySpend(path.resolve(workspace));
    const next = addTokens(cur, mode, modelId, tokens);
    if (next === cur) return null;
    this.data.spend[key] = next;
    void this.save();
    return next;
  }

  /** The folder is gone (deleted from the dashboard): its record goes with it. */
  removeSpend(workspace) {
    if (!workspace) return;
    delete this.data.spend[folderKey(workspace)];
    void this.save();
  }

  /** Every model id that has tokens recorded, so the price table can list models no longer offered. */
  spentModels() {
    const ids = new Set();
    for (const e of Object.values(this.data.spend)) for (const mode of ["api", "sub"]) for (const id of Object.keys(e[mode] || {})) ids.add(id);
    return [...ids];
  }

  /** Keep the prices Muse's model catalog reports (it has none right after a host starts, so earlier ones are never erased). */
  rememberCatalog(models) {
    const seen = catalogPrices(models);
    if (!Object.keys(seen).length) return false;
    const next = { ...this.data.catalog.models, ...seen };
    const changed = JSON.stringify(next) !== JSON.stringify(this.data.catalog.models);
    this.data.catalog = { at: new Date().toISOString(), models: next };
    if (changed) void this.save();
    return changed;
  }

  setSetting(key, value) {
    this.data.settings = { ...this.data.settings, [key]: value };
    void this.save();
  }

  setPrices(prices) {
    this.data.prices = prices;
    void this.save();
  }

  addRecent(folder) {
    this.data.recents = [folder, ...this.data.recents.filter((r) => !samePath(r, folder))].slice(0, 12);
    void this.save();
  }

  removeRecent(folder) {
    this.data.recents = this.data.recents.filter((r) => !samePath(r, folder));
    void this.save();
  }

  /**
   * Folders under `from` now live at the same place under `to` (the dashboard folder was moved).
   * A path changes only when the old one is gone and the new one exists. Returns how many chats moved.
   */
  rebase(from, to, exists) {
    const map = (p) => {
      if (typeof p !== "string") return null;
      const rel = path.relative(from, p);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
      const q = path.join(to, rel);
      return !exists(p) && exists(q) ? q : null;
    };
    let moved = 0;
    for (const c of Object.values(this.data.chats)) {
      const w = map(c.workspace);
      if (w) { c.workspace = w; moved++; }
      for (const k of ["dir", "root"]) { const s = c.snapshot && map(c.snapshot[k]); if (s) c.snapshot[k] = s; }
    }
    this.data.recents = this.data.recents.map((r) => map(r) || r);
    void this.save();
    return moved;
  }
}
