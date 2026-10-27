// Muse Dashboard · public/app.js
// Author: Adam S. Barnett
//
// The whole front end, in plain JavaScript with no build step. It talks to
// server.js through the JSON API and one Server-Sent Events stream, and draws
// the sidebar (chats, subscription usage), the conversation, the Activity
// panel, approvals, the New-chat and folder dialogs, Settings, and the Muse
// Code connection dialog. Markdown is rendered with marked and sanitized with
// DOMPurify; code is highlighted with highlight.js (all served locally).
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const state = {
    env: null,
    chats: [],
    currentId: null, // a Muse session id, or "draft" for an unsent new chat
    current: null, // { id, workspace, title, hidden, model, draft }
    draft: null, // { serverId, workspace, autoFolder, text, attachments } while a new chat has not been sent
    lastModel: null,
    defaults: loadDefaults(), // { reasoningEffort: "medium", approvalMode: "allowAll" } unless the user changed them in Settings
    items: new Map(), // itemId -> item (ordered by insertion)
    nodes: new Map(), // itemId -> DOM row
    approvals: new Map(), // key -> request
    activeTurnId: null,
    attachments: [], // { id, kind: 'path'|'image', name, path, isDir, size, copied, mediaType, base64Data, status, thumb }
    running: new Set(), // sessionIds with a running turn
    agentsRunning: new Set(), // sessionIds whose subagents/workflows are still working (they outlive the turn)
    agentStats: null, // { turnId, active, count, input, cached, output } latest for the open chat
    attention: new Set(), // sessionIds with a pending approval
    showHidden: false,
    showOther: false,
    models: [], // last model/list rows for the header picker
    renderQueued: new Set(),
    activityIds: new Set(), // itemIds of the rows in the Activity panel (its count badge)
    activityOpen: true, // Activity panel visible; tool calls and to-dos live there, not in the chat flow
    turnStats: null, // { turnId, steps, input, cached, output } of the open chat's running reply
    earlierCursor: null, // where "Load earlier" continues in the open chat's history
    warmed: new Set(), // chats already prewarmed from this page (hover or typing)
    restarting: false, // Settings > Restart is in progress: reload instead of showing "stopped"
  };

  /** Transcript kinds that render in the Activity panel instead of the conversation. */
  const ACTIVITY_KINDS = new Set(["toolCall", "userShell", "webSearch", "subagent", "workflow"]);

  // ---------- API ----------
  async function api(method, url, body, raw) {
    const opts = { method, headers: { "X-Muse-Dashboard": "1" }, credentials: "same-origin" };
    if (raw !== undefined) opts.body = raw;
    else if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(msg, isError) {
    const t = el("div", `toast${isError ? " error" : ""}`, msg);
    $("toasts").appendChild(t);
    setTimeout(() => t.remove(), isError ? 9000 : 4000);
  }

  /** The start script for this system, named in "stopped" messages. */
  const launcher = () => (state.env && state.env.platform !== "win32" ? "start-dashboard.sh" : "start-dashboard.bat");
  const samePath = (a, b) => (state.env && state.env.platform !== "win32" ? a === b : a.toLowerCase() === b.toLowerCase());
  const baseName = (p) => (p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p || "";
  const fmtNum = (n) => {
    const v = Number(n) || 0;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    return String(v);
  };
  const fmtDuration = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${Math.round(ms / 1000)}s`);
  /**
   * What a chat cost: fresh (uncached) input and output. Cached re-reads of
   * the context are cheap and dwarf both, so they only go in the tooltip.
   */
  function tokenSummary(u, a) {
    const hasAgents = a && (a.input || a.output);
    if ((!u || !u.promptTokens) && !hasAgents) return { text: "no usage yet", title: "" };
    const cached = Number(u && u.cacheReadTokens) || 0;
    const fresh = Math.max(0, (Number(u && u.promptTokens) || 0) - cached);
    const out = Number(u && u.outputTokens) || 0;
    const aFresh = hasAgents ? Math.max(0, a.input - a.cached) : 0;
    const aOut = hasAgents ? a.output : 0;
    let title = `New input ${fresh.toLocaleString()} · output ${out.toLocaleString()} · cached re-reads ${cached.toLocaleString()} (each model step re-sends the whole context; cached re-reads are cheap)`;
    if (hasAgents) title += `\nSubagents (${a.count}): new input ${aFresh.toLocaleString()} · output ${aOut.toLocaleString()} · cached re-reads ${a.cached.toLocaleString()} (included in the totals above the line)`;
    return { text: `${fmtNum(fresh + aFresh)} in · ${fmtNum(out + aOut)} out${hasAgents ? " · 🤖" : ""}`, title };
  }

  // ---------- markdown ----------
  if (window.marked) window.marked.setOptions({ gfm: true, breaks: false });
  function renderMarkdown(target, text, highlight = true) {
    const html = window.marked ? window.marked.parse(text || "") : escapeHtml(text || "");
    target.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } }) : escapeHtml(text || "");
    for (const a of target.querySelectorAll("a")) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
    for (const code of target.querySelectorAll("pre > code")) {
      const pre = code.parentElement;
      const lang = (code.className.match(/language-([\w+#-]+)/) || [])[1] || "";
      if (highlight && window.hljs) {
        try { window.hljs.highlightElement(code); } catch { /* ignore */ }
      }
      const bar = el("div", "code-bar");
      bar.appendChild(el("span", "", lang || "code"));
      const copy = el("button", "copy", "Copy");
      copy.addEventListener("click", () => {
        navigator.clipboard.writeText(code.textContent).then(() => { copy.textContent = "Copied"; setTimeout(() => (copy.textContent = "Copy"), 1500); });
      });
      bar.appendChild(copy);
      pre.insertBefore(bar, code);
    }
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- sidebar ----------
  async function loadChats() {
    try {
      const q = [state.showHidden && "hidden=1", state.showOther && "other=1"].filter(Boolean).join("&");
      const data = await api("GET", `/api/chats${q ? `?${q}` : ""}`);
      state.chats = data.chats;
      if (data.museError) toast(`Could not list Muse sessions: ${data.museError}`, true);
      for (const c of state.chats) if (c.status === "running") state.running.add(c.id);
      renderChatList();
    } catch (e) {
      toast(`Could not load chats: ${e.message}`, true);
    }
  }
  let listTimer = null;
  function loadChatsSoon() {
    clearTimeout(listTimer);
    listTimer = setTimeout(loadChats, 800);
  }

  function groupLabel(iso) {
    if (!iso) return "Older";
    const d = new Date(iso), now = new Date();
    const day = 86400000;
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (d.getTime() >= startToday) return "Today";
    if (d.getTime() >= startToday - day) return "Yesterday";
    if (d.getTime() >= startToday - 7 * day) return "Previous 7 days";
    if (d.getTime() >= startToday - 30 * day) return "Previous 30 days";
    return "Older";
  }

  function renderChatList() {
    const q = $("searchBox").value.trim().toLowerCase();
    const list = $("chatList");
    list.textContent = "";
    let lastGroup = null;
    const rows = state.chats.filter((c) => !(state.draft && c.id === state.draft.serverId));
    if (state.draft) rows.unshift({ id: "draft", title: state.draft.title || "New chat", workspace: state.draft.workspace, updatedAt: new Date().toISOString(), draft: true });
    for (const c of rows) {
      if (q && !(`${c.title} ${c.workspace || ""}`.toLowerCase().includes(q))) continue;
      const g = groupLabel(c.updatedAt);
      if (g !== lastGroup) { list.appendChild(el("div", "group-label", g)); lastGroup = g; }
      const item = el("div", `chat-item${c.id === state.currentId ? " active" : ""}${c.hidden || c.other ? " is-hidden" : ""}${c.draft ? " draft" : ""}`);
      const tt = el("div", "t ci-title", c.title);
      item.appendChild(tt);
      const usage = tokenSummary(c.tokenUsage, c.agentUsage);
      item.appendChild(el("div", "sub", c.draft && !c.workspace ? "new chat folder" : usage.text));
      item.title = [c.title, c.workspace || "", usage.title, c.other && "From outside this dashboard (terminal or another copy)"].filter(Boolean).join("\n");
      if (state.attention.has(c.id)) item.appendChild(el("span", "dot attn"));
      else if (state.running.has(c.id) || state.agentsRunning.has(c.id)) item.appendChild(el("span", "dot"));
      if (c.id !== "draft") {
        const mb = el("button", "menu-btn", "⋯");
        mb.title = "Chat options";
        mb.addEventListener("click", (ev) => { ev.stopPropagation(); openMenu(ev, c); });
        item.appendChild(mb);
      }
      item.dataset.id = c.id;
      item.addEventListener("click", () => (c.id === "draft" ? openDraft() : openChat(c.id)));
      if (!c.draft) {
        // Resting on a chat for a moment opens its history in Muse ahead of the click.
        let hover = null;
        item.addEventListener("mouseenter", () => { hover = setTimeout(() => warmChat(c.id, false), 250); });
        item.addEventListener("mouseleave", () => clearTimeout(hover));
      }
      list.appendChild(item);
    }
    if (!list.children.length) list.appendChild(el("div", "group-label", q ? "No matches" : "No chats yet"));
  }

  function openMenu(ev, chat) {
    closeMenu();
    const m = el("div", "menu");
    m.id = "ctxMenu";
    const add = (label, fn) => { const b = el("button", "", label); b.addEventListener("click", () => { closeMenu(); fn(); }); m.appendChild(b); return b; };
    add("Rename", () => renameChat(chat.id, chat.title));
    if (chat.hidden) add("Unhide", () => setHidden(chat.id, false));
    else add("Hide from dashboard", () => setHidden(chat.id, true));
    if (chat.snapshotAt) add("Undo changes since snapshot…", () => undoSnapshot(chat)).title = `Put the folder back the way it was at the snapshot (${new Date(chat.snapshotAt).toLocaleString()}).`;
    add("Remove", () => removeChat(chat, false)).title = chat.inProjects || !chat.workspace
      ? "Remove the chat from the dashboard. Its folder and files are kept."
      : "Remove the chat from the dashboard. Its folder is yours: the dashboard never deletes folders opened from outside its Projects folder.";
    // Only folders the dashboard made (inside Projects) can be deleted, and they go to the Recycle Bin.
    if (chat.inProjects) add("Delete…", () => removeChat(chat, true)).title = `Delete the chat. Its Projects folder goes to the ${binName()}, where you can restore it.`;
    add("Copy folder path", () => navigator.clipboard.writeText(chat.workspace || ""));
    document.body.appendChild(m);
    const r = ev.target.getBoundingClientRect();
    m.style.left = `${Math.min(r.left, window.innerWidth - 180)}px`;
    m.style.top = `${r.bottom + 4}px`;
    setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
  }
  function closeMenu() { const m = $("ctxMenu"); if (m) m.remove(); }

  async function renameChat(id, current) {
    const title = prompt("Rename chat", current || "");
    if (title === null) return;
    try {
      await api("PATCH", `/api/chats/${id}`, { title });
      if (state.current && state.current.id === id) { state.current.title = title.trim() || state.current.title; $("chatTitle").textContent = state.current.title; }
      loadChats();
    } catch (e) { toast(e.message, true); }
  }
  async function undoSnapshot(chat) {
    const yes = await askYesNo({
      title: `Undo all changes since the snapshot?`,
      text: `Everything changed, added or deleted in this folder since ${new Date(chat.snapshotAt).toLocaleString()} goes back to how it was, whether Muse or you made the change:\n\n${chat.workspace || ""}\n\nFiles Git ignores (like node_modules) are not touched. The current state is saved in Git first, so this can be reversed by hand. Proceed?`,
      yes: "Yes, undo",
      no: "No",
      danger: true,
    });
    if (!yes) return;
    try {
      const r = await api("POST", `/api/chats/${chat.id}/undo-snapshot`);
      toast(`Folder restored to the snapshot: ${r.restored} file${r.restored === 1 ? "" : "s"} put back, ${r.removed} added file${r.removed === 1 ? "" : "s"} removed.`);
    } catch (e) {
      toast(e.message, true);
    }
  }
  const binName = () => (state.env && state.env.platform && state.env.platform !== "win32" ? "Trash" : "Recycle Bin");
  const fmtBytes = (n) => {
    const units = ["bytes", "KB", "MB", "GB", "TB"];
    let v = Number(n) || 0, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${i ? v.toFixed(v < 10 ? 1 : 0) : v} ${units[i]}`;
  };
  /** The Delete dialog for a Projects folder: Recycle Bin when it fits, otherwise an explicit "delete permanently". Resolves to the DELETE query, or null. */
  async function confirmDelete(chat) {
    let c;
    try { c = await api("GET", `/api/chats/${chat.id}/delete-check`); } catch (e) { toast(e.message, true); return null; }
    if (!c.folder) {
      const ok = await askYesNo({ title: `Delete "${chat.title}"?`, text: "This chat's folder no longer exists, so only the chat is removed from the dashboard.", yes: "Delete", no: "Cancel" });
      return ok ? "" : null;
    }
    if (c.block) { toast(`This folder cannot be deleted: ${c.block}.`, true); return null; }
    const size = `${fmtNum(c.files)} file${c.files === 1 ? "" : "s"}, ${fmtBytes(c.bytes)}`;
    if (c.bin === "fits" || c.bin === "unknown") {
      const ok = await askYesNo({
        title: `Delete "${chat.title}"?`,
        text: `The chat is deleted and its folder goes to the ${c.binName}, where you can restore it:\n\n${c.folder}\n(${size})${c.bin === "unknown" ? `\n\nWindows did not say how much its ${c.binName} holds. If it cannot keep the folder and deletes it for good, the dashboard tells you.` : ""}`,
        yes: `Move to ${c.binName}`,
        no: "Cancel",
        danger: true,
      });
      return ok ? "?folder=recycle" : null;
    }
    const why = c.bin === "tooLarge"
      ? `This folder (${fmtBytes(c.bytes)}) is larger than the ${c.binName} on its drive can hold (${fmtBytes(c.binMaxBytes)}), so Windows cannot keep it there.`
      : `This folder's drive has no ${c.binName} (or it is set to delete files at once), so Windows cannot keep it there.`;
    const ok = await askYesNo({
      title: `Delete "${chat.title}" permanently?`,
      text: `${why}\n\n${c.folder}\n(${size})\n\nDeleting it now is permanent: it could not be restored. Cancel to keep it (you can copy what you need first, or delete it yourself later).`,
      yes: "Delete permanently",
      no: "Cancel",
      danger: true,
    });
    return ok ? "?folder=recycle&permanent=1" : null;
  }
  /** Remove (withFolder false): off the dashboard, folder kept. Delete (true): a Projects folder goes to the Recycle Bin. */
  async function removeChat(chat, withFolder) {
    const folder = chat.workspace || "";
    let query = "";
    if (withFolder) {
      query = await confirmDelete(chat);
      if (query === null) return;
    } else if (!(await askYesNo({
      title: `Remove "${chat.title}"?`,
      text: `The chat is removed from the dashboard.${folder ? ` Its folder and everything in it stay on this computer:\n\n${folder}` : ""}`,
      yes: "Remove",
      no: "Cancel",
    }))) return;
    try {
      const r = await api("DELETE", `/api/chats/${chat.id}${query}`);
      if (state.draft && state.draft.serverId === chat.id) { state.draft = null; state.currentId = null; openDraft(); }
      else if (state.currentId === chat.id) openDraft();
      await loadChats();
      if (r.deletedFolder && r.inBin) toast(`Deleted. The folder is in the ${r.binName}; restore it from there if you need it: ${r.deletedFolder}`);
      else if (r.deletedFolder && r.chosenPermanent) toast(`Deleted permanently: ${r.deletedFolder}`);
      else if (r.deletedFolder) {
        await askYesNo({ title: "The folder was deleted permanently", text: `Windows did not keep the folder in the ${r.binName}: it deleted it for good (it was too large for the ${r.binName}, or its drive has none). It cannot be restored from there:\n\n${r.deletedFolder}`, yes: "OK", no: null });
      }
      else toast(r.keptFolder ? `Removed. Folder kept: ${r.keptFolder}` : "Chat removed from the dashboard.");
    } catch (e) { toast(`${withFolder ? "Delete" : "Remove"} failed: ${e.message}`, true); }
  }
  async function setHidden(id, hidden) {
    if (hidden && !confirm("Hide this chat from the dashboard?\n\nMuse's own session history is NOT deleted; you can unhide it with \"Show hidden chats\".")) return;
    try {
      await api("PATCH", `/api/chats/${id}`, { hidden });
      if (hidden && state.currentId === id) openDraft();
      loadChats();
    } catch (e) { toast(e.message, true); }
  }

  // ---------- chat view ----------
  function resetView() {
    for (const n of state.nodes.values()) clearTimeout(n._timer);
    state.items = new Map();
    state.nodes = new Map();
    state.approvals = new Map();
    state.activeTurnId = null;
    state.turnStats = null;
    state.agentStats = null;
    state.earlierCursor = null;
    state.renderQueued.clear();
    state.activityIds.clear();
    $("messages").textContent = "";
    $("activityList").textContent = "";
    renderActivity();
  }

  /** Activity panel: count badge plus an empty-state note when a chat has no tool activity. */
  function renderActivity() {
    const count = state.activityIds.size;
    $("activityCount").textContent = count ? String(count) : "";
    const list = $("activityList");
    let empty = $("activityEmpty");
    if (!count && !empty) {
      empty = el("div", "note", "No tool activity yet. Edits, commands and to-dos will appear here.");
      empty.id = "activityEmpty";
      list.appendChild(empty);
    } else if (count && empty) empty.remove();
  }

  function setActivityOpen(open) {
    state.activityOpen = open;
    $("activityPanel").classList.toggle("closed", !open);
    try { localStorage.setItem("muse.activityOpen", open ? "1" : "0"); } catch { /* private mode */ }
  }

  /** Leaving the current view: an untouched new chat simply disappears. */
  function leaveCurrent() {
    if (state.currentId === "draft" && state.draft) {
      state.draft.text = $("input").value;
      state.draft.attachments = state.attachments;
      state.attachments = [];
      if (!state.draft.text.trim() && !state.draft.attachments.length && !state.draft.serverId && !state.draft.workspace) state.draft = null;
    } else {
      clearAttachments();
      $("input").value = "";
    }
  }

  // ---------- New-chat popup: a new Projects folder, or an existing folder ----------
  let nameResolve = null;
  const newChatForm = { mode: "new", folder: null, autoTitle: "" }; // folder = GET /api/fs/info result
  function slugPreview(name) {
    return String(name || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean).slice(0, 10).join("-").slice(0, 80).replace(/-+$/, "");
  }
  /** Resolves to { title, workspace, seed } (workspace null = new Projects folder), or null when cancelled. */
  function askChatName() {
    return new Promise((resolve) => {
      nameResolve = resolve;
      newChatForm.folder = null;
      newChatForm.autoTitle = "";
      $("projectTitleField").value = "";
      $("seedStarter").checked = false;
      setNewChatMode("new");
      $("titleModal").classList.remove("hidden");
      setTimeout(() => $("projectTitleField").focus(), 0);
    });
  }
  function closeNameModal(value) {
    $("titleModal").classList.add("hidden");
    if (nameResolve) nameResolve(value);
    nameResolve = null;
  }
  function setNewChatMode(mode) {
    newChatForm.mode = mode;
    const open = mode === "open";
    for (const [id, on] of [["choiceNew", !open], ["choiceOpen", open]]) {
      $(id).classList.toggle("active", on);
      $(id).setAttribute("aria-selected", String(on));
    }
    $("openFolderPane").classList.toggle("hidden", !open);
    $("projectFolderPreview").classList.toggle("hidden", open);
    $("titleModalSub").textContent = open
      ? "Muse works directly on the files in the folder you pick. Nothing in it is moved or copied."
      : "A new project folder with this title is created in the Projects folder. Everything Muse makes for this chat is saved there.";
    $("projectTitleField").placeholder = open ? "Chat title (defaults to the folder name)" : "e.g. Kitchen redesign";
    $("titleCreate").textContent = open ? "Open folder" : "Create chat";
    $("titleError").textContent = "";
    if (open) renderOpenFolder();
    else updateFolderPreview();
  }
  function updateFolderPreview() {
    const s = slugPreview($("projectTitleField").value);
    $("projectFolderPreview").textContent = state.env?.projectsDir ? `Folder: ${state.env.projectsDir}${state.env.sep || "\\"}${s || "…"}` : "";
  }
  function renderOpenFolder() {
    const f = newChatForm.folder;
    $("openFolderPath").textContent = f ? f.path : "No folder chosen yet";
    $("openFolderPath").classList.toggle("chosen", !!f);
    renderRecents($("openRecents"), (p) => void useOpenFolder(p), false);
    $("seedRow").classList.toggle("hidden", !f || f.hasAgents);
    if (f && !f.hasAgents) $("seedLabel").textContent = `Add starter files (${f.missingStarterFiles.join(", ")}) so Muse follows the dashboard's project rules in this folder`;
    const offer = snapshotOffer(f);
    $("snapRow").classList.toggle("hidden", !offer);
    $("snapLabel").textContent = offer || "";
    const used = f?.usedBy?.length ? f.usedBy : null;
    $("openFolderNote").classList.toggle("warn", !!used);
    $("openFolderNote").textContent = used ? `Another chat already works in this folder (${used.join(", ")}). Two chats changing the same files at once can overwrite each other's work.` : "";
  }
  /** A folder was chosen (dialog, browser or recents): check it and default the title to its name. */
  async function useOpenFolder(p) {
    try {
      const info = await api("GET", `/api/fs/info?path=${encodeURIComponent(p)}`);
      newChatForm.folder = info;
      const field = $("projectTitleField");
      if (!field.value.trim() || field.value === newChatForm.autoTitle) {
        field.value = info.name;
        newChatForm.autoTitle = info.name;
      }
      $("seedStarter").checked = false;
      $("snapFirst").checked = true;
      $("titleError").textContent = "";
      renderOpenFolder();
    } catch (e) {
      $("titleError").textContent = e.message;
    }
  }
  /** A snapshot is offered for a folder Git does not track yet, or a repository with changes no commit holds. */
  const snapshotOffer = (info) => {
    const g = info && info.git;
    if (!g || !g.available) return null;
    if (!g.repo) return "Save a snapshot first, so Muse's changes can be undone (this folder is not tracked by Git yet; Git is set up in it for the snapshot, and folders like node_modules are left out)";
    if (g.changes > 0) return `Save a snapshot of the ${g.changes} unsaved change${g.changes === 1 ? "" : "s"} first, so Muse's changes can be undone (your branch and commits are not touched)`;
    return null;
  };
  function reportSnapshot(r) {
    if (r && r.snapshot) toast(`Snapshot saved (${r.snapshot.files} files). After Muse makes changes, ⋯ → "Undo changes since snapshot" puts the folder back.`);
    else if (r && r.snapshotError) toast(`No snapshot was saved: ${r.snapshotError}`, true);
  }
  /** The Windows folder dialog when the dashboard runs on Windows; otherwise (or if it fails) the in-page folder browser. Resolves to a path or null. */
  async function browseForFolder(start) {
    if (state.env?.platform === "win32") {
      try {
        return (await api("POST", "/api/fs/pick", { start: start || "" })).path;
      } catch (e) {
        if (e.status === 409) { toast(e.message, true); return null; }
        toast(`${e.message} Showing the built-in folder browser instead.`, true);
      }
    }
    const choice = await pickFolder({ allowAuto: false });
    return typeof choice === "string" && choice !== AUTO ? choice : null;
  }
  function rememberRecent(p) {
    if (state.env) state.env.recents = [p, ...(state.env.recents || []).filter((x) => !samePath(x, p))].slice(0, 12);
  }
  function newChat() { void promptNewChat(); }
  async function promptNewChat() {
    if (state.currentId === "draft" && state.draft) {
      const d = state.draft;
      const untouched = !d.serverId && !d.title && !($("input").value || "").trim() && !state.attachments.length;
      if (!untouched) { $("input").focus(); return; }
      // The blank starter chat from page load: set it up in place.
      const choice = await askChatName();
      if (choice === null) { $("input").focus(); return; }
      d.title = choice.title;
      if (choice.workspace) Object.assign(d, { workspace: choice.workspace, autoFolder: false, seed: choice.seed, snapshot: choice.snapshot });
      Object.assign(state.current, { title: choice.title, workspace: d.workspace, autoFolder: d.autoFolder });
      renderHeader();
      try { await ensureServerChat(); afterDraftCreated(); }
      catch (e) { toast(`Could not create the chat: ${e.message}`, true); }
      return;
    }
    // One unsent new chat at a time: if one is still waiting, reopen it (no second popup).
    if (state.draft) { leaveCurrent(); showDraft(); return; }
    const choice = await askChatName();
    if (choice === null) return; // cancelled: stay on the current chat, create nothing
    leaveCurrent();
    state.draft = { serverId: null, workspace: choice.workspace, autoFolder: !choice.workspace, seed: choice.seed, snapshot: choice.snapshot, title: choice.title, text: "", attachments: [], modelId: null, reasoningEffort: state.defaults.reasoningEffort, approvalMode: state.defaults.approvalMode };
    showDraft();
    try {
      await ensureServerChat(); // creates Projects/<name> (or records the picked folder) on the server right away
      afterDraftCreated();
    } catch (e) { toast(`Could not create the chat: ${e.message}`, true); }
  }
  /** The server has the draft's record: show its folder and whether Muse trusts it. */
  function afterDraftCreated() {
    const d = state.draft;
    if (!d) return;
    state.current.workspace = d.workspace;
    state.current.autoFolder = d.autoFolder;
    if (d.workspace && !d.autoFolder) rememberRecent(d.workspace);
    renderHeader();
    renderChatList();
    const hero = $("introNote");
    if (hero) { hero.remove(); renderEmptyHero(); }
    void loadChats();
    void refreshDraftTrust();
  }
  async function refreshDraftTrust() {
    const id = state.draft?.serverId;
    if (!id) return;
    try {
      const data = await api("GET", `/api/chats/${id}`);
      if (state.currentId === "draft" && state.draft?.serverId === id) { state.current.trust = data.trust || null; renderTrust(); }
    } catch { /* the chip just stays as it was */ }
  }
  function openDraft() {
    if (state.currentId === "draft") return;
    leaveCurrent();
    if (!state.draft) state.draft = { serverId: null, workspace: null, autoFolder: false, text: "", attachments: [], modelId: null, reasoningEffort: state.defaults.reasoningEffort, approvalMode: state.defaults.approvalMode };
    showDraft();
  }
  function showDraft() {
    state.currentId = "draft";
    resetView();
    const d = state.draft;
    // Fresh chats show the server default model (config "model", exposed as state.env.model),
    // not whatever another chat used last. An explicit pick (d.modelId) still wins.
    state.current = { id: d.serverId, draft: true, workspace: d.workspace, autoFolder: d.autoFolder, title: d.title || "New chat", model: d.modelId || (state.env && state.env.model) || state.lastModel, reasoningEffort: d.reasoningEffort || null, approvalMode: d.approvalMode || null };
    state.attachments = d.attachments || [];
    $("input").value = d.text || "";
    renderAttachments();
    renderHeader();
    void loadModels();
    renderEmptyHero();
    renderChatList();
    autoGrow();
    $("input").focus();
  }
  function renderEmptyHero() {
    const box = $("messages");
    if (box.querySelector(".row")) return;
    box.textContent = "";
    const h = el("div", "empty-hero");
    h.id = "introNote";
    h.appendChild(el("h2", "", "What are we building?"));
    const ws = state.current && state.current.workspace;
    h.appendChild(el("p", "", ws ? `Muse will work in ${ws}` : "Just start typing. This chat gets its own folder in the Projects folder."));
    h.appendChild(el("p", "", "Everything Muse makes is saved in that folder. Drop files anywhere, paste them, or use 📎."));
    box.appendChild(h);
  }

  function renderHeader() {
    const c = state.current || {};
    $("chatTitle").textContent = c.title || "New chat";
    const chip = $("folderChip");
    chip.classList.toggle("locked", !c.draft);
    if (c.draft) {
      chip.style.display = "";
      chip.textContent = c.workspace ? `📁 ${c.workspace}  (change)` : "📁 New project folder  ·  use an existing folder instead?";
      chip.title = c.workspace ? "Click to change or go back to the new project folder" : `A new folder will be created in ${state.env?.projectsDir || "Projects"}. Click to pick an existing project folder instead (optional).`;
    } else {
      chip.style.display = "none";
      chip.textContent = "";
      chip.title = "";
    }
    renderSettings();
    renderMuseBadge();
    renderCompactBtn();
    renderContext();
    renderTrust();
  }

  /**
   * Muse skips a folder's AGENTS.md project rules and hides the subagent tools
   * unless the folder (or its Git repository's root) is trusted in Muse.
   */
  function renderTrust() {
    const chip = $("trustChip");
    const t = state.current && state.current.trust;
    chip.classList.toggle("hidden", !t || t.trusted);
    chip.title = t && !t.trusted ? `Muse does not trust ${state.current.workspace || "this folder"}, so it skips the folder's project rules (AGENTS.md) and hides subagents for this chat. Click to trust it.` : "";
  }
  /** "Trust this folder": adds the chat's folder to Muse's trust list after a Yes/No. */
  async function trustCurrentFolder() {
    const c = state.current;
    const id = c && (c.draft ? state.draft?.serverId : c.id);
    if (!id || !c.trust || c.trust.trusted) return;
    const yes = await askYesNo({
      title: "Trust this folder?",
      text: `Muse will follow this folder's project rules (AGENTS.md) and may use subagents in it:\n\n${c.workspace || ""}\n\nOnly trust a folder whose files you trust: its rules become instructions for Muse.${c.draft ? "" : "\n\nThis chat was started before, so it keeps running without them. New chats in this folder get them."}`,
      yes: "Trust folder",
      no: "Cancel",
    });
    if (!yes) return;
    try {
      const r = await api("POST", `/api/chats/${id}/trust`);
      if (state.current === c) { c.trust = r.trust; renderTrust(); }
      toast(r.appliesToThisChat ? "Folder trusted. Muse uses its project rules from the first message." : "Folder trusted. New chats in this folder get its project rules.");
    } catch (e) {
      toast(`Could not trust the folder: ${e.message}`, true);
    }
  }

  /** Compact button: disabled with no session or while a reply runs. */
  function renderCompactBtn() {
    const b = $("compactBtn");
    if (!b) return;
    b.disabled = state.currentId === "draft" || !state.current || !!state.activeTurnId || state.running.has(state.currentId);
  }

  /** How full the open chat's context is. Muse compacts by itself near the limit; Compact does it now. */
  function renderContext() {
    const m = $("ctxMeter");
    const u = state.current && state.current.contextUsage;
    const used = u && Number(u.usedTokens);
    const win = u && Number(u.windowTokens);
    if (!used || !win) { m.textContent = ""; m.title = ""; return; }
    const pct = Math.min(100, Math.round((used / win) * 100));
    m.textContent = `ctx ${pct}%`;
    m.classList.toggle("hot", pct >= 70);
    m.title = `Context: ${used.toLocaleString()} of ${win.toLocaleString()} tokens. Every model step re-sends all of it. Muse compacts automatically near the limit; Compact does it now.`;
  }

  /** Render a batch of history items at the end (open) or the top (Load earlier) of the view. */
  function renderHistory(items, atTop) {
    const frag = { main: document.createDocumentFragment(), activity: document.createDocumentFragment() };
    for (const it of items) {
      state.items.set(it.itemId, it);
      renderItem(it, frag);
    }
    const box = $("messages");
    const list = $("activityList");
    if (atTop) {
      box.insertBefore(frag.main, box.firstChild);
      list.insertBefore(frag.activity, list.firstChild);
    } else {
      box.appendChild(frag.main);
      list.appendChild(frag.activity);
    }
    renderActivity();
    renderEarlierButton();
  }

  function renderEarlierButton() {
    const old = $("earlierRow");
    if (old) old.remove();
    if (!state.earlierCursor) return;
    const btn = el("button", "ghost-btn", "Load earlier messages");
    btn.addEventListener("click", loadEarlier);
    const row = rowWith(btn, "earlier-row");
    row.id = "earlierRow";
    $("messages").insertBefore(row, $("messages").firstChild);
  }

  async function loadEarlier() {
    const id = state.currentId;
    const btn = $("earlierRow") && $("earlierRow").querySelector("button");
    if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
    try {
      const data = await api("GET", `/api/chats/${id}?before=${encodeURIComponent(state.earlierCursor)}`);
      if (state.currentId !== id) return;
      const box = $("messages");
      const anchor = box.scrollHeight - box.scrollTop; // keep the view where it was
      state.earlierCursor = data.earlierCursor || null;
      if ($("earlierRow")) $("earlierRow").remove();
      renderHistory(data.items.filter((it) => !state.items.has(it.itemId)), true);
      box.scrollTop = box.scrollHeight - anchor;
    } catch (e) {
      toast(`Could not load earlier messages: ${e.message}`, true);
      if (btn) { btn.disabled = false; btn.textContent = "Load earlier messages"; }
    }
  }

  /** Prewarm a chat in Muse: its history (hover) or the whole session (typing, so the send does not wait). */
  function warmChat(id, load) {
    const key = `${id}#${load ? "load" : "view"}`;
    if (!id || id === "draft" || state.warmed.has(key)) return;
    state.warmed.add(key);
    api("POST", `/api/chats/${id}/warm`, { load }).catch(() => state.warmed.delete(key));
  }

  async function openChat(id) {
    if (state.currentId === id && state.current) return;
    state.warmed.delete(`${id}#load`); // it may have been unloaded since: typing warms it again
    leaveCurrent();
    state.currentId = id;
    state.current = null;
    resetView();
    clearAttachments();
    renderChatList();
    const box = $("messages");
    box.appendChild(rowWith(el("div", "note", "Loading conversation…")));
    $("chatTitle").textContent = (state.chats.find((c) => c.id === id) || {}).title || "Chat";
    try {
      const data = await api("GET", `/api/chats/${id}`);
      if (state.currentId !== id) return;
      if (data.draft) {
        // A new chat that got an attachment but no message yet (e.g. from before a restart).
        state.draft = { serverId: id, workspace: data.workspace, autoFolder: data.autoFolder, title: data.title, text: "", attachments: [] };
        state.currentId = null;
        showDraft();
        return;
      }
      state.current = { id, workspace: data.workspace, autoFolder: data.autoFolder, title: data.title, hidden: data.hidden, model: data.model, reasoningEffort: data.reasoningEffort || null, approvalMode: data.approvalMode || null, agentMode: data.agentMode || null, trust: data.trust || null, contextUsage: data.contextUsage || null };
      if (data.model) state.lastModel = data.model;
      state.activeTurnId = data.activeTurnId || null;
      state.turnStats = data.turnStats || null;
      state.agentStats = data.agentsActive ? { active: data.agentsActive } : null;
      if (data.agentsActive) state.agentsRunning.add(id); else state.agentsRunning.delete(id);
      state.earlierCursor = data.earlierCursor || null;
      renderHeader();
      void loadModels(id);
      // Items that streamed in while the history loaded were drawn into the
      // loading view: start the view over and merge them into the history.
      const live = new Map(state.items);
      for (const n of state.nodes.values()) clearTimeout(n._timer);
      state.nodes.clear();
      state.activityIds.clear();
      box.textContent = "";
      $("activityList").textContent = "";
      const inHistory = new Set(data.items.map((it) => it.itemId));
      const newest = (it) => { const l = live.get(it.itemId); return l && (l.revision || 0) >= (it.revision || 0) ? l : it; };
      renderHistory([...data.items.map(newest), ...[...live.values()].filter((it) => !inHistory.has(it.itemId))], false);
      const wasRunning = state.running.has(id);
      if (state.activeTurnId) state.running.add(id); else state.running.delete(id);
      if (wasRunning !== !!state.activeTurnId) renderChatList();
      for (const a of data.approvals || []) addApproval(a.key, a.request);
      if (!state.items.size) {
        const intro = rowWith(el("div", "note", `Conversation in ${data.workspace}. Ask Muse anything.`));
        intro.id = "introNote";
        box.appendChild(intro);
      }
      updateRunState();
      scrollToBottom(true);
      $("input").focus();
    } catch (e) {
      box.textContent = "";
      if (/no recorded project folder/i.test(e.message || "") && state.currentId === id) {
        // Terminal-started sessions can lack a recorded folder: attach one, then open.
        const wrap = el("div", "note");
        wrap.appendChild(el("div", "", "This chat has no project folder recorded. Point it at the folder it should work in, then it opens like any other chat."));
        const btn = el("button", "ghost-btn", "Choose a project folder…");
        btn.style.marginTop = "8px";
        btn.addEventListener("click", async () => {
          const choice = await pickFolder();
          if (choice === null || choice === undefined || choice === AUTO) return;
          try {
            await api("PATCH", `/api/chats/${id}`, { workspace: choice });
            await loadChats();
            openChat(id);
          } catch (err) { toast(err.message, true); }
        });
        wrap.appendChild(btn);
        box.appendChild(rowWith(wrap));
      } else {
        box.appendChild(rowWith(el("div", "note error", `Could not open this chat: ${e.message}`)));
      }
    }
  }

  /** The server turned our draft into a real Muse session. */
  function adoptSession(serverDraftId, sessionId) {
    if (state.currentId !== "draft" || !state.draft || state.draft.serverId !== serverDraftId) return;
    state.draft = null;
    state.currentId = sessionId;
    state.current = { ...state.current, id: sessionId, draft: false, title: state.current.title };
    renderHeader();
    renderChatList();
  }

  function rowWith(child, cls) {
    const r = el("div", `row${cls ? ` ${cls}` : ""}`);
    r.appendChild(child);
    return r;
  }

  function nearBottom() {
    const m = $("messages");
    return m.scrollHeight - m.scrollTop - m.clientHeight < 160;
  }
  function scrollToBottom(force) {
    const m = $("messages");
    if (force || nearBottom()) m.scrollTop = m.scrollHeight;
  }

  function statusBadge(status) {
    const cls = status === "completed" ? "ok" : status === "inProgress" ? "run" : ["failed", "rejected", "timedOut", "cancelled"].includes(status) ? "fail" : "";
    const label = status === "inProgress" ? "running" : status === "notFound" ? "not found" : status || "";
    return el("span", `badge ${cls}`, label);
  }

  function prettyArgs(s) {
    if (!s) return "";
    try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
  }

  /**
   * One row per transcript item. A row is built once and then patched in
   * place as the item streams, so a long reply is not rebuilt (and
   * re-highlighted) on every delta. `into` lets history batches render into
   * document fragments; live items append to the conversation/Activity panel.
   */
  function renderItem(item, into) {
    const kind = item.kind;
    if (typeof kind === "string" && kind.toLowerCase().startsWith("reminder")) return removeNode(item.itemId);
    const toActivity = ACTIVITY_KINDS.has(kind);
    let row = state.nodes.get(item.itemId);
    if (row && row.dataset.kind !== kind) { removeNode(item.itemId); row = null; }
    if (row) {
      patchRow(row, item);
      return toActivity ? "activity" : "main";
    }
    row = el("div", "row");
    row.dataset.item = item.itemId;
    row.dataset.kind = kind;
    if (!buildRow(row, item)) return null;
    removeIntro();
    const box = into ? (toActivity ? into.activity : into.main) : toActivity ? $("activityList") : $("messages");
    box.appendChild(row);
    state.nodes.set(item.itemId, row);
    if (toActivity) state.activityIds.add(item.itemId);
    return toActivity ? "activity" : "main";
  }

  const reasoningText = (item) => (item.summary || []).filter(Boolean).join("\n\n") || item.text || "";
  const TOOL_KINDS = new Set(["toolCall", "userShell", "webSearch", "subagent", "workflow"]);
  /** A subagent's state from its controlStatus (its item status stays "inProgress" after it hands in its result). */
  function agentBadge(item) {
    if (item.status !== "inProgress") return statusBadge(item.status);
    if (item.kind === "workflow") return statusBadge(item.stopAvailable === false ? "completed" : "inProgress");
    const c = item.controlStatus;
    if (c === "accepted" || c === "starting") return el("span", "badge", "queued");
    if (c === "resultReady" || c === "closed" || c === "closing") return el("span", "badge ok", "done");
    return statusBadge("inProgress");
  }
  /** "1m 20s · 48k in · 2k out" for a subagent row. */
  function agentMeta(item) {
    const parts = [];
    if (item.durationMs) parts.push(fmtDuration(item.durationMs));
    const u = item.usage;
    if (u) parts.push(`${fmtNum(Math.max(0, (Number(u.inputTokens) || 0) - (Number(u.cacheReadTokens ?? u.cachedTokens) || 0)))} new in`, `${fmtNum(u.outputTokens)} out`);
    return parts.join(" · ");
  }

  /** Fill a new row. Returns false when the item has nothing to show. */
  function buildRow(row, item) {
    const kind = item.kind;
    if (kind === "userMessage") {
      row.classList.add("msg-user");
      const wrap = el("div");
      wrap.appendChild(el("div", "role", "You"));
      wrap.appendChild(el("div", "bubble", item.displayText || item.text || ""));
      if (item.attachments && item.attachments.length) wrap.appendChild(el("div", "att", `🖼 ${item.attachments.length} image${item.attachments.length > 1 ? "s" : ""} attached`));
      row.appendChild(wrap);
    } else if (kind === "agentMessage") {
      row.appendChild(el("div", "role", "Muse"));
      row._md = el("div");
      row.appendChild(row._md);
      renderAgentText(row, item);
    } else if (kind === "reasoning") {
      if (!reasoningText(item) && item.status !== "inProgress") return false;
      const d = el("details", "think");
      d.appendChild(el("summary"));
      d.appendChild(el("div", "body"));
      row.appendChild(d);
      patchRow(row, item);
    } else if (TOOL_KINDS.has(kind)) {
      // The body (input/output, often many KB) is built only when opened.
      const d = el("details", "tool");
      d.appendChild(el("summary"));
      d.addEventListener("toggle", () => { if (d.open) fillToolBody(row); });
      row.appendChild(d);
      patchRow(row, item);
    } else if (kind === "turnSummary") {
      const line = turnSummaryText(item);
      if (!line) return false;
      row.appendChild(el("div", `turn-summary${item.terminal === "failed" ? " error" : ""}`, line));
    } else if (kind === "compaction") {
      row.appendChild(el("div", "note", "Context was compacted to keep the conversation going."));
    } else if (kind === "damagedRange") {
      row.appendChild(el("div", "note error", "Part of this session's log could not be read."));
    } else {
      const text = item.text || item.message || item.fallbackText || item.label || "";
      row.appendChild(el("div", "note", `${kind}${text ? `: ${text.slice(0, 300)}` : ""}`));
    }
    return true;
  }

  /** Update an existing row for a newer revision or a streamed delta of its item. */
  function patchRow(row, item) {
    const kind = item.kind;
    if (kind === "agentMessage") return renderAgentText(row, item);
    if (kind === "reasoning") {
      const d = row.querySelector("details");
      d.querySelector("summary").textContent = item.status === "inProgress" ? "Thinking…" : "Thought process";
      d.querySelector(".body").textContent = reasoningText(item);
      return;
    }
    if (TOOL_KINDS.has(kind)) {
      row._item = item;
      const d = row.querySelector("details");
      d.replaceChild(toolSummary(item), d.querySelector("summary"));
      if (d.open) fillToolBody(row);
      return;
    }
    row.textContent = "";
    buildRow(row, item);
  }

  /** Markdown for a reply: re-rendered at most every 150 ms while it streams, highlighted once it is done. */
  function renderAgentText(row, item) {
    row._md.className = `msg-agent markdown${item.messagePhase === "commentary" ? " commentary" : ""}${item.status === "inProgress" ? " cursor" : ""}`;
    row._text = item.text || "";
    if (item.status !== "inProgress") {
      clearTimeout(row._timer);
      row._timer = null;
      renderMarkdown(row._md, row._text, true);
      return;
    }
    if (row._timer) return;
    row._timer = setTimeout(() => {
      row._timer = null;
      const stick = nearBottom();
      renderMarkdown(row._md, row._text, false);
      if (stick) scrollToBottom(true);
    }, row._md.childElementCount ? 150 : 0);
  }

  // A failed read of a file that simply does not exist is a routine existence
  // probe (e.g. session boot checking for MASTER.md/LOG.md), not an error.
  const isNotFound = (item) => item.status === "failed" && /no such file|cannot find the file|ENOENT/i.test([item.failureReason, item.visibleOutput, item.args].filter(Boolean).join("\n"));

  function toolSummary(item) {
    const s = el("summary");
    if (item.kind === "subagent") {
      const who = item.role || item.label || (item.workflowRunId ? "workflow agent" : "");
      s.appendChild(el("span", "", `🤖 Subagent${who ? ` (${who})` : ""}: ${(item.objective || "").slice(0, 90)}`));
      s.appendChild(agentBadge(item));
      const m = agentMeta(item);
      if (m) s.appendChild(el("span", "diffstat", m));
      return s;
    }
    if (item.kind === "workflow") {
      const kids = item.children || [];
      s.appendChild(el("span", "", `🧩 Workflow${kids.length ? ` · ${kids.length} agent${kids.length === 1 ? "" : "s"}` : ""}${item.declaredPhase ? ` · ${item.declaredPhase}` : ""}`));
      s.appendChild(agentBadge(item));
      if (item.durationMs) s.appendChild(el("span", "diffstat", fmtDuration(item.durationMs)));
      return s;
    }
    const lbl = item.displayLabel
      ? item.status === "inProgress" ? item.displayLabel.active : item.status === "completed" ? item.displayLabel.done : item.displayLabel.neutral
      : item.kind === "userShell" ? `$ ${item.commandText || "shell"}` : item.kind === "webSearch" ? "Web search" : item.tool || "Tool call";
    s.appendChild(el("span", "", `🔧 ${lbl}`));
    s.appendChild(statusBadge(isNotFound(item) ? "notFound" : item.status));
    if (item.patchSummary) {
      const ds = el("span", "diffstat");
      ds.appendChild(el("span", "add", `+${item.patchSummary.added}`));
      ds.appendChild(document.createTextNode(" "));
      ds.appendChild(el("span", "del", `−${item.patchSummary.removed}`));
      ds.appendChild(document.createTextNode(` · ${item.patchSummary.files} file${item.patchSummary.files === 1 ? "" : "s"}`));
      s.appendChild(ds);
    }
    return s;
  }

  function fillToolBody(row) {
    const item = row._item;
    const d = row.querySelector("details");
    const old = d.querySelector(".body");
    if (old) old.remove();
    const body = el("div", "body");
    if (item.kind === "subagent") {
      if (item.objective) { body.appendChild(el("div", "meta", "Objective")); body.appendChild(el("pre", "", item.objective)); }
      const res = item.result && (item.result.text || item.result.summary);
      if (res) { body.appendChild(el("div", "meta", "Result")); body.appendChild(el("pre", "", res)); }
      if (item.failureReason) body.appendChild(el("div", "note error", item.failureReason));
      if (item.childSessionId && state.current && !state.current.draft) {
        if (row._transcript) body.appendChild(row._transcript);
        else {
          const b = el("button", "ghost-btn", "Show this subagent's transcript");
          b.addEventListener("click", async (e) => {
            e.preventDefault();
            b.disabled = true;
            try {
              const r = await api("GET", `/api/chats/${state.current.id}/children/${item.childSessionId}`);
              const t = el("div", "transcript");
              for (const x of r.items) {
                if (x.kind === "agentMessage" || x.kind === "userMessage") t.appendChild(el("pre", x.kind === "userMessage" ? "meta" : "", x.text));
                else t.appendChild(el("div", "meta", `🔧 ${x.label || x.tool || x.kind} · ${x.status || ""}`));
              }
              if (!r.items.length) t.appendChild(el("div", "meta", "Nothing recorded yet."));
              row._transcript = t;
              b.replaceWith(t);
            } catch (err) { toast(err.message, true); b.disabled = false; }
          });
          body.appendChild(b);
        }
      }
    } else if (item.kind === "workflow") {
      for (const c of item.children || []) {
        const u = c.usage;
        const tok = u ? ` · ${fmtNum(Math.max(0, (Number(u.inputTokens) || 0) - (Number(u.cacheReadTokens ?? u.cachedTokens) || 0)))} new in · ${fmtNum(u.outputTokens)} out` : "";
        body.appendChild(el("div", "meta", `${c.label || c.phase || c.childId} · ${c.terminal || c.status}${c.durationMs ? ` · ${fmtDuration(c.durationMs)}` : ""}${tok}`));
      }
      const summary = item.finalSummary || (item.status !== "inProgress" && item.fallbackText) || "";
      if (summary) body.appendChild(el("pre", "", summary));
      if (item.failureReason) body.appendChild(el("div", "note error", item.failureReason));
    } else {
      if (item.statusLine) body.appendChild(el("div", "meta", item.statusLine));
      const args = prettyArgs(item.args || item.commandText);
      if (args) { body.appendChild(el("div", "meta", "Input")); body.appendChild(el("pre", "", args)); }
      if (item.visibleOutput) { body.appendChild(el("div", "meta", "Output")); body.appendChild(el("pre", "", item.visibleOutput)); }
      if (item.failureReason) body.appendChild(el("div", isNotFound(item) ? "note" : "note error", item.failureReason));
    }
    d.appendChild(body);
  }

  /** "12 steps · 48k new in · 2.1k out · 1.3M cached" under a finished reply; failures and stops say so. */
  function turnSummaryText(t) {
    if (t.terminal === "failed") return `Muse stopped with an error: ${t.error || "unknown error"}`;
    const parts = [];
    if (t.terminal === "cancelled") parts.push("Stopped");
    if (t.steps) {
      parts.push(`${t.steps} step${t.steps === 1 ? "" : "s"}`, `${fmtNum(Math.max(0, t.input - t.cached))} new in`, `${fmtNum(t.output)} out`);
      if (t.cached) parts.push(`${fmtNum(t.cached)} cached`);
    }
    if (parts.length && t.durationMs) parts.push(fmtDuration(t.durationMs));
    const a = t.agents;
    if (a && a.count) parts.push(`🤖 ${a.count} subagent${a.count === 1 ? "" : "s"}: ${fmtNum(Math.max(0, a.input - a.cached))} new in · ${fmtNum(a.output)} out${a.cached ? ` · ${fmtNum(a.cached)} cached` : ""}`);
    return parts.join(" · ");
  }

  function removeNode(itemId) {
    const n = state.nodes.get(itemId);
    if (n) { clearTimeout(n._timer); n.remove(); }
    state.nodes.delete(itemId);
    state.activityIds.delete(itemId);
    return null;
  }

  function flushRenders() {
    let mainChanged = false;
    let activityChanged = false;
    for (const id of state.renderQueued) {
      const it = state.items.get(id);
      const where = it && renderItem(it);
      if (where === "main") mainChanged = true;
      if (where === "activity") activityChanged = true;
    }
    state.renderQueued.clear();
    if (activityChanged) renderActivity();
    return mainChanged;
  }
  function removeIntro() {
    const n = $("introNote");
    if (n) n.remove();
  }


  function queueRender(itemId) {
    state.renderQueued.add(itemId);
    if (state.renderQueued.size === 1) {
      requestAnimationFrame(() => {
        const stick = nearBottom();
        const mainChanged = flushRenders();
        if (mainChanged && stick) scrollToBottom(true);
      });
    }
  }

  function applyDelta(item, field, delta) {
    const f = field || "text";
    if (f === "output") item.visibleOutput = (item.visibleOutput || "") + delta;
    else if (f.startsWith("summary.")) {
      const i = Number(f.slice(8));
      item.summary = Array.isArray(item.summary) ? item.summary.slice() : [];
      item.summary[i] = (item.summary[i] || "") + delta;
    } else if (f === "text") item.text = (item.text || "") + delta;
  }

  // ---------- approvals ----------
  function describeSubject(req) {
    const s = req.subject || {};
    switch (s.kind) {
      case "shell": return { title: "Run a command?", body: s.command || req.rawArgs };
      case "fileAccess": return { title: `${s.access === "write" ? "Write to" : "Read"} a file?`, body: s.path || req.rawArgs };
      case "network": return { title: "Connect to the network?", body: `${s.protocol ? `${s.protocol}://` : ""}${s.host || ""}${s.port ? `:${s.port}` : ""}` };
      case "process": return { title: "Control a process?", body: s.target || req.rawArgs };
      case "tool": return { title: `Use tool ${s.toolName || req.toolName}?`, body: prettyArgs(req.rawArgs) };
      default: return { title: `Allow ${req.toolName || s.kind || "this action"}?`, body: prettyArgs(req.rawArgs) };
    }
  }

  function addApproval(key, req) {
    state.approvals.set(key, req);
    state.attention.add(req.sessionId);
    flushRenders();
    removeIntro();
    const existing = document.querySelector(`[data-approval="${CSS.escape(key)}"]`);
    if (existing) existing.remove();
    const card = el("div", "approval");
    const d = describeSubject(req);
    card.appendChild(el("h4", "", `⚠ ${d.title}${req.protectedWrite ? " (protected file)" : ""}`));
    card.appendChild(el("div", "meta", `Tool: ${req.toolName}${req.subagentOrigin ? " · asked by a subagent" : ""}${req.judgeEscalated ? " · flagged for a human by the safety judge" : ""}`));
    if (d.body) card.appendChild(el("div", "subject", d.body));
    let fb = null;
    if ((req.availableChoices || []).some((c) => c.acceptsFeedback)) {
      fb = el("textarea");
      fb.placeholder = "Optional note to Muse (sent with choices that accept feedback)";
      card.appendChild(fb);
    }
    const choices = el("div", "choices");
    for (const c of req.availableChoices || []) {
      const dec = String(c.decision || "");
      const b = el("button", dec.startsWith("approved") ? "approve" : dec.startsWith("denied") || dec === "abort" ? "deny" : "", c.label);
      if (c.rulePreview) b.title = c.rulePreview;
      b.addEventListener("click", async () => {
        for (const x of choices.querySelectorAll("button")) x.disabled = true;
        try {
          await api("POST", `/api/approvals/${encodeURIComponent(key)}`, { choiceId: c.choiceId, feedback: fb && c.acceptsFeedback ? fb.value.trim() || undefined : undefined });
          removeApproval(key);
        } catch (e) {
          toast(e.message, true);
          for (const x of choices.querySelectorAll("button")) x.disabled = false;
        }
      });
      choices.appendChild(b);
    }
    card.appendChild(choices);
    const row = rowWith(card);
    row.dataset.approval = key;
    $("messages").appendChild(row);
    scrollToBottom(true);
    renderChatList();
  }
  function removeApproval(key) {
    const req = state.approvals.get(key);
    state.approvals.delete(key);
    const n = document.querySelector(`[data-approval="${CSS.escape(key)}"]`);
    if (n) n.remove();
    if (req && ![...state.approvals.values()].some((r) => r.sessionId === req.sessionId)) state.attention.delete(req.sessionId);
    renderChatList();
  }

  // ---------- live events ----------
  // The open event stream is how the server knows a tab is open (it stops itself
  // a while after the last one closes). No polling: only open/close events.
  const clientId = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
  let liveEs = null;
  function showStopped(msg) {
    if (state.restarting) return;
    if (liveEs) { liveEs.close(); liveEs = null; }
    const b = $("stoppedBanner");
    b.querySelector(".msg").textContent = msg || `Dashboard stopped — run ${launcher()} to restart.`;
    b.classList.remove("hidden");
    $("sendBtn").disabled = true;
  }
  async function checkServer() {
    if (state.restarting) return;
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      const h = await r.json();
      if (state.instance && h.instance !== state.instance) showStopped(`The dashboard was restarted in another window — run ${launcher()} to open it.`);
      else if (h.stopping) showStopped();
    } catch {
      showStopped();
    }
  }
  /**
   * Settings > Restart: the server restarts on the same port with the same
   * access token, so once a new instance answers, a reload is all it takes.
   */
  async function waitForRestart() {
    if (state.restarting) return;
    state.restarting = true;
    if (liveEs) { liveEs.close(); liveEs = null; }
    const b = $("stoppedBanner");
    b.querySelector(".msg").textContent = "Restarting the dashboard…";
    b.classList.add("info");
    b.classList.remove("hidden");
    const old = state.instance;
    // Come back to the same chat, with any unsent text.
    try { sessionStorage.setItem("md-restore", JSON.stringify({ chatId: state.current && !state.current.draft ? state.current.id : null, text: $("input").value })); } catch { /* private mode */ }
    for (let i = 0; i < 120; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const h = await (await fetch("/api/health", { cache: "no-store" })).json();
        if (h.instance && h.instance !== old && !h.stopping) return location.reload();
      } catch { /* still restarting */ }
    }
    state.restarting = false;
    b.classList.remove("info");
    showStopped(`The dashboard did not come back. Run ${launcher()} to start it again.`);
  }
  async function restartDashboard() {
    try {
      await api("POST", "/api/restart", {});
      void waitForRestart();
    } catch (e) {
      toast(e.message, true);
    }
  }
  window.addEventListener("pagehide", () => {
    try { navigator.sendBeacon(`/api/bye?client=${encodeURIComponent(clientId)}`); } catch { /* ignore */ }
  });
  window.addEventListener("pageshow", (e) => {
    // Came back from the browser's back/forward cache: say hello again.
    if (e.persisted && $("stoppedBanner").classList.contains("hidden")) { if (liveEs) liveEs.close(); connectEvents(); }
  });

  /** A reply finished: put its step/token summary under it, like history shows it. */
  function finishTurn(params) {
    const stats = state.turnStats && state.turnStats.turnId === params.turnId ? state.turnStats : {};
    const ag = state.agentStats && state.agentStats.turnId === params.turnId && state.agentStats.count ? state.agentStats : undefined;
    const item = { itemId: `turn:${params.turnId}`, kind: "turnSummary", turnId: params.turnId, terminal: params.terminal, durationMs: params.durationMs, error: (params.error && params.error.message) || params.reason, steps: stats.steps || 0, input: stats.input || 0, cached: stats.cached || 0, output: stats.output || 0, agents: ag };
    state.items.set(item.itemId, item);
    flushRenders();
    queueRender(item.itemId);
    if (state.turnStats && state.turnStats.turnId === params.turnId) state.turnStats = null;
  }

  function connectEvents() {
    const es = new EventSource(`/api/events?client=${encodeURIComponent(clientId)}`);
    liveEs = es;
    es.addEventListener("hello", (ev) => {
      const { instance } = JSON.parse(ev.data);
      if (state.instance && instance !== state.instance) return showStopped(`The dashboard was restarted in another window — run ${launcher()} to open it.`);
      state.instance = instance;
    });
    es.addEventListener("server-stopping", (ev) => {
      const { reason } = JSON.parse(ev.data || "{}");
      if (reason === "restart") return void waitForRestart();
      showStopped(reason === "idle" ? `Dashboard stopped because no tab was open — run ${launcher()} to restart.` : undefined);
    });
    es.addEventListener("muse", (ev) => {
      const { sessionId, method, params } = JSON.parse(ev.data);
      if (method === "turn/started") { state.running.add(sessionId); renderChatList(); }
      if (method === "turn/completed" || method === "turn/unqueued") {
        state.running.delete(sessionId);
        renderChatList();
      }
      if (method === "session/nameChanged") loadChatsSoon();
      if (sessionId !== state.currentId) return;
      switch (method) {
        case "item/started":
        case "item/updated":
        case "item/completed": {
          const it = params.item;
          const prev = state.items.get(it.itemId);
          if (!prev || (it.revision || 0) >= (prev.revision || 0)) {
            // keep accumulated streamed text if the update omits it
            if (prev && it.status === "inProgress" && !it.text && prev.text) it.text = prev.text;
            if (prev && it.status === "inProgress" && !it.visibleOutput && prev.visibleOutput) it.visibleOutput = prev.visibleOutput;
            if (prev && !it.usage && prev.usage) it.usage = prev.usage; // a subagent's usage, once seen

            state.items.set(it.itemId, it);
            queueRender(it.itemId);
          }
          break;
        }
        case "item/delta": {
          const it = state.items.get(params.itemId);
          if (it) { applyDelta(it, params.field, params.delta); queueRender(it.itemId); }
          break;
        }
        case "turn/started":
          state.activeTurnId = params.turnId;
          updateRunState();
          break;
        case "turn/completed":
          if (state.activeTurnId === params.turnId) state.activeTurnId = null;
          finishTurn(params);
          updateRunState();
          break;
        case "turn/unqueued":
          if (state.activeTurnId === params.turnId) state.activeTurnId = null;
          updateRunState();
          break;
        case "session/contextUsage":
          if (state.current) { state.current.contextUsage = { usedTokens: params.usedTokens, windowTokens: params.windowTokens, pressure: params.pressure }; renderContext(); }
          break;
        case "session/modelChanged":
          if (state.current && params.model && params.model.modelId) { state.current.model = params.model.modelId; state.lastModel = params.model.modelId; }
          renderSettings();
          renderMuseBadge();
          break;
        case "session/reasoningEffortChanged":
          if (state.current) state.current.reasoningEffort = params.reasoningEffort;
          renderSettings();
          break;
        case "session/approvalModeChanged":
          if (state.current) state.current.approvalMode = params.mode;
          renderSettings();
          break;
        case "approval/resolved":
          for (const [key, req] of state.approvals) if (req.approvalId === params.approvalId) removeApproval(key);
          break;
        default:
      }
    });
    es.addEventListener("turn-stats", (ev) => {
      const d = JSON.parse(ev.data);
      if (d.sessionId !== state.currentId) return;
      state.turnStats = d;
      updateRunState();
    });
    // Subagents and workflows: they keep working (and spending) after the turn that started them ends.
    es.addEventListener("agent-stats", (ev) => {
      const d = JSON.parse(ev.data);
      const was = state.agentsRunning.has(d.sessionId);
      if (d.active) state.agentsRunning.add(d.sessionId); else state.agentsRunning.delete(d.sessionId);
      if (was !== !!d.active) renderChatList();
      if (d.sessionId !== state.currentId) return;
      state.agentStats = d;
      // A finished reply's summary row keeps counting its children.
      const sum = d.turnId && state.items.get(`turn:${d.turnId}`);
      if (sum && d.count) { sum.agents = { count: d.count, input: d.input, cached: d.cached, output: d.output }; const row = state.nodes.get(sum.itemId); if (row) { row.textContent = ""; buildRow(row, sum); } }
      updateRunState();
    });
    es.addEventListener("chat-usage", (ev) => {
      const d = JSON.parse(ev.data);
      const c = state.chats.find((x) => x.id === d.id);
      if (!c) return loadChatsSoon();
      if (d.agentUsage) c.agentUsage = d.agentUsage;
      if (!d.tokenUsage) { renderChatList(); return; }
      c.tokenUsage = d.tokenUsage;
      c.updatedAt = new Date().toISOString();
      state.chats.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      renderChatList();
    });
    es.addEventListener("usage", (ev) => renderUsage(JSON.parse(ev.data)));
    es.addEventListener("approval-request", (ev) => {
      const { sessionId, key, request } = JSON.parse(ev.data);
      state.attention.add(sessionId);
      if (sessionId === state.currentId) addApproval(key, request);
      else { renderChatList(); toast("A chat in the sidebar is waiting for your approval."); }
    });
    es.addEventListener("host-exit", (ev) => {
      const d = JSON.parse(ev.data);
      toast(`Muse stopped unexpectedly for ${d.workspace} (${d.kind}).${d.detail ? `\n${d.detail.slice(-400)}` : ""}`, true);
    });
    es.addEventListener("session-unloaded", (ev) => {
      const d = JSON.parse(ev.data);
      state.running.delete(d.sessionId);
      state.agentsRunning.delete(d.sessionId);
      if (d.sessionId === state.currentId) { state.activeTurnId = null; state.agentStats = null; updateRunState(); }
      renderChatList();
    });
    es.addEventListener("app-error", (ev) => toast(JSON.parse(ev.data).message, true));
    es.addEventListener("app-notice", (ev) => toast(JSON.parse(ev.data).message));
    es.addEventListener("chat-updated", () => loadChatsSoon());
    es.addEventListener("chat-deleted", (ev) => {
      const d = JSON.parse(ev.data);
      if (d.id === state.currentId) openDraft();
      loadChatsSoon();
    });
    es.addEventListener("chat-rekeyed", (ev) => {
      const d = JSON.parse(ev.data);
      adoptSession(d.from, d.to);
      loadChatsSoon();
    });
    es.addEventListener("chat-compacted", () => toast("Context compacted."));
    es.addEventListener("muse-status", (ev) => {
      if (!state.env) return;
      const prevState = state.env.muse && state.env.muse.update && state.env.muse.update.state;
      state.env.muse = JSON.parse(ev.data);
      renderMuseBadge();
      renderMusePanel();
      const u = state.env.muse.update || {};
      if (prevState === "checking" && u.state === "updated") toast(`Muse was updated to ${u.to || "the latest version"}.`);
    });
    // A new sign-in or connection is announced where it happens; only an update needs saying here.
    es.addEventListener("muse-restarted", (ev) => { if (JSON.parse(ev.data || "{}").reason === "update") toast("Restarted Muse to use the new version."); });
    es.addEventListener("connection", (ev) => setConnection(JSON.parse(ev.data)));
    es.onerror = () => {
      // EventSource retries by itself; check once whether the server is still there.
      if (es === liveEs) void checkServer();
    };
  }

  /** Header state while a reply runs: Stop button and a live step/token meter. */
  function updateRunState() {
    const turn = !!state.activeTurnId;
    const agents = (state.agentStats && state.agentStats.active) || 0;
    const running = turn || agents > 0;
    const t = turn && state.turnStats;
    const rs = $("runState");
    const agentText = agents ? `${agents} subagent${agents === 1 ? "" : "s"} working` : "";
    rs.textContent = !running ? "" : !turn ? `● ${agentText}` : t && t.steps ? `● Working · step ${t.steps} · ${fmtNum(Math.max(0, t.input - t.cached))} new in · ${fmtNum(t.output)} out${agents ? ` · ${agentText}` : ""}` : `● Working…${agents ? ` · ${agentText}` : ""}`;
    rs.title = (t && t.steps ? `This reply so far: ${t.steps} model steps; ${fmtNum(t.cached)} tokens of context re-read from cache.` : "") + (agents ? `${t && t.steps ? "\n" : ""}Subagents keep working after the reply ends; Stop stops them too.` : "");
    $("stopBtn").classList.toggle("hidden", !running);
    $("stopBtn").title = agents ? "Stop the reply and its subagents" : "Stop the current reply";
    $("sendBtn").classList.toggle("hidden", turn && !$("input").value.trim() && !state.attachments.length);
    renderCompactBtn();
  }

  // ---------- subscription usage ----------
  /** Sidebar bars for the subscription's 5-hour and weekly windows (Muse reports them as replies run). */
  function renderUsage(u) {
    const box = $("usageBox");
    if (!u || !u.window) {
      box.title = "Muse reports subscription usage as replies run; nothing reported yet.";
      return;
    }
    const set = (bar, label, w) => {
      const p = Math.max(0, Number(w.usedPercent) || 0);
      $(bar).style.width = `${Math.min(100, p)}%`;
      $(bar).classList.toggle("hot", p >= 80);
      $(label).textContent = `${p}%`;
      return w.rolledOver ? "reset; new figures arrive with the next reply" : w.resetsAtMs ? `resets ${new Date(w.resetsAtMs).toLocaleString()}` : "";
    };
    const r5 = set("usage5hBar", "usage5h", u.window);
    const rw = u.weekly ? set("usageWkBar", "usageWk", u.weekly) : "";
    box.title = `Subscription usage (${u.tier || "plan"}), as of ${new Date(u.observedAtMs || Date.now()).toLocaleTimeString()}\n5-hour window: ${r5}\nWeekly: ${rw}`;
    // Muse only reports while replies run: ask again when the next window resets, so the bars do not keep the old figure.
    clearTimeout(state.usageTimer);
    const next = [u.window.resetsAtMs, u.weekly && u.weekly.resetsAtMs].filter((t) => t > Date.now()).sort((a, b) => a - b)[0];
    if (next) state.usageTimer = setTimeout(loadUsage, Math.min(next - Date.now() + 2000, 2 ** 31 - 1));
  }
  async function loadUsage() {
    try { renderUsage((await api("GET", "/api/usage")).usage); } catch { /* shown when Muse reports */ }
  }

  // ---------- composer ----------
  function autoGrow() {
    const t = $("input");
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight, 240)}px`;
    updateRunState();
  }

  /** Create the dashboard-side record for a draft (no Muse session yet). */
  async function ensureServerChat() {
    if (state.currentId !== "draft") return state.currentId;
    const d = state.draft;
    if (!d.serverId) {
      const picked = d.workspace && !d.autoFolder ? d.workspace : undefined;
      const snapshot = !!(picked && d.snapshot);
      if (snapshot) toast("Saving a snapshot of the folder…");
      const r = await api("POST", "/api/chats", { title: d.title || undefined, workspace: picked, seedProjectFiles: picked && d.seed ? true : undefined, snapshot: snapshot || undefined, modelId: d.modelId || undefined, reasoningEffort: d.reasoningEffort || undefined, approvalMode: d.approvalMode || undefined, agentMode: d.agentMode || undefined });
      d.snapshot = false;
      reportSnapshot(r);
      d.serverId = r.id;
      if (r.workspace) d.workspace = r.workspace;
      d.autoFolder = !!r.autoFolder;
      state.current.id = r.id;
    }
    return d.serverId;
  }

  async function sendMessage() {
    if (!state.current) return;
    const text = $("input").value.trim();
    if (state.attachments.some((a) => a.status === "uploading")) return toast("Wait for the attachments to finish uploading.");
    const ready = state.attachments.filter((a) => a.status === "ready");
    if (!text && !ready.length) return;
    const body = {
      text,
      images: ready.filter((a) => a.kind === "image").map((a) => ({ mediaType: a.mediaType, base64Data: a.base64Data, name: a.name })),
      paths: ready.filter((a) => a.kind === "path").map((a) => a.path),
    };
    $("sendBtn").disabled = true;
    const wasDraft = state.currentId === "draft";
    if (wasDraft && state.current.title === "New chat" && text) { state.current.title = text.slice(0, 60); renderHeader(); }
    try {
      if (wasDraft && text && !(await offerGithubRepo(text))) await offerMentionedFolder(text);
      const id = await ensureServerChat();
      const out = await api("POST", `/api/chats/${id}/messages`, body);
      if (wasDraft) adoptSession(id, out.chatId);
      $("input").value = "";
      clearAttachments();
      autoGrow();
      if (!state.activeTurnId) { state.activeTurnId = "pending"; updateRunState(); }
      if (wasDraft) {
        await loadChats();
        const c = state.chats.find((x) => x.id === out.chatId);
        if (c && state.currentId === out.chatId) { state.current.workspace = c.workspace; state.current.autoFolder = c.autoFolder; renderHeader(); }
      } else loadChatsSoon();
    } catch (e) {
      toast(`Send failed: ${e.message}`, true);
      if (wasDraft) loadChats();
    } finally {
      $("sendBtn").disabled = false;
    }
  }

  async function stopTurn() {
    if (!state.current) return;
    try {
      const r = await api("POST", `/api/chats/${state.current.id}/interrupt`, {});
      if (r && r.agentsStopped) toast(`Stopped ${r.agentsStopped} subagent run${r.agentsStopped === 1 ? "" : "s"} too.`);
    } catch (e) { toast(`Stop failed: ${e.message}`, true); }
  }

  async function compactCurrent() {
    if (!state.current || state.currentId === "draft") return;
    const b = $("compactBtn");
    if (b) b.disabled = true;
    try {
      const r = await api("POST", `/api/chats/${state.current.id}/compact`, {});
      renderCompactBtn();
      toast(r.status === "noop" ? "Nothing worth compacting yet." : "Compacting context…");
    } catch (e) {
      toast(`Compact failed: ${e.message}`, true);
      renderCompactBtn();
    }
  }

  const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
  const newAtt = (props) => ({ id: Math.random().toString(36).slice(2), ...props });

  /**
   * Files from 📎, drag-and-drop or paste are uploaded into the chat's own
   * folder (attachments/, or .muse-uploads/<chat> in a project folder) and
   * given to Muse as @relative/path. Images also go to the model as pictures.
   */
  async function addBrowserFiles(entries) {
    if (!entries.length) return;
    let chatId;
    try { chatId = await ensureServerChat(); }
    catch (e) { return toast(`Could not attach: ${e.message}`, true); }
    for (const { file, isDir } of entries) {
      const a = newAtt({ kind: "path", name: file.name || "pasted-image.png", isDir, size: file.size, status: "uploading" });
      if (isDir) {
        a.status = "error";
        a.error = "Folders can't be attached. Drop the files inside it instead.";
        toast(a.error, true);
      } else if (IMAGE_TYPES.includes(file.type) || IMAGE_EXT.test(a.name)) a.thumb = URL.createObjectURL(file);
      state.attachments.push(a);
      renderAttachments();
      if (isDir) continue;
      try {
        const res = await api("POST", `/api/chats/${chatId}/upload?name=${encodeURIComponent(a.name)}`, undefined, file);
        const dup = state.attachments.find((b) => b !== a && b.path === res.path);
        if (dup) { state.attachments = state.attachments.filter((b) => b !== a); renderAttachments(); continue; }
        Object.assign(a, { path: res.path, relPath: res.relPath, name: res.name, status: "ready" });
        if (res.reused) a.note = "already in this chat (not saved twice)";
      } catch (e) {
        a.status = "error";
        a.error = e.message;
        toast(`${a.name}: ${e.message}`, true);
      }
      renderAttachments();
    }
  }
  function renderAttachments() {
    const box = $("attachments");
    box.textContent = "";
    for (const a of state.attachments) {
      const c = el("div", `chip${a.status === "error" ? " error" : ""}`);
      if (a.thumb) { const img = el("img"); img.src = a.thumb; img.alt = ""; img.onerror = () => img.replaceWith(el("span", "", "🖼")); c.appendChild(img); }
      else c.appendChild(el("span", "", a.isDir ? "📁" : IMAGE_EXT.test(a.name) ? "🖼" : "📄"));
      c.appendChild(el("span", "name", a.name));
      c.title = [a.relPath ? `@${a.relPath}` : a.name, a.path, a.note, a.error].filter(Boolean).join("\n");
      if (a.status !== "ready") c.appendChild(el("span", "state", a.status === "error" ? "failed" : "uploading…"));
      const x = el("button", "", "✕");
      x.title = "Remove";
      x.addEventListener("click", () => {
        if (a.thumb && a.thumb.startsWith("blob:")) URL.revokeObjectURL(a.thumb);
        state.attachments = state.attachments.filter((b) => b !== a);
        renderAttachments();
      });
      c.appendChild(x);
      box.appendChild(c);
    }
    updateRunState();
  }
  function clearAttachments() {
    for (const a of state.attachments) if (a.thumb && a.thumb.startsWith("blob:")) URL.revokeObjectURL(a.thumb);
    state.attachments = [];
    renderAttachments();
  }

  // ---------- folder picker ----------
  let browsePath = null;
  let pickerResolve = null;
  function renderRecents(container, onPick, removable) {
    container.textContent = "";
    for (const p of (state.env && state.env.recents) || []) {
      const b = el("button", "recent");
      b.title = p;
      b.appendChild(el("span", "", `📁 ${baseName(p)}`));
      if (removable) {
        const x = el("span", "x", "✕");
        x.title = "Remove from recents";
        x.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          const r = await api("POST", "/api/recents/remove", { path: p });
          state.env.recents = r.recents;
          renderRecents(container, onPick, removable);
        });
        b.appendChild(x);
      }
      b.addEventListener("click", () => onPick(p));
      container.appendChild(b);
    }
  }
  /** allowAuto: offer "Use the chat's own folder" (resolves to AUTO). */
  function pickFolder({ allowAuto = true } = {}) {
    return new Promise((resolve) => {
      pickerResolve = resolve;
      $("autoFolderBtn").classList.toggle("hidden", !allowAuto);
      $("nativePickBtn").classList.toggle("hidden", state.env?.platform !== "win32");
      $("folderModal").classList.remove("hidden");
      $("modalError").textContent = "";
      $("pathInput").value = "";
      renderRecents($("modalRecents"), (p) => { $("pathInput").value = p; browse(p); }, true);
      browse(null);
      setTimeout(() => $("pathInput").focus(), 0);
    });
  }
  function closePicker(result) {
    $("folderModal").classList.add("hidden");
    if (pickerResolve) pickerResolve(result);
    pickerResolve = null;
  }
  async function browse(p) {
    $("modalError").textContent = "";
    try {
      const data = await api("GET", `/api/fs/list${p ? `?path=${encodeURIComponent(p)}` : ""}`);
      browsePath = data.path;
      $("browserPath").textContent = data.path || "Drives and shortcuts";
      $("upBtn").disabled = !data.parent;
      $("upBtn").onclick = () => data.parent && browse(data.parent);
      if (data.path) $("pathInput").value = data.path;
      $("modalOk").disabled = !data.path;
      const list = $("browserList");
      list.textContent = "";
      const addEntry = (e, icon) => {
        if (e.hidden && !$("showDotDirs").checked) return;
        const row = el("div", `entry${e.hidden ? " dot" : ""}`, `${icon} ${e.name}`);
        row.title = e.path;
        row.addEventListener("click", () => browse(e.path));
        list.appendChild(row);
      };
      if (!data.path) {
        list.appendChild(el("div", "section", "Shortcuts"));
        for (const s of data.shortcuts || []) addEntry(s, "⭐");
        list.appendChild(el("div", "section", "Drives"));
        for (const d of data.entries) addEntry(d, "💽");
      } else {
        for (const d of data.entries) addEntry(d, "📁");
        if (!list.children.length) list.appendChild(el("div", "section", "No subfolders"));
      }
    } catch (e) {
      $("modalError").textContent = e.message;
    }
  }

  /** Optional: point a not-yet-sent chat at an existing project folder. */
  async function chooseDraftFolder() {
    if (state.currentId !== "draft") return;
    const choice = await pickFolder();
    if (choice === null || choice === undefined) return;
    await applyDraftFolder(choice === AUTO ? null : choice);
  }

  /** Point the draft at `workspace` (null = back to a new project folder), offering starter files and a snapshot. */
  async function applyDraftFolder(workspace) {
    const d = state.draft;
    try {
      let seed = false;
      let snapshot = false;
      if (workspace) {
        const info = await api("GET", `/api/fs/info?path=${encodeURIComponent(workspace)}`);
        if (!info.hasAgents) {
          seed = await askYesNo({
            title: "Add starter files?",
            text: `${info.path} has no AGENTS.md, so Muse will not follow the dashboard's project rules there.\n\nAdd ${info.missingStarterFiles.join(", ")} to this folder? Existing files are never overwritten.`,
            yes: "Yes, add them",
            no: "No",
          });
        }
        const offer = snapshotOffer(info);
        if (offer) snapshot = await askYesNo({ title: "Save a snapshot first?", text: `${offer}.`, yes: "Yes, save a snapshot", no: "No" });
      }
      if (d.serverId) {
        if (snapshot) toast("Saving a snapshot of the folder…");
        reportSnapshot(await api("PATCH", `/api/chats/${d.serverId}`, { workspace, seedProjectFiles: seed || undefined, snapshot: snapshot || undefined }));
      } else Object.assign(d, { seed, snapshot });
      d.workspace = workspace || (d.autoFolder ? d.workspace : null);
      if (workspace) d.autoFolder = false;
      if (workspace) rememberRecent(workspace);
      state.current.workspace = d.workspace;
      state.current.autoFolder = d.autoFolder;
      renderHeader();
      renderChatList();
      const hero = $("introNote");
      if (hero) { hero.remove(); renderEmptyHero(); }
      void refreshDraftTrust();
      $("input").focus();
      return true;
    } catch (e) {
      toast(e.message, true);
      return false;
    }
  }

  /**
   * First message of a new-project chat names an existing folder ("the game located here: C:\...")?
   * Offer to run the chat there, so Muse boots from that project's own MASTER.md, LOG.md and AGENTS.md
   * instead of an empty Projects folder.
   */
  async function offerMentionedFolder(text) {
    const d = state.draft;
    if (!d || !(d.autoFolder || !d.workspace) || !/[A-Za-z]:[\\/]/.test(text)) return;
    let found;
    try { found = (await api("POST", "/api/fs/mentioned", { text })).folders || []; } catch { return; }
    const f = found.find((x) => !d.workspace || x.path.toLowerCase() !== d.workspace.toLowerCase());
    if (!f) return;
    const yes = await askYesNo({
      title: "Work in this folder?",
      text: `Your message names ${f.path}.\n\nRun this chat in that folder? Muse then reads that project's own notes and rules (MASTER.md, LOG.md, AGENTS.md) and works there directly.\n\nNo keeps the new project folder${d.workspace ? ` (${d.workspace})` : ""}.`,
      yes: "Yes, work there",
      no: "No, keep the new folder",
    });
    if (yes) await applyDraftFolder(f.path);
  }

  /**
   * First message of a new-project chat links a GitHub repository? Offer to clone it into Projects/
   * (or use a clone the user already has) and run the chat there, so Muse can commit and push to it.
   * True when the chat now works in the repository's folder.
   */
  async function offerGithubRepo(text) {
    const d = state.draft;
    if (!d || !(d.autoFolder || !d.workspace) || !/github\.com\//i.test(text)) return false;
    let found;
    try { found = await api("POST", "/api/github/mentioned", { text }); } catch { return false; }
    const l = (found.links || [])[0];
    if (!l) return false;
    const as = (found.accounts || [])[0];
    const signIn = as ? `Pushes use your GitHub sign-in (${as}).` : "If Git is not signed in to GitHub yet, the first push asks you to sign in once.";
    if (l.clone) {
      const yes = await askYesNo({
        title: "Work on this GitHub repository?",
        text: `Your message links ${l.url}.\n\nYou already have it at ${l.clone}. Run this chat there? Muse can then change it, commit and push to GitHub. ${signIn}\n\nNo keeps the new project folder.`,
        yes: "Yes, work there",
        no: "No, keep the new folder",
      });
      return yes && (await applyDraftFolder(l.clone));
    }
    const yes = await askYesNo({
      title: "Clone this GitHub repository?",
      text: `Your message links ${l.url}.\n\nClone it into ${state.env?.projectsDir || "Projects"}${state.env?.sep || "\\"}${l.repo} and run this chat there? Muse can then change it, commit and push to GitHub. ${signIn}\n\nNo keeps the new project folder.`,
      yes: "Yes, clone it",
      no: "No, keep the new folder",
    });
    if (!yes) return false;
    toast(`Cloning ${l.owner}/${l.repo}…`);
    let r;
    try { r = await api("POST", "/api/github/clone", { url: l.url, chatId: d.serverId || undefined }); } catch (e) { toast(e.message, true); return false; }
    if (!(await applyDraftFolder(r.path))) return false;
    toast(`Cloned to ${r.path}${r.empty ? " (the repository is empty: the first push creates its first branch)" : ""}.`);
    return true;
  }

  // ---------- Yes/No dialog ----------
  let confirmResolve = null;
  /** `no: null` shows a notice with only the `yes` button. */
  function askYesNo({ title, text, yes = "Yes", no = "No", danger = false }) {
    if (confirmResolve) closeYesNo(false);
    return new Promise((resolve) => {
      confirmResolve = resolve;
      $("confirmTitle").textContent = title;
      $("confirmText").textContent = text;
      $("confirmYes").textContent = yes;
      $("confirmNo").textContent = no || "";
      $("confirmNo").classList.toggle("hidden", no === null);
      $("confirmYes").classList.toggle("danger", danger);
      $("confirmModal").classList.remove("hidden");
      // A destructive question starts on No, so a stray Enter does not confirm it.
      setTimeout(() => $(danger ? "confirmNo" : "confirmYes").focus(), 0);
    });
  }
  function closeYesNo(answer) {
    $("confirmModal").classList.add("hidden");
    const resolve = confirmResolve;
    confirmResolve = null;
    if (resolve) resolve(answer);
  }
  const AUTO = "__auto__";

  // ---------- Muse connection ----------
  // The server checks at launch whether Muse Code is installed and signed in,
  // or given an API key (lib/connect.js, lib/api-key.js), and sends every
  // change as a "connection" event: the check's state plus how Muse connects
  // (via: subscription | apiKey | env). A new problem opens the Connect dialog
  // by itself; the header's Connect button and Settings reopen it.
  const PROBLEM_STATES = new Set(["signedOut", "keyRefused", "notInstalled", "hostError"]);
  const VIA = {
    subscription: { label: "your Muse Code subscription", hint: "Muse uses your Meta account sign-in and the subscription's 5-hour and weekly allowance." },
    apiKey: { label: "your API key", hint: "Muse runs on the saved API key; Meta bills each reply." },
    env: { label: "META_API_KEY", hint: "Muse uses the META_API_KEY the dashboard was started with; Meta bills each reply." },
  };
  let connectShownFor = null; // the problem the dialog last opened for by itself
  let signInStarted = false;
  let lastFocusCheck = 0;
  let noticeShown = null;
  const connectionOf = () => (state.env && state.env.connection) || { state: "checking" };
  function setConnection(c) {
    const was = connectionOf().state;
    if (state.env) state.env.connection = c;
    renderConnection();
    if (c.notice && c.notice !== noticeShown) { noticeShown = c.notice; toast(c.notice, true); }
    if (!PROBLEM_STATES.has(c.state)) connectShownFor = null;
    else if (connectShownFor !== c.state) { connectShownFor = c.state; openConnect(); }
    if (c.state === "connected" && PROBLEM_STATES.has(was)) {
      signInStarted = false;
      closeConnect();
      toast(c.via === "subscription" ? `Connected to Muse Code${c.tier ? ` (${c.tier})` : ""}.` : `Connected to Muse Code with ${VIA[c.via].label}.`);
      void loadModels(state.current && !state.current.draft ? state.current.id : undefined);
      void loadChats();
    }
  }
  function renderConnection() {
    const c = connectionOf();
    const via = VIA[c.via] ? c.via : "subscription";
    const btn = $("connectBtn");
    btn.classList.toggle("hidden", !PROBLEM_STATES.has(c.state));
    btn.textContent = { notInstalled: "⚠ Install Muse Code", hostError: "⚠ Muse did not start", keyRefused: "⚠ API key refused" }[c.state] || "⚠ Sign in to Muse";
    $("connectInfo").textContent = {
      checking: "Checking…",
      connected: `Connected · ${via === "subscription" ? c.tier || "subscription" : via === "apiKey" ? "API key" : "META_API_KEY"}`,
      signedOut: "Not signed in to a Meta account",
      keyRefused: "Meta refused the API key",
      notInstalled: "Muse Code was not found on this computer",
      hostError: "Muse Code did not start",
      unknown: `Could not check${c.message ? `: ${c.message}` : ""}`,
    }[c.state] || c.state;
    // Settings → Connection.
    $("connMode").value = via;
    $("connMode").querySelector('option[value="env"]').hidden = !c.envKey;
    $("connHint").textContent = VIA[via].hint;
    const k = c.apiKey;
    $("apiKeyHint").textContent = k ? `•••• ${k.last4}, saved ${new Date(k.savedAt).toLocaleDateString()}, encrypted for your user account.` : "No key saved.";
    $("apiKeyBtn").textContent = k ? "Replace…" : "Add key…";
    $("apiKeyRemoveBtn").classList.toggle("hidden", !k);
    // The 5-hour and weekly bars belong to the subscription.
    $("usageBox").classList.toggle("api", via !== "subscription");
    $("usageApi").classList.toggle("hidden", via === "subscription");
    if (!$("connectModal").classList.contains("hidden")) fillConnect();
  }
  /** The dialog's title, explanation, command and buttons for the current state. */
  function fillConnect() {
    const c = connectionOf();
    const win = state.env && state.env.platform === "win32";
    let title = "Muse Code connection";
    let text = "Checking Muse Code…";
    let command = "";
    let signIn = false;
    let useKey = false;
    if (c.state === "connected") {
      title = "Connected to Muse Code";
      if (c.via === "apiKey") text = `Muse Code is installed and runs on your API key${c.apiKey ? ` (•••• ${c.apiKey.last4})` : ""}, billed per use by Meta. You're all set. Switch in Settings → Connection.`;
      else if (c.via === "env") text = "Muse Code is installed and runs on the META_API_KEY the dashboard was started with, billed per use by Meta. You're all set.";
      else text = `Muse Code is installed and signed in${c.tier ? ` (${c.tier})` : ""}. You're all set.`;
    } else if (c.state === "keyRefused") {
      title = "Meta refused the API key";
      text = c.via === "env"
        ? "Replies cannot run: Meta did not accept the META_API_KEY the dashboard was started with. Add a working key here, or use your Muse Code subscription."
        : "Replies cannot run: Meta did not accept the saved API key (it may have been revoked or run out of credit). Replace it, or use your Muse Code subscription instead.";
      useKey = true;
    } else if (c.state === "notInstalled") {
      title = "Install Muse Code";
      text = `The dashboard could not find Muse Code on this computer. Install it with Meta's installer in ${win ? "PowerShell" : "a terminal"}, then click Check again. Next you sign in with your Meta account.`;
      command = (state.env && state.env.installCommand) || "";
    } else if (c.state === "hostError") {
      title = "Muse Code did not start";
      text = `${c.message || "The Muse host failed to start."}\n\nFix the problem above (the README's Troubleshooting section lists the usual causes), then click Check again.`;
    } else if (c.state === "signedOut") {
      title = "Sign in to Muse Code";
      signIn = true;
      useKey = !signInStarted;
      if (!signInStarted) text = 'Muse Code is installed but not signed in to a Meta account, so replies cannot run. Click Sign in with Meta: a small window shows Meta\'s sign-in code and your browser opens to approve it (the same as running "muse login" in a terminal).\n\nNo subscription? Use a Meta API key instead, billed per use.';
      else if (win) text = "A sign-in window is open. Approve the code in your browser with your Meta account. This page continues by itself once you are signed in.";
      else { text = "Run this in a terminal, approve the code in your browser, then click Check again:"; command = "muse login"; }
    } else if (c.state === "unknown") {
      text = `The sign-in check gave no clear answer${c.message ? ` (${c.message})` : ""}. Chats may still work; click Check again to retry.`;
    }
    $("connectTitle").textContent = title;
    $("connectText").textContent = text;
    $("connectCmd").textContent = command;
    $("connectCmd").classList.toggle("hidden", !command);
    $("connectCopy").classList.toggle("hidden", !command);
    $("connectSignIn").classList.toggle("hidden", !signIn);
    $("connectSignIn").textContent = signInStarted && win ? "Open the sign-in window again" : "Sign in with Meta";
    $("connectApiKey").classList.toggle("hidden", !useKey);
    $("connectApiKey").textContent = c.state === "keyRefused" && c.via === "apiKey" ? "Replace key" : "Use an API key";
    $("connectApiKey").classList.toggle("primary-btn", c.state === "keyRefused");
    $("connectApiKey").classList.toggle("ghost-btn", c.state !== "keyRefused");
    $("connectUseSub").classList.toggle("hidden", c.state !== "keyRefused");
    $("connectLater").textContent = c.state === "connected" ? "Close" : "Later";
  }
  function openConnect() {
    $("connectStatus").textContent = "";
    fillConnect();
    $("connectModal").classList.remove("hidden");
  }
  function closeConnect() {
    $("connectModal").classList.add("hidden");
  }
  async function recheckConnection() {
    const b = $("connectCheck");
    const before = connectionOf().state;
    b.disabled = true;
    $("connectStatus").textContent = "Checking…";
    try {
      setConnection(await api("POST", "/api/connection/check", {}));
      const now = connectionOf().state;
      $("connectStatus").textContent = PROBLEM_STATES.has(now) && now === before ? "Still not connected." : "";
    } catch (e) {
      $("connectStatus").textContent = e.message;
    } finally {
      b.disabled = false;
    }
  }
  async function signInToMuse() {
    const b = $("connectSignIn");
    b.disabled = true;
    $("connectStatus").textContent = "";
    try {
      await api("POST", "/api/connection/sign-in", {});
      signInStarted = true;
      fillConnect();
    } catch (e) {
      $("connectStatus").textContent = e.message;
    } finally {
      b.disabled = false;
    }
  }
  /** Back from the browser after approving the code: check once (the server also watches Muse's sign-in file). */
  function checkOnFocus() {
    if (!signInStarted || connectionOf().state !== "signedOut" || Date.now() - lastFocusCheck < 5000) return;
    lastFocusCheck = Date.now();
    void recheckConnection();
  }

  // Settings → Connection and the API-key popup. Every change answers with the connection after a fresh check.
  /** `before`: the state before the change. A solved problem is already announced as "Connected …" (by this answer or the live event ahead of it). */
  function connectionChanged(c, what, before) {
    setConnection(c);
    const solved = PROBLEM_STATES.has(before) && c.state === "connected";
    const msg = solved ? what : `${what ? `${what} ` : ""}Muse now connects through ${VIA[c.via].label}${c.switchesAfterReply ? " once the current reply ends" : ""}.`;
    if (msg) toast(msg);
  }
  async function setConnectionMode(mode) {
    if (mode === "apiKey" && !connectionOf().apiKey) { renderConnection(); openApiKeyModal(); return; }
    const before = connectionOf().state;
    try { connectionChanged(await api("POST", "/api/connection/mode", { mode }), "", before); }
    catch (e) { toast(e.message, true); renderConnection(); }
  }
  async function removeApiKey() {
    const yes = await askYesNo({ title: "Remove the API key?", text: "The saved key is deleted from this computer. If Muse was using it, it goes back to your Muse Code subscription sign-in.", yes: "Remove", no: "Keep", danger: true });
    if (!yes) return;
    const before = connectionOf().state;
    try { connectionChanged(await api("DELETE", "/api/connection/api-key"), "API key removed.", before); }
    catch (e) { toast(e.message, true); }
  }
  function apiKeyError(msg, offerAnyway) {
    $("apiKeyError").textContent = msg || "";
    $("apiKeyAnyway").classList.toggle("hidden", !offerAnyway);
  }
  /** Mask or reveal the key. A CSS-masked text field, so the browser does not offer to save the key as a password; a password field only where CSS masking is missing. */
  function maskApiKey(masked) {
    const input = $("apiKeyInput");
    if (CSS.supports("-webkit-text-security", "disc")) input.classList.toggle("masked", masked);
    else input.type = masked ? "password" : "text";
    $("apiKeyShow").textContent = masked ? "Show" : "Hide";
    $("apiKeyShow").setAttribute("aria-pressed", String(!masked));
  }
  function openApiKeyModal() {
    $("apiKeyInput").value = "";
    maskApiKey(true);
    apiKeyError("");
    $("apiKeyModal").classList.remove("hidden");
    setTimeout(() => $("apiKeyInput").focus(), 0);
  }
  function closeApiKeyModal() {
    $("apiKeyModal").classList.add("hidden");
    $("apiKeyInput").value = ""; // the key is not kept in the page
  }
  async function saveApiKey(skipCheck) {
    const key = $("apiKeyInput").value.trim();
    if (!key) return apiKeyError("Paste your API key first.");
    $("apiKeySave").disabled = $("apiKeyAnyway").disabled = true;
    apiKeyError(skipCheck ? "" : "Checking the key with Meta…");
    const before = connectionOf().state;
    try {
      const c = await api("POST", "/api/connection/api-key", { key, skipCheck: skipCheck || undefined });
      closeApiKeyModal();
      connectionChanged(c, c.checked ? `API key checked with Meta${c.models ? ` (${c.models} models)` : ""} and saved.` : "API key saved without a check.", before);
    } catch (e) {
      // 502: Meta could not be reached, so the key may still be fine; 422: Meta refused it.
      apiKeyError(e.message, e.status === 502);
    } finally {
      $("apiKeySave").disabled = $("apiKeyAnyway").disabled = false;
    }
  }

  // ---------- Muse version badge ----------
  function renderMuseBadge() {
    const m = (state.env && state.env.muse) || {};
    const host = m.host || {};
    const u = m.update || {};
    const ver = host.serverVersion || m.installed || "?";
    $("museText").textContent = `Muse ${ver}`;
    let dot = "ok", tip = `Muse ${ver}`;
    if (host.state === "incompatible" || host.state === "error") { dot = "bad"; tip = host.message || "Muse problem"; }
    else if (u.state === "checking") { dot = "checking"; tip = "Checking for a Muse update…"; }
    else if (u.state === "updated") { dot = "updated"; tip = `Updated ${u.from || ""} → ${u.to || ""}`; }
    else if (u.available) { dot = "available"; tip = `Update available: ${u.available}`; }
    else if (u.state === "failed") { dot = "available"; tip = `Couldn't check for updates: ${u.message || ""}`; }
    $("museDot").className = `mdot ${dot}`;
    $("museBadge").title = `${tip}\nClick for details`;
  }
  function renderMusePanel() {
    const body = $("musePanelBody");
    if (!body) return;
    const m = (state.env && state.env.muse) || {};
    const host = m.host || {};
    const u = m.update || {};
    body.textContent = "";
    const row = (k, v) => { if (v === undefined || v === null || v === "") return; const r = el("div", "row"); r.appendChild(el("span", "", k)); r.appendChild(el("span", "", String(v))); body.appendChild(r); };
    row("Installed", m.installed);
    row("Running", host.serverVersion ? `${host.serverName || "muse"} ${host.serverVersion}` : host.state || "not started yet");
    row("Model", (state.current && state.current.model) || state.lastModel || host.model || "Muse default");
    const upd = { checking: "checking…", updated: `updated ${u.from || "?"} → ${u.to || "?"}`, current: "up to date", failed: "check failed", skipped: "auto-update off" }[u.state] || u.state;
    row("Update", upd);
    if (u.available) row("Available", u.available);
    if (u.message && (u.state === "failed" || u.state === "skipped")) row("Details", u.message);
    if (host.schemaDrift) row("Protocol", "differs from the dashboard's SDK pin (additive changes are fine; see README)");
    if (host.sandbox) row("Sandbox", host.sandboxEffective === "off-fallback" ? "unavailable on this machine — running WITHOUT sandbox (fallback); approvals still apply. Run Muse's elevated sandbox setup outside the dashboard, then restart, to restore it." : host.sandboxEffective === "off" ? "off" : host.sandboxEffective === "unavailable" ? `unavailable${host.sandboxUnavailableReason ? ` (${host.sandboxUnavailableReason})` : ""}` : host.sandbox);
    if (host.state === "incompatible") row("Problem", host.message);
    row("Binary", (m.bin && m.bin.bin) || "");
  }

  // ---------- model / effort / approvals ----------
  // The one effort ladder, lowest to highest. Every effort dropdown is built
  // from this list only — no extra "default" entry, so no duplicate Medium.
  const EFFORT_TIERS = [["minimal", "Minimal"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"], ["ultra", "Ultra"]];
  const effortLabel = (v) => (v === "none" ? "None" : (EFFORT_TIERS.find(([x]) => x === v) || [])[1] || v);
  /** The effort to show for a chat: its own remembered tier, else the new-chat default. */
  function effortOf(c) {
    return (c && c.reasoningEffort) || state.defaults.reasoningEffort || "medium";
  }
  /** (Re)build an effort <select> from the ladder, limited to the model's tiers when known, always keeping the current tier visible. */
  function buildEffortOptions(select, variants, current) {
    let tiers = EFFORT_TIERS;
    if (Array.isArray(variants) && variants.length) {
      const allowed = tiers.filter(([v]) => variants.includes(v));
      if (allowed.length) tiers = allowed;
    }
    if (current && !tiers.some(([v]) => v === current)) tiers = [[current, effortLabel(current)], ...tiers];
    select.textContent = "";
    for (const [v, label] of tiers) {
      const o = document.createElement("option");
      o.value = v; o.textContent = label;
      select.appendChild(o);
    }
    select.value = current && tiers.some(([v]) => v === current) ? current : tiers.some(([v]) => v === "medium") ? "medium" : tiers[0][0];
  }
  function renderSettings() {
    const c = state.current || {};
    const ms = $("modelSelect");
    if (ms) {
      // Only this chat's own model (or the host default) — never another chat's last-used model.
      const cur = c.model || (state.env && state.env.muse && state.env.muse.host && state.env.muse.host.model) || "";
      if (!state.models.length && cur && !ms.options.length) {
        const o = document.createElement("option");
        o.value = cur; o.textContent = cur;
        ms.appendChild(o);
      }
      if (cur) ms.value = cur;
    }
    const ef = $("effortSelect");
    if (ef) {
      const cur = effortOf(c);
      if (![...ef.options].some((o) => o.value === cur)) buildEffortOptions(ef, null, cur);
      ef.value = cur;
    }
    const ap = $("approvalSelect");
    if (ap) ap.value = (c.approvalMode || state.defaults.approvalMode) === "allowAll" ? "allowAll" : "onRequest";
    const ag = $("agentSelect");
    if (ag) ag.value = agentModeOf(c);
    const de = $("defEffortSelect");
    if (de) de.value = [...de.options].some((o) => o.value === state.defaults.reasoningEffort) ? state.defaults.reasoningEffort : "medium";
    const da = $("defApprovalSelect");
    if (da) da.value = state.defaults.approvalMode;
  }
  /** The Agents mode to show for a chat: its own, else the dashboard's new-chat default. */
  function agentModeOf(c) {
    const ok = ["solo", "auto", "parallel"];
    return ok.includes(c && c.agentMode) ? c.agentMode : ok.includes(state.env && state.env.agentMode) ? state.env.agentMode : "solo";
  }
  function loadDefaults() {
    const tiers = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]; // a stored tier that is not offered falls back to Medium
    try {
      const d = JSON.parse(localStorage.getItem("md-defaults") || "{}");
      return {
        reasoningEffort: tiers.includes(d.reasoningEffort) ? d.reasoningEffort : "medium",
        approvalMode: d.approvalMode === "onRequest" ? "onRequest" : "allowAll",
      };
    } catch {
      return { reasoningEffort: "medium", approvalMode: "allowAll" };
    }
  }
  function saveDefaults() {
    try { localStorage.setItem("md-defaults", JSON.stringify(state.defaults)); } catch { /* ignore */ }
  }
  async function loadModels(sessionId) {
    try {
      const data = await api("GET", sessionId ? `/api/models?sessionId=${encodeURIComponent(sessionId)}` : "/api/models");
      state.models = data.models || [];
      const ms = $("modelSelect");
      ms.textContent = "";
      for (const m of state.models) {
        const o = document.createElement("option");
        o.value = m.modelId;
        o.textContent = (m.displayLabel && m.displayLabel !== m.modelId ? `${m.displayLabel} (${m.modelId})` : m.modelId) + (m.isDefault ? " - default" : "");
        ms.appendChild(o);
      }
      const active = state.models.find((m) => m.isActive) || state.models.find((m) => m.isDefault) || state.models[0];
      // Effort tiers come from the one ladder (Minimal → Ultra), limited to what this chat's model offers, keeping this chat's remembered tier selected.
      buildEffortOptions($("effortSelect"), active && active.variants, effortOf(state.current || {}));
      renderSettings();
    } catch { /* Muse host not up yet; opening a chat retries */ }
  }
  async function applySetting(patch, label) {
    if (!state.current) return;
    try {
      if (state.currentId === "draft") {
        const id = await ensureServerChat();
        await api("PATCH", `/api/chats/${id}`, patch);
        if (state.draft) Object.assign(state.draft, patch);
      } else {
        await api("PATCH", `/api/chats/${state.current.id}`, patch);
      }
      Object.assign(state.current, patch);
      if (patch.modelId) { state.current.model = patch.modelId; state.lastModel = patch.modelId; }
      renderSettings();
      renderMuseBadge();
      toast(`${label} saved. It applies from the next reply.`);
    } catch (e) {
      toast(e.message, true);
      renderSettings();
    }
  }
  // Premium tiers multiply the cost of every model step, and one reply can run dozens of steps.
  const PREMIUM_EFFORTS = new Set(["xhigh", "max", "ultra"]);
  const isPremiumModel = (id) => /wonder-full/i.test(String(id || ""));
  function confirmPremium(what) {
    return confirm(`${what} makes every model step cost much more, and one reply can run dozens of steps.\n\nKeep it for tasks that need it (large refactors, hard debugging). Spark or Wonder at Medium handles routine edits.\n\nContinue?`);
  }
  // ---------- wiring ----------
  function wire() {
    $("newChatBtn").addEventListener("click", newChat);
    const submitName = () => {
      const v = $("projectTitleField").value.trim();
      if (newChatForm.mode === "open") {
        const f = newChatForm.folder;
        if (!f) { $("titleError").textContent = "Choose a folder first."; return; }
        closeNameModal({ title: (v || f.name).slice(0, 120), workspace: f.path, seed: !f.hasAgents && $("seedStarter").checked, snapshot: !!snapshotOffer(f) && $("snapFirst").checked });
        return;
      }
      if (!v) { $("titleError").textContent = "Please give the chat a title."; return; }
      closeNameModal({ title: v.slice(0, 120), workspace: null, seed: false });
    };
    $("titleCreate").addEventListener("click", submitName);
    $("titleCancel").addEventListener("click", () => closeNameModal(null));
    $("choiceNew").addEventListener("click", () => { setNewChatMode("new"); $("projectTitleField").focus(); });
    $("choiceOpen").addEventListener("click", () => setNewChatMode("open"));
    $("openBrowseBtn").addEventListener("click", async () => {
      const btn = $("openBrowseBtn");
      btn.disabled = true;
      btn.textContent = "Waiting for the folder dialog…";
      try {
        const p = await browseForFolder(newChatForm.folder?.path || state.env?.recents?.[0] || "");
        if (p) await useOpenFolder(p);
      } finally {
        btn.disabled = false;
        btn.textContent = "Browse…";
      }
    });
    $("projectTitleField").addEventListener("input", () => {
      $("titleError").textContent = "";
      if (newChatForm.mode === "new") updateFolderPreview();
    });
    $("projectTitleField").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitName(); } });
    $("titleModal").addEventListener("click", (e) => { if (e.target === $("titleModal")) closeNameModal(null); });
    const isOpen = (id) => !$(id).classList.contains("hidden");
    // Escape closes only the top-most dialog (folder browser / Yes-No sit above the New-chat popup).
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen("titleModal") && !isOpen("folderModal") && !isOpen("confirmModal")) closeNameModal(null); });
    $("confirmYes").addEventListener("click", () => closeYesNo(true));
    $("confirmNo").addEventListener("click", () => closeYesNo(false));
    $("confirmModal").addEventListener("click", (e) => { if (e.target === $("confirmModal")) closeYesNo(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen("confirmModal")) { e.stopImmediatePropagation(); closeYesNo(false); } });
    // The API-key popup sits above Settings and the Connect dialog: Escape closes it first.
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen("apiKeyModal")) { e.stopImmediatePropagation(); closeApiKeyModal(); } });
    document.addEventListener("keydown", (e) => { if (e.ctrlKey && e.shiftKey && (e.key === "O" || e.key === "o")) { e.preventDefault(); newChat(); } });
    $("museBadge").addEventListener("click", (e) => { e.stopPropagation(); renderMusePanel(); $("musePanel").classList.toggle("hidden"); });
    document.addEventListener("click", (e) => { if (!$("musePanel").contains(e.target)) $("musePanel").classList.add("hidden"); });
    $("modelSelect").addEventListener("change", (e) => {
      if (isPremiumModel(e.target.value) && !confirmPremium(`${e.target.value} (premium model)${agentModeOf(state.current) === "parallel" ? " with Parallel agents (subagents it spawns directly inherit this model)" : ""}`)) { renderSettings(); return; }
      applySetting({ modelId: e.target.value }, "Model");
    });
    $("effortSelect").addEventListener("change", (e) => {
      if (PREMIUM_EFFORTS.has(e.target.value) && !confirmPremium(`${e.target.selectedOptions[0].textContent} effort`)) { renderSettings(); return; }
      applySetting({ reasoningEffort: e.target.value }, "Effort");
    });
    $("agentSelect").addEventListener("change", (e) => {
      const v = e.target.value;
      if (v === "parallel" && isPremiumModel(state.current && state.current.model) && !confirmPremium("Parallel agents on a premium model (subagents it spawns directly inherit it)")) { renderSettings(); return; }
      if (state.currentId === "draft" && state.draft) state.draft.agentMode = v;
      applySetting({ agentMode: v }, "Agents mode");
    });
    $("trustChip").addEventListener("click", () => void trustCurrentFolder());
    $("approvalSelect").addEventListener("change", (e) => {
      if (e.target.value === "allowAll" && !confirm("Auto-accept ALL actions in this chat?\n\nMuse will run commands and edit files in this chat's folder without asking you first. Only use this in a folder you trust.\n\nYou can switch back to 'Ask me' at any time.")) { renderSettings(); return; }
      applySetting({ approvalMode: e.target.value }, "Approval mode");
    });
    const closeSettings = () => { $("settingsPanel").classList.add("hidden"); $("settingsBackdrop").classList.add("hidden"); };
    const openSettings = () => {
      renderSettings();
      $("settingsPanel").classList.remove("hidden");
      $("settingsBackdrop").classList.remove("hidden");
    };
    $("settingsBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      if ($("settingsPanel").classList.contains("hidden")) openSettings(); else closeSettings();
    });
    $("settingsCloseBtn").addEventListener("click", closeSettings);
    $("settingsBackdrop").addEventListener("click", closeSettings);
    $("connectBtn").addEventListener("click", openConnect);
    $("connectOpenBtn").addEventListener("click", () => { closeSettings(); openConnect(); });
    $("connectLater").addEventListener("click", closeConnect);
    $("connectCheck").addEventListener("click", recheckConnection);
    $("connectSignIn").addEventListener("click", signInToMuse);
    $("connectApiKey").addEventListener("click", openApiKeyModal);
    $("connectUseSub").addEventListener("click", () => void setConnectionMode("subscription"));
    $("connMode").addEventListener("change", (e) => void setConnectionMode(e.target.value));
    $("apiKeyBtn").addEventListener("click", openApiKeyModal);
    $("apiKeyRemoveBtn").addEventListener("click", () => void removeApiKey());
    $("apiKeySave").addEventListener("click", () => void saveApiKey(false));
    $("apiKeyAnyway").addEventListener("click", () => void saveApiKey(true));
    $("apiKeyCancel").addEventListener("click", closeApiKeyModal);
    $("apiKeyInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void saveApiKey(false); } });
    $("apiKeyShow").addEventListener("click", () => maskApiKey($("apiKeyShow").getAttribute("aria-pressed") === "true"));
    $("apiKeyModal").addEventListener("click", (e) => { if (e.target === $("apiKeyModal")) closeApiKeyModal(); });
    $("connectCopy").addEventListener("click", () => navigator.clipboard.writeText($("connectCmd").textContent).then(() => toast("Command copied."), () => undefined));
    $("connectModal").addEventListener("click", (e) => { if (e.target === $("connectModal")) closeConnect(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen("connectModal")) closeConnect(); });
    window.addEventListener("focus", checkOnFocus);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("settingsPanel").classList.contains("hidden")) closeSettings(); });
    $("defEffortSelect").addEventListener("change", (e) => {
      if (PREMIUM_EFFORTS.has(e.target.value) && !confirmPremium(`Starting every new chat at ${e.target.selectedOptions[0].textContent} effort`)) { renderSettings(); return; }
      state.defaults.reasoningEffort = e.target.value;
      saveDefaults();
      if (state.currentId === "draft" && state.draft) { state.draft.reasoningEffort = e.target.value; applySetting({ reasoningEffort: e.target.value }, "Effort"); }
      else toast("New chats will start at " + e.target.selectedOptions[0].textContent + " effort.");
    });
    $("defApprovalSelect").addEventListener("change", (e) => {
      state.defaults.approvalMode = e.target.value;
      saveDefaults();
      if (state.currentId === "draft" && state.draft) { state.draft.approvalMode = e.target.value; applySetting({ approvalMode: e.target.value }, "Approval mode"); }
      else toast(e.target.value === "allowAll" ? "New chats will approve actions automatically." : "New chats will ask before actions.");
    });
    $("restartBtn").addEventListener("click", restartDashboard);
    $("museCheckBtn").addEventListener("click", async () => {
      try { state.env.muse = await api("POST", "/api/muse/update", {}); renderMuseBadge(); renderMusePanel(); }
      catch (e) { toast(e.message, true); }
    });
    $("searchBox").addEventListener("input", renderChatList);
    $("showHidden").addEventListener("change", (e) => { state.showHidden = e.target.checked; loadChats(); });
    $("showOther").addEventListener("change", (e) => { state.showOther = e.target.checked; loadChats(); });
    $("sidebarToggle").addEventListener("click", () => $("app").classList.toggle("side-collapsed"));
    let activityOpen = true;
    try { activityOpen = localStorage.getItem("muse.activityOpen") !== "0"; } catch { /* keep default */ }
    state.activityOpen = activityOpen;
    $("activityPanel").classList.toggle("closed", !activityOpen);
    $("activityToggle").addEventListener("click", () => setActivityOpen(!state.activityOpen));
    $("activityClose").addEventListener("click", () => setActivityOpen(false));
    const realChat = () => state.current && !state.current.draft;
    $("chatTitle").addEventListener("click", () => realChat() && renameChat(state.current.id, state.current.title));
    $("folderChip").addEventListener("click", () => {
      if (!state.current) return;
      if (state.current.draft) return chooseDraftFolder();
      navigator.clipboard.writeText(state.current.workspace || "").then(() => toast("Folder path copied"), () => toast(state.current.workspace));
    });
    const input = $("input");
    input.addEventListener("input", () => {
      autoGrow();
      // Typing into an existing chat: load its Muse session now so the send does not wait for the resume.
      if (state.current && !state.current.draft && input.value.trim()) warmChat(state.current.id, true);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
    });
    document.addEventListener("paste", (e) => {
      if (!$("folderModal").classList.contains("hidden")) return;
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); addBrowserFiles(files.map((file) => ({ file, isDir: false }))); }
    });
    $("sendBtn").addEventListener("click", sendMessage);
    $("stopBtn").addEventListener("click", stopTurn);
    $("compactBtn").addEventListener("click", compactCurrent);
    $("attachBtn").addEventListener("click", () => $("fileInput").click());
    $("fileInput").addEventListener("change", (e) => { addBrowserFiles([...e.target.files].map((file) => ({ file, isDir: false }))); e.target.value = ""; });
    // Drop anywhere in the window.
    let dragDepth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
    window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth += 1; $("dropOverlay").classList.remove("hidden"); });
    window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("dropOverlay").classList.add("hidden"); });
    window.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "link"; });
    window.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      $("dropOverlay").classList.add("hidden");
      if (!$("folderModal").classList.contains("hidden")) return;
      const out = [];
      const items = [...(e.dataTransfer.items || [])];
      if (items.length) {
        for (const it of items) {
          if (it.kind !== "file") continue;
          const entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
          const file = it.getAsFile();
          if (file) out.push({ file, isDir: !!(entry && entry.isDirectory) });
        }
      } else for (const file of e.dataTransfer.files) out.push({ file, isDir: false });
      addBrowserFiles(out);
    });
    $("pathGo").addEventListener("click", () => browse($("pathInput").value.trim()));
    $("pathInput").addEventListener("keydown", (e) => { if (e.key === "Enter") browse($("pathInput").value.trim()); });
    $("rootsBtn").addEventListener("click", () => browse(null));
    $("showDotDirs").addEventListener("change", () => browse(browsePath));
    $("modalCancel").addEventListener("click", () => closePicker(null));
    $("autoFolderBtn").addEventListener("click", () => closePicker(AUTO));
    $("nativePickBtn").addEventListener("click", async () => {
      const btn = $("nativePickBtn");
      btn.disabled = true;
      $("modalError").textContent = "";
      try {
        const r = await api("POST", "/api/fs/pick", { start: browsePath || "" });
        if (r.path && pickerResolve) closePicker(r.path);
      } catch (e) {
        $("modalError").textContent = e.message;
      } finally {
        btn.disabled = false;
      }
    });
    $("modalOk").addEventListener("click", () => browsePath && closePicker(browsePath));
    $("folderModal").addEventListener("click", (e) => { if (e.target === $("folderModal")) closePicker(null); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("folderModal").classList.contains("hidden")) closePicker(null); });
  }

  async function init() {
    wire();
    try {
      state.env = await api("GET", "/api/state");
      $("envInfo").textContent = `Approvals: ${state.env.approvalMode} · Sandbox: ${state.env.sandbox ? "on" : "off"}${state.env.sandboxFallback ? " (auto-fallback if unavailable)" : ""}\nProject folders: ${state.env.projectsDir}`;
      $("envInfo").title = state.env.muse.bin ? state.env.muse.bin.bin : "";
    } catch (e) {
      toast(`Dashboard error: ${e.message}`, true);
      state.env = { recents: [], muse: {} };
    }
    setConnection(connectionOf()); // opens the Connect dialog if Muse is already known not to be ready
    connectEvents();
    openDraft(); // blank starter chat on load; the name popup appears when the user clicks New chat
    void loadModels();
    void loadUsage();
    await loadChats();
    renderMuseBadge();
    // Back from Settings > Restart: reopen the chat that was open, with its unsent text.
    let restore = null;
    try { restore = JSON.parse(sessionStorage.getItem("md-restore") || "null"); sessionStorage.removeItem("md-restore"); } catch { /* none */ }
    if (restore && restore.chatId) await openChat(restore.chatId);
    if (restore && restore.text) { $("input").value = restore.text; autoGrow(); }
  }
  init();
})();
