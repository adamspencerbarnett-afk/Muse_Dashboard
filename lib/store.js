// Muse Dashboard · lib/store.js
// Author: Adam S. Barnett
//
// The dashboard's own small index (data/index.json): chat titles, folders,
// hidden flags, per-chat settings, token totals and recent folders. The
// conversations themselves live in Muse's session logs, which this app never
// writes or deletes. Every change is saved with an atomic rename.
import path from "node:path";
import { readJson, writeJsonAtomic, samePath } from "./util.js";

export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, "index.json");
    this.data = { chats: {}, recents: [] };
    this.saving = Promise.resolve();
  }

  async load() {
    const d = await readJson(this.file, null);
    if (d && typeof d === "object") {
      this.data.chats = d.chats && typeof d.chats === "object" ? d.chats : {};
      this.data.recents = Array.isArray(d.recents) ? d.recents.filter((r) => typeof r === "string") : [];
      if (typeof d.projectsDir === "string") this.data.projectsDir = d.projectsDir; // where Projects/ was last time (moves)
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
