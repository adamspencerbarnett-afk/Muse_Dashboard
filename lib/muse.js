// Muse Dashboard · lib/muse.js
// Author: Adam S. Barnett
//
// Muse Code host manager. Starts `muse serve` (one shared host for all chats
// by default) through the official @muse-code/sdk, which is pinned to the
// installed Muse version, and drives sessions with it: start, resume, send,
// stop, approvals, model / effort / approval settings, history paging,
// subagents and usage. Every notification from the host is also forwarded to
// the browser over Server-Sent Events.
import os from "node:os";
import path from "node:path";
import { pidOfMuseChild } from "./reaper.js";
import { spawnMspConnection, MuseClient, readSessionDurability } from "@muse-code/sdk";
import { httpError } from "./util.js";
import { resolveMuse } from "./install.js";
import { withMetaApiKey } from "./api-key.js";
import { agentActive, agentUsage, agentTotals, sumAgents } from "./agents.js";

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export const APPROVAL_MODES = ["allowAll", "promptUnmatched", "onRequest", "denyUnmatched"];

const SUPPORTED_SCHEMA_VERSION = 1;
const LIST_TTL_MS = 2000; // session/list is cheap but the sidebar asks in bursts

export class MuseHosts {
  #config;
  #store;
  #emit;
  #hosts = new Map(); // key -> { workspace, ready: Promise<host>, host?, dead }
  #sessions = new Map(); // sessionId -> { session, host, workspace, activeTurnId }
  #loading = new Map(); // sessionId -> Promise<session>
  #approvals = new Map(); // key -> { resolve, request, sessionId }
  #sessionInfo = new Map(); // sessionId -> last wire Session seen (from list/start/resume)
  #usage = new Map(); // sessionId -> { cumulative, context, updatedAt } (latest session/tokenUsage + contextUsage)
  #turnStats = new Map(); // sessionId -> { turnId, steps, input, cached, output } for the latest turn
  #agents = new Map(); // sessionId -> Map(itemId -> latest subagent/workflow item seen live)
  #children = new Map(); // sessionId -> Set of child session ids seen (live or in history), for read-only transcripts
  #subUsage = null; // last subscription usage the host reported (usage/changed or usage/read)
  #warm = new Set(); // sessions whose view this host has opened (the first read of a session is the slow one)
  #lastUsed = new Map(); // sessionId -> ms of the last command, for unloading idle sessions
  #listCache = null; // { at, rows }
  #historyCache = new Map(); // sessionId -> { head, turns, result }: the last opened history, valid while the view's newest cursor is unchanged
  #reaper = null;
  #gate = Promise.resolve(); // spawns wait (briefly) for the startup update check
  #restartPending = null; // why a restart is waiting for idle ("update", "signIn", "connection"), or null
  #metaApiKey = null; // META_API_KEY for the hosts (Settings → Connection); null = none, so Muse uses its own Meta sign-in
  #clientVersion;
  status = { state: "notStarted" }; // last host handshake facts, for the header

  constructor({ config, store, emit, clientVersion = "0.0.0" }) {
    this.#config = config;
    this.#store = store;
    this.#emit = emit;
    this.#clientVersion = clientVersion;
  }

  get binInfo() {
    const r = resolveMuse(this.#config);
    return { bin: r.bin, how: r.how, version: r.version };
  }

  /** Make the first host spawn wait for `promise` (at most `maxMs`). */
  setStartGate(promise, maxMs) {
    this.#gate = Promise.race([promise.catch(() => undefined), new Promise((r) => setTimeout(r, maxMs))]);
  }

  get #shared() {
    return this.#config.sharedHost !== false;
  }

  #key(ws) {
    if (this.#shared) return "shared";
    return process.platform === "win32" ? path.resolve(ws).toLowerCase() : path.resolve(ws);
  }

  /** Is a turn running or waiting on an approval? */
  busy() {
    return !this.#idle();
  }

  /** Where host process ids are reported so they can never be orphaned. */
  setReaper(reaper) {
    this.#reaper = reaper;
  }

  #idle() {
    if (this.#approvals.size) return false;
    for (const s of this.#sessions.values()) if (s.activeTurnId) return false;
    for (const id of this.#agents.keys()) if (this.activeAgents(id).length) return false;
    return true;
  }

  /** Restart the Muse host(s) as soon as nothing is running: after an update ("update"), a new sign-in ("signIn") or a new connection ("connection"). */
  restartWhenIdle(reason = "update") {
    this.#restartPending = reason;
    this.#maybeRestart();
  }

  #maybeRestart() {
    if (!this.#restartPending || !this.#idle()) return;
    const reason = this.#restartPending;
    this.#restartPending = null;
    console.log(`[muse] restarting the Muse host (${{ signIn: "new sign-in", connection: "new connection" }[reason] || "new version"})`);
    void this.closeAll().then(() => this.#emit("muse-restarted", { reason }));
  }

  /** The API key Muse runs with (null: its own Meta sign-in). A change restarts the hosts once nothing is running. */
  setMetaApiKey(key) {
    if ((key || null) === this.#metaApiKey) return;
    this.#metaApiKey = key || null;
    if (this.#hosts.size) this.restartWhenIdle("connection");
  }

  async host(workspace) {
    const key = this.#key(workspace);
    const cur = this.#hosts.get(key);
    if (cur && !cur.dead) return cur.ready;
    const rec = { workspace, dead: false };
    rec.ready = this.#spawn(workspace, rec, false).catch((e) => {
      rec.dead = true;
      this.#hosts.delete(key);
      throw e;
    });
    this.#hosts.set(key, rec);
    return rec.ready;
  }

  async #anyHost() {
    for (const rec of this.#hosts.values()) if (!rec.dead) return rec.ready;
    return this.host(this.#config.hostCwd || os.homedir());
  }

  async #spawn(workspace, rec, disableSandboxForFallback) {
    await this.#gate;
    const { bin, env, version } = resolveMuse(this.#config);
    const cwd = this.#shared ? this.#config.hostCwd || os.homedir() : workspace;
    const args = [...(this.#config.museArgs || []), "serve"];
    if (this.#config.sandbox === false || disableSandboxForFallback) args.push("--disable-sandbox");
    if (this.#config.sandboxNetwork) args.push("--sandbox-network", String(this.#config.sandboxNetwork));
    if (this.#config.trustWorkspace) args.push("--trust-workspace");
    // Host-wide Muse settings (`-c key=<json>`); Muse refuses unknown keys, so a typo fails the start loudly.
    for (const [key, value] of Object.entries(this.#config.museSettings || {})) args.push("-c", `${key}=${JSON.stringify(value)}`);
    // The execution policy rides every request as Muse's developer prompt (unless museSettings sets one itself).
    if (this.#config.developerPromptText && !(this.#config.museSettings || {})["run.developer_prompt"]) args.push("-c", `run.developer_prompt=${JSON.stringify(this.#config.developerPromptText)}`);
    const stderr = [];
    const handshake = spawnMspConnection({
      command: bin,
      args,
      cwd,
      env: withMetaApiKey({ ...process.env, ...env }, this.#metaApiKey),
      onStderr: (chunk) => {
        stderr.push(chunk);
        if (stderr.length > 50) stderr.shift();
        if (this.#config.debug) process.stderr.write(`[muse ${path.basename(workspace)}] ${chunk}`);
      },
    });
    const pid = pidOfMuseChild(handshake.child);
    this.#reaper?.track(pid);
    handshake.exited.then(() => this.#reaper?.untrack(pid), () => this.#reaper?.untrack(pid));
    let spawned;
    try {
      spawned = await handshake.initialize({
        clientInfo: { name: "muse_dashboard", title: "Muse Dashboard", version: this.#clientVersion },
        // The page has no ask-the-user dialog, so the host withholds those
        // questions instead of leaving a turn waiting forever.
        capabilities: { userInputDialogs: false },
      });
    } catch (e) {
      await handshake.close().catch(() => undefined);
      const tail = stderr.join("").trim().split(/\r?\n/).slice(-8).join("\n");
      this.status = { state: "error", message: e.message, bin };
      this.#emit("host-status", this.status);
      throw httpError(502, `Could not start "${bin} serve": ${e.message}${tail ? `\n${tail}` : ""}`);
    }
    const init = spawned.initializeResult || {};
    // Compatibility: the envelope schema version is the hard contract. A newer
    // *fingerprint* only means fields/methods were added (the SDK tolerates
    // that and we ignore what we don't know); a different *version* means the
    // wire format itself changed, which this SDK cannot speak.
    if (init.schema && init.schema.version !== SUPPORTED_SCHEMA_VERSION) {
      await spawned.close?.().catch(() => undefined);
      const msg = `This Muse (${init.serverInfo?.version || "unknown version"}) speaks protocol schema v${init.schema.version}, but the dashboard's @muse-code/sdk speaks v${SUPPORTED_SCHEMA_VERSION}. The dashboard needs a newer SDK bundled (see README, "If a Muse update breaks the dashboard").`;
      this.status = { state: "incompatible", message: msg, serverVersion: init.serverInfo?.version };
      this.#emit("host-status", this.status);
      throw httpError(502, msg);
    }
    if (spawned.fingerprintWarning) console.warn(`[muse] ${spawned.fingerprintWarning.message}`);
    // Sandbox unavailable (e.g. Windows elevated setup has not run): do not
    // brick every tool call. Restart once without sandbox enforcement so the
    // chat still works; approvals still gate actions. Opt out with
    // "sandboxFallback": false, or restore the sandbox by running Muse's
    // elevated sandbox setup outside the dashboard, then restarting it.
    const sandboxUnavailable = init.sandboxAvailability === "unavailable";
    if (sandboxUnavailable && this.#config.sandbox !== false && !disableSandboxForFallback && this.#config.sandboxFallback !== false) {
      console.warn(`[muse] sandbox unavailable${init.sandboxUnavailableReason ? ` (${init.sandboxUnavailableReason})` : ""}; restarting Muse without sandbox enforcement (sandboxFallback). Approvals still apply. Run Muse's elevated sandbox setup to restore sandboxing.`);
      this.status = { state: "starting", sandbox: init.sandboxAvailability, sandboxUnavailableReason: init.sandboxUnavailableReason || null, sandboxEffective: "off-fallback", sandboxFallback: true, bin };
      this.#emit("host-status", this.status);
      await spawned.close?.().catch(() => undefined);
      return this.#spawn(workspace, rec, true);
    }
    this.status = {
      state: "ready",
      serverName: init.serverInfo?.name,
      serverVersion: init.serverInfo?.version || version,
      schemaVersion: init.schema?.version,
      schemaDrift: !!spawned.fingerprintWarning,
      sandbox: init.sandboxAvailability,
      sandboxUnavailableReason: init.sandboxUnavailableReason || null,
      sandboxEffective: disableSandboxForFallback ? "off-fallback" : this.#config.sandbox === false ? "off" : sandboxUnavailable ? "unavailable" : "on",
      sandboxFallback: !!disableSandboxForFallback,
      bin,
    };
    this.#emit("host-status", this.status);
    const connection = spawned.connection;
    // Tap every inbound notification before the SDK's router sees it.
    const original = connection.onNotification.bind(connection);
    connection.onNotification = (handler) =>
      original((n) => {
        try {
          this.#tap(n);
        } catch (err) {
          console.error("tap error:", err);
        }
        handler(n);
      });
    const client = new MuseClient(connection, {
      durability: readSessionDurability(spawned.initializeResult),
      host: spawned,
    });
    const host = { client, connection, workspace, init: spawned.initializeResult, stderr };
    rec.host = host;
    // Which model will new sessions use? Best effort: older/newer hosts may not have model/list.
    connection
      .request("model/list", {})
      .then((r) => {
        const models = Array.isArray(r?.models) ? r.models : Array.isArray(r) ? r : [];
        const active = models.find((m) => m && m.isActive) || null;
        const id = this.#config.model || active?.modelId || active?.id || null;
        if (id) {
          this.status = { ...this.status, model: id };
          this.#emit("host-status", this.status);
        }
      })
      .catch(() => undefined);
    client.exit.then((exit) => {
      rec.dead = true;
      this.#warm.clear();
      this.#listCache = null;
      if (this.#hosts.get(this.#key(workspace)) === rec) this.#hosts.delete(this.#key(workspace));
      if (this.status.state === "ready") {
        this.status = { ...this.status, state: "stopped" };
        this.#emit("host-status", this.status);
      }
      for (const [id, s] of this.#sessions) {
        if (s.host === host) {
          this.#sessions.delete(id);
          this.#agents.delete(id); // its children died with the host
          this.#emit("session-unloaded", { sessionId: id });
        }
      }
      if (exit.kind !== "cleanShutdown") {
        const tail = (exit.stderrTail || []).join("\n");
        console.error(`[muse] host for ${workspace} exited: ${exit.kind} ${tail}`);
        this.#emit("host-exit", { workspace, kind: exit.kind, detail: tail.slice(-2000) });
      }
    });
    console.log(`[muse] host ready (${init.serverInfo?.name} ${init.serverInfo?.version}, schema v${init.schema?.version})`);
    return host;
  }

  #tap(n) {
    const params = n.params || {};
    if (n.method === "usage/changed") {
      this.#subUsage = params;
      this.#emit("usage", params);
      return;
    }
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string") return;
    if (n.method === "session/tokenUsage" && params.cumulative) {
      const u = this.#usage.get(sessionId) || {};
      u.cumulative = params.cumulative;
      u.updatedAt = new Date().toISOString();
      this.#usage.set(sessionId, u);
    }
    // One session/tokenUsage per model step: the live step/token meter and the step budget.
    if (n.method === "session/tokenUsage" && params.turnId) {
      let t = this.#turnStats.get(sessionId);
      if (!t || t.turnId !== params.turnId) this.#turnStats.set(sessionId, (t = { turnId: params.turnId, steps: 0, input: 0, cached: 0, output: 0 }));
      addStep(t, params);
      this.#emit("turn-stats", { sessionId, ...t });
    }
    if (n.method === "session/reasoningEffortChanged" && params.reasoningEffort) {
      const info = this.#sessionInfo.get(sessionId);
      if (info) info.reasoningEffort = params.reasoningEffort;
    }
    if (n.method === "session/contextUsage") {
      const u = this.#usage.get(sessionId) || {};
      u.context = { usedTokens: params.usedTokens, windowTokens: params.windowTokens, pressure: params.pressure };
      this.#usage.set(sessionId, u);
    }
    if (n.method === "session/modelChanged" && params.model?.modelId) {
      const info = this.#sessionInfo.get(sessionId);
      if (info) info.modelId = params.model.modelId;
    }
    if (n.method === "session/approvalModeChanged" && params.mode) {
      const info = this.#sessionInfo.get(sessionId);
      if (info) info.approvalMode = { ...info.approvalMode, mode: params.mode };
    }
    const s = this.#sessions.get(sessionId);
    if (s) {
      this.#lastUsed.set(sessionId, Date.now());
      if (n.method === "turn/started") s.activeTurnId = params.turnId;
      if (n.method === "turn/completed" || n.method === "turn/unqueued") {
        if (s.activeTurnId === params.turnId) s.activeTurnId = null;
        setTimeout(() => this.#maybeRestart(), 0);
      }
    }
    if (n.method === "approval/resolved") {
      for (const [key, a] of this.#approvals) {
        if (a.request.approvalId === params.approvalId) this.#approvals.delete(key);
      }
    }
    this.#emit("muse", { sessionId, method: n.method, params });
    if (n.method.startsWith("item/") && (params.item?.kind === "subagent" || params.item?.kind === "workflow")) this.#trackAgent(sessionId, params.item);
  }

  /**
   * A subagent or workflow item changed. Children keep running (and spending)
   * after the turn that started them ends, and their usage is never part of
   * the session's own token totals, so both are tracked here.
   */
  #trackAgent(sessionId, item) {
    let m = this.#agents.get(sessionId);
    if (!m) this.#agents.set(sessionId, (m = new Map()));
    const prev = m.get(item.itemId);
    if (prev && (item.revision ?? 0) < (prev.revision ?? 0)) return;
    m.set(item.itemId, {
      kind: item.kind, itemId: item.itemId, turnId: item.turnId || null, revision: item.revision, status: item.status, changedAt: Date.now(),
      controlStatus: item.controlStatus, stopAvailable: item.stopAvailable, subagentId: item.subagentId, workflowRunId: item.workflowRunId, usage: item.usage || prev?.usage,
    });
    if (item.childSessionId) this.#noteChild(sessionId, item.childSessionId);
    if (item.kind === "subagent" && item.usage) this.#recordAgentUsage(sessionId, item);
    const stats = this.agentStats(sessionId, item.turnId);
    this.#emit("agent-stats", { sessionId, ...stats });
    if (!stats.active) setTimeout(() => this.#maybeRestart(), 0);
  }

  #noteChild(sessionId, childId) {
    let set = this.#children.get(sessionId);
    if (!set) this.#children.set(sessionId, (set = new Set()));
    set.add(childId);
  }

  /** Persist a subagent's latest usage under its item id (idempotent: re-reading history cannot double count). */
  #recordAgentUsage(sessionId, item) {
    const meta = this.#store.chat(sessionId);
    const u = agentUsage(item);
    if (!meta || !u) return;
    const v = [u.input, u.cached, u.output];
    const cur = meta.agentItems?.[item.itemId];
    if (Array.isArray(cur) && cur.join() === v.join()) return;
    const agentItems = { ...(meta.agentItems || {}), [item.itemId]: v };
    this.#store.upsertChat(sessionId, { agentItems });
    this.#emit("chat-usage", { id: sessionId, tokenUsage: meta.tokenUsage || this.usageOf(sessionId), agentUsage: agentTotals(agentItems) });
  }

  /**
   * Working subagents with no update for `ms`, as [{ sessionId, itemId, ... }].
   * A child stuck in a tool call sends no updates and never finishes on its own.
   */
  stalledAgents(ms) {
    const now = Date.now();
    const out = [];
    for (const [sessionId, m] of this.#agents) for (const a of m.values()) if (a.kind === "subagent" && agentActive(a) && now - a.changedAt >= ms) out.push({ sessionId, ...a });
    return out;
  }

  /** Subagents and workflows of a session that are still working, as last seen live. */
  activeAgents(sessionId) {
    return [...(this.#agents.get(sessionId)?.values() || [])].filter(agentActive);
  }

  /** { turnId, active, count, input, cached, output }: children still working in the session, and the totals of one turn's children. */
  agentStats(sessionId, turnId) {
    const all = [...(this.#agents.get(sessionId)?.values() || [])];
    return { turnId: turnId || null, active: all.filter(agentActive).length, ...sumAgents(all.filter((a) => turnId && a.turnId === turnId)) };
  }

  /**
   * Stop every child still working: workflows are cancelled, subagents
   * stopped (workflow children too, in case their workflow item was not
   * seen). Returns how many stop commands Muse accepted.
   */
  async stopAgents(sessionId, reason = "Stopped from the dashboard") {
    const entry = this.#sessions.get(sessionId);
    if (!entry) return 0;
    let n = 0;
    for (const a of this.activeAgents(sessionId)) {
      const cmd = a.kind === "workflow"
        ? a.workflowRunId && ["workflow/cancel", { sessionId, workflowRunId: a.workflowRunId }]
        : a.subagentId && ["subagent/stop", { sessionId, subagentId: a.subagentId, reason }];
      if (!cmd) continue;
      try { await entry.host.connection.command(...cmd); n += 1; } catch (e) { this.#emit("app-error", { sessionId, message: `Could not stop a ${a.kind}: ${e.message}` }); }
    }
    return n;
  }

  #approvalHandler(sessionId) {
    return async (request) => {
      // Single source of truth: the chat's approvalMode. "allowAll" is handled
      // by the Muse host itself (it never sends a request); anything else
      // reaches here and always asks the user.
      const key = `${request.approvalId}#${request.currentRequirementId?.sourceIndex ?? 0}`;
      return new Promise((resolve) => {
        this.#approvals.set(key, { resolve, request, sessionId });
        this.#emit("approval-request", { sessionId, key, request });
      });
    };
  }

  #wire(session, host, workspace) {
    session.onApproval(this.#approvalHandler(session.sessionId));
    session.onApprovalError((f) => this.#emit("app-error", { sessionId: session.sessionId, message: `Approval failed (${f.kind})` }));
    const entry = { session, host, workspace, activeTurnId: null };
    this.#sessions.set(session.sessionId, entry);
    return entry;
  }

  pendingApprovals(sessionId) {
    const out = [];
    for (const [key, a] of this.#approvals) if (a.sessionId === sessionId) out.push({ key, request: a.request });
    return out;
  }

  decide(key, choiceId, feedback) {
    const a = this.#approvals.get(key);
    if (!a) throw httpError(404, "That approval is no longer pending.");
    const choice = (a.request.availableChoices || []).find((c) => c.choiceId === choiceId);
    if (!choice) throw httpError(400, "That choice was not offered for this approval.");
    this.#approvals.delete(key);
    setTimeout(() => this.#maybeRestart(), 0);
    const answer = { choiceId };
    if (feedback && choice.acceptsFeedback) answer.feedback = String(feedback).slice(0, 4000);
    a.resolve(answer);
    return { ok: true };
  }

  sessionInfo(sessionId) {
    return this.#sessionInfo.get(sessionId);
  }

  /** Latest cumulative token usage observed for a session, if any. */
  usageOf(sessionId) {
    return this.#usage.get(sessionId)?.cumulative || null;
  }

  /**
   * Visible model catalog with `activeModelId` flagged as active. The catalog
   * is host-wide, so this never loads a session (that would cost a resume).
   */
  async listModels(activeModelId) {
    const host = await this.#anyHost();
    const r = await host.connection.request("model/list", {});
    const models = (Array.isArray(r?.models) ? r.models : []).map((m) => (activeModelId ? { ...m, isActive: m.modelId === activeModelId } : m));
    return { models, providerId: r?.providerId ?? null, profileId: r?.profileId ?? null, source: r?.source ?? null };
  }

  async setModel(sessionId, workspace, modelId) {
    const entry = await this.ensureLoaded(sessionId, workspace);
    const r = await entry.host.connection.command("session/setModel", { sessionId, model: { modelId } });
    const info = this.#sessionInfo.get(sessionId);
    if (info) info.modelId = modelId;
    return r;
  }

  async setReasoningEffort(sessionId, workspace, reasoningEffort) {
    const entry = await this.ensureLoaded(sessionId, workspace);
    return entry.host.connection.command("session/setReasoningEffort", { sessionId, reasoningEffort });
  }

  async setApprovalMode(sessionId, workspace, mode) {
    const entry = await this.ensureLoaded(sessionId, workspace);
    return entry.host.connection.command("session/setApprovalMode", { sessionId, mode });
  }

  /** Apply stored per-chat prefs to a live session. Never throws; reports per-setting errors. */
  async applyChatPrefs(sessionId, workspace, prefs) {
    const out = {};
    if (!prefs) return out;
    if (prefs.modelId) {
      try { await this.setModel(sessionId, workspace, prefs.modelId); out.modelId = prefs.modelId; }
      catch (e) { out.modelError = e.message; }
    }
    if (prefs.reasoningEffort) {
      try { await this.setReasoningEffort(sessionId, workspace, prefs.reasoningEffort); out.reasoningEffort = prefs.reasoningEffort; }
      catch (e) { out.effortError = e.message; }
    }
    if (prefs.approvalMode) {
      try { await this.setApprovalMode(sessionId, workspace, prefs.approvalMode); out.approvalMode = prefs.approvalMode; }
      catch (e) { out.approvalError = e.message; }
    }
    return out;
  }

  async listSessions() {
    if (this.#listCache && Date.now() - this.#listCache.at < LIST_TTL_MS) return this.#listCache.rows;
    const host = await this.#anyHost();
    const all = [];
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const res = await host.connection.request("session/list", { limit: 200, ...(cursor ? { cursor } : {}) });
      for (const s of res.sessions || []) {
        all.push(s);
        this.#sessionInfo.set(s.sessionId, s);
      }
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    this.#listCache = { at: Date.now(), rows: all };
    return all;
  }

  async startChat(workspace) {
    const host = await this.host(workspace);
    const opts = { workspaceRoot: workspace };
    if (this.#config.approvalMode) opts.approvalMode = this.#config.approvalMode;
    if (this.#config.model) opts.modelId = this.#config.model;
    const session = await host.client.startSession(opts);
    this.#wire(session, host, workspace);
    const wire = session.opening?.result?.session;
    if (wire) this.#sessionInfo.set(session.sessionId, wire);
    return { sessionId: session.sessionId, session: wire };
  }

  /** Load (resume) a session for commands: sending, stopping, settings, compaction. Reading history never needs this. */
  async ensureLoaded(sessionId, workspace) {
    this.#lastUsed.set(sessionId, Date.now());
    const cur = this.#sessions.get(sessionId);
    if (cur) return cur;
    if (this.#loading.has(sessionId)) return this.#loading.get(sessionId);
    const p = (async () => {
      const host = await this.host(workspace);
      const session = await host.client.resumeSession({
        sessionId,
        excludeItems: true,
        onApproval: this.#approvalHandler(sessionId),
        onApprovalError: (f) => this.#emit("app-error", { sessionId, message: `Approval failed (${f.kind})` }),
      });
      const entry = { session, host, workspace, activeTurnId: null };
      const wire = session.opening?.result?.session;
      if (wire) {
        this.#sessionInfo.set(sessionId, wire);
        entry.activeTurnId = wire.activeTurnId ?? null;
      }
      // Registered only once its settings are applied, so a quick send cannot overtake them.
      await this.#alignPrefs(sessionId, entry, wire);
      this.#sessions.set(sessionId, entry);
      this.#warm.add(sessionId);
      return entry;
    })();
    this.#loading.set(sessionId, p);
    try {
      return await p;
    } finally {
      this.#loading.delete(sessionId);
      void this.#trimLoaded(sessionId);
    }
  }

  /**
   * Keep at most config.maxLoadedSessions sessions loaded by unloading the
   * least recently used idle ones. The session just loaded (`keep`) and any
   * used in the last minute are left alone: a command may be on its way.
   */
  async #trimLoaded(keep) {
    const max = Math.max(1, Number(this.#config.maxLoadedSessions) || 6);
    while (this.#sessions.size > max) {
      const now = Date.now();
      const victim = [...this.#sessions.keys()]
        .filter((id) => id !== keep && now - (this.#lastUsed.get(id) || 0) > 60000 && !this.#sessions.get(id).activeTurnId && !this.pendingApprovals(id).length && !this.activeAgents(id).length)
        .sort((a, b) => (this.#lastUsed.get(a) || 0) - (this.#lastUsed.get(b) || 0))[0];
      if (!victim) return;
      await this.unload(victim);
    }
  }

  /**
   * Open a session's view in the host without loading the session: the first
   * read of a session costs seconds, later ones milliseconds. Used to prewarm
   * chats the user is likely to open. Never throws.
   */
  async warm(sessionId, workspace) {
    if (this.#warm.has(sessionId) || this.#sessions.has(sessionId)) return;
    this.#warm.add(sessionId);
    try {
      const host = await this.host(workspace);
      await host.connection.request("view/page", { sessionId, direction: "backward", limit: 1 });
    } catch {
      this.#warm.delete(sessionId);
    }
  }

  /**
   * The newest `turns` turns of a session's durable view, folded into items,
   * read with view/page (no lease, no resume). `before` (a view cursor from an
   * earlier call's `earlierCursor`) continues further back. Reminder items are
   * dropped, and each finished turn gets a `turnSummary` item with its step
   * and token totals (and its error, if it failed).
   */
  async readHistory(sessionId, workspace, { turns = 6, before } = {}) {
    const host = this.#sessions.get(sessionId)?.host || (await this.host(workspace));
    let head = null;
    if (!before) {
      // Re-opening a chat nothing happened in since: one tiny read instead of the whole tail.
      const top = await host.connection.request("view/page", { sessionId, direction: "backward", limit: 1 });
      head = top.events?.[0]?.params?.viewCursor || null;
      const hit = this.#historyCache.get(sessionId);
      if (hit && head && hit.head === head && hit.turns === turns) {
        this.#historyCache.delete(sessionId);
        this.#historyCache.set(sessionId, hit);
        return hit.result;
      }
    }
    const events = [];
    let cursor = before;
    let starts = 0;
    let more = true;
    while (starts < turns) {
      const res = await host.connection.request("view/page", { sessionId, direction: "backward", limit: 1000, ...(cursor ? { cursor } : {}) });
      const page = res.events || [];
      events.unshift(...page);
      starts += page.filter((e) => e.method === "turn/started").length;
      cursor = res.nextCursor;
      if (!cursor || !page.length) { more = false; break; }
    }
    this.#warm.add(sessionId);
    // Start at the turns-th newest turn/started; anything older is one "Load earlier" away.
    let cut = 0;
    for (let i = events.length - 1, seen = 0; i >= 0; i -= 1) {
      if (events[i].method === "turn/started" && ++seen === turns) { cut = i; break; }
    }
    // Older events with nothing to show (the session's setup before its first turn) need no "Load earlier".
    const older = more || events.slice(0, cut).some((e) => e.method.startsWith("item/"));
    const earlierCursor = older && events[cut] ? events[cut].params?.viewCursor || null : null;
    const items = new Map();
    const stats = {};
    for (const ev of events.slice(cut)) {
      foldEvent(items, ev.method, ev.params);
      const p = ev.params || {};
      if (ev.method === "session/tokenUsage" && p.turnId) addStep((stats[p.turnId] ||= { steps: 0, input: 0, cached: 0, output: 0 }), p);
      if (ev.method === "turn/completed" && p.turnId) {
        items.set(`turn:${p.turnId}`, {
          itemId: `turn:${p.turnId}`, kind: "turnSummary", turnId: p.turnId, terminal: p.terminal, durationMs: p.durationMs,
          error: p.terminal === "failed" ? p.error?.message || p.reason || null : null,
          ...(stats[p.turnId] || { steps: 0, input: 0, cached: 0, output: 0 }),
        });
      }
    }
    // Children's usage rides on their subagent items (it keeps growing after the turn ends): add it to each turn's summary.
    const byTurn = new Map();
    for (const it of items.values()) {
      if (it.kind !== "subagent") continue;
      if (it.childSessionId) this.#noteChild(sessionId, it.childSessionId);
      if (it.usage) this.#recordAgentUsage(sessionId, it);
      if (it.turnId) byTurn.set(it.turnId, [...(byTurn.get(it.turnId) || []), it]);
    }
    for (const it of items.values()) if (it.kind === "turnSummary" && byTurn.has(it.turnId)) it.agents = sumAgents(byTurn.get(it.turnId));
    let tokenUsage = null, contextUsage = null, reasoningEffort = null;
    for (const ev of events) {
      const p = ev.params || {};
      if (ev.method === "session/tokenUsage" && p.cumulative) tokenUsage = p.cumulative;
      if (ev.method === "session/contextUsage") contextUsage = { usedTokens: p.usedTokens, windowTokens: p.windowTokens, pressure: p.pressure };
      if (ev.method === "session/reasoningEffortChanged" && p.reasoningEffort) reasoningEffort = p.reasoningEffort;
    }
    if (!before && (tokenUsage || contextUsage)) {
      const u = this.#usage.get(sessionId) || {};
      if (tokenUsage) u.cumulative = tokenUsage;
      if (contextUsage) u.context = contextUsage;
      this.#usage.set(sessionId, u);
    }
    const live = this.#usage.get(sessionId) || {};
    const result = {
      items: [...items.values()].filter((i) => !String(i.kind || "").toLowerCase().startsWith("reminder")),
      earlierCursor,
      tokenUsage: tokenUsage || live.cumulative || null,
      contextUsage: contextUsage || live.context || null,
      reasoningEffort: reasoningEffort || this.#sessionInfo.get(sessionId)?.reasoningEffort || null,
    };
    if (head) {
      this.#historyCache.delete(sessionId);
      this.#historyCache.set(sessionId, { head, turns, result });
      if (this.#historyCache.size > 8) this.#historyCache.delete(this.#historyCache.keys().next().value);
    }
    return result;
  }

  /** Running turn, its step/token totals so far, and pending approvals, as far as this dashboard's host knows them. */
  liveState(sessionId) {
    const activeTurnId = this.#sessions.get(sessionId)?.activeTurnId || null;
    const stats = this.#turnStats.get(sessionId);
    return { activeTurnId, turnStats: activeTurnId && stats?.turnId === activeTurnId ? stats : null, approvals: this.pendingApprovals(sessionId), agentsActive: this.activeAgents(sessionId).length };
  }

  /**
   * Read-only transcript of one of a session's subagents (its own session in
   * Muse's store), folded like history. Only children this dashboard has seen
   * in that session's items can be read.
   */
  async readChild(sessionId, childSessionId, workspace) {
    if (!this.#children.get(sessionId)?.has(childSessionId)) throw httpError(404, "That subagent is not part of this chat.");
    const host = this.#sessions.get(sessionId)?.host || (await this.host(workspace));
    const events = [];
    let cursor;
    for (let page = 0; page < 5; page += 1) {
      const res = await host.connection.request("view/page", { sessionId: childSessionId, direction: "backward", limit: 1000, ...(cursor ? { cursor } : {}) });
      events.unshift(...(res.events || []));
      cursor = res.nextCursor;
      if (!cursor || !(res.events || []).length) break;
    }
    const items = new Map();
    for (const ev of events) foldEvent(items, ev.method, ev.params);
    return [...items.values()]
      .filter((i) => ["userMessage", "agentMessage", "toolCall", "userShell"].includes(i.kind))
      .map((i) => ({ kind: i.kind, status: i.status, text: String(i.displayText || i.text || "").slice(0, 4000), tool: i.tool || (i.kind === "userShell" ? "shell" : undefined), label: i.displayLabel?.done || i.commandText || undefined }));
  }

  /**
   * The subscription's 5-hour and weekly usage, as last reported by Muse (it
   * reports as replies run). Once a window's reset time has passed, Muse is
   * asked again, and a window it still has no newer figure for shows as reset.
   */
  async subscriptionUsage() {
    const due = !this.#subUsage || rollUsage(this.#subUsage) !== this.#subUsage;
    if (due) {
      try {
        const host = await this.#anyHost();
        const r = await host.connection.request("usage/read", {});
        if (r?.usage && (r.usage.observedAtMs || 0) >= (this.#subUsage?.observedAtMs || 0)) this.#subUsage = r.usage;
      } catch { /* host not up yet */ }
    }
    return rollUsage(this.#subUsage);
  }

  /**
   * A resumed session keeps the approval mode and model it last had (e.g. a
   * terminal session still in its prompting default). Bring it in line with
   * the chat's stored prefs, falling back to the dashboard's approvalMode, so
   * "Approve all" holds for every chat opened here. Never throws.
   */
  async #alignPrefs(sessionId, entry, wire) {
    const meta = this.#store.chat(sessionId) || {};
    const command = (method, params) =>
      entry.host.connection.command(method, { sessionId, ...params }).catch((e) => {
        this.#emit("app-error", { sessionId, message: `Chat setting not applied: ${e.message}` });
        return null;
      });
    const mode = meta.approvalMode || this.#config.approvalMode;
    if (mode && APPROVAL_MODES.includes(mode) && wire?.approvalMode?.mode !== mode) {
      const r = await command("session/setApprovalMode", { mode });
      if (r && wire) wire.approvalMode = r.effectiveMode || { ...wire.approvalMode, mode };
    }
    if (meta.modelId && wire?.modelId && wire.modelId !== meta.modelId && !entry.activeTurnId) {
      const r = await command("session/setModel", { model: { modelId: meta.modelId } });
      if (r && wire) wire.modelId = meta.modelId;
    }
  }

  async send(sessionId, workspace, { input, displayText }) {
    const entry = await this.ensureLoaded(sessionId, workspace);
    const req = { input };
    if (displayText) req.displayText = displayText;
    const turn = await entry.session.sendUserTurn(req);
    turn.completed.catch(() => undefined);
    return { turnId: turn.turnId };
  }

  /**
   * The Stop button: interrupt the running turn, then stop its children.
   * turn/interrupt alone leaves subagents and workflows running (measured on
   * Muse 1.4.13), still spending with nothing on screen.
   */
  async interrupt(sessionId) {
    const entry = this.#sessions.get(sessionId);
    if (!entry) throw httpError(404, "That chat is not loaded.");
    let r = {};
    if (entry.activeTurnId || !this.activeAgents(sessionId).length) {
      const params = { sessionId };
      if (entry.activeTurnId) params.turnId = entry.activeTurnId;
      r = await entry.host.connection.command("turn/interrupt", params);
    }
    const agentsStopped = await this.stopAgents(sessionId);
    return { ...r, agentsStopped };
  }

  /** Manually compact a session's context (the /compact gesture). Refuses while a turn is running. */
  async compact(sessionId, workspace) {
    const entry = await this.ensureLoaded(sessionId, workspace);
    if (entry.activeTurnId) throw httpError(409, "Wait for the current reply to finish, then compact again.");
    return entry.host.connection.command("session/compact", { sessionId });
  }

  isTurnActive(sessionId) {
    return !!this.#sessions.get(sessionId)?.activeTurnId;
  }

  /** Best-effort unload (idle trimming, or before a chat is deleted). The session log stays in Muse's own store (it has no delete API). */
  async unload(sessionId) {
    const entry = this.#sessions.get(sessionId);
    if (!entry) return false;
    // Out of the registry first, so no command is handed an entry being left.
    this.#sessions.delete(sessionId);
    // The SDK keeps every Session object it opened (no close-by-id); a left one
    // must stop answering approvals, or a later reload of the chat would get
    // each approval request twice.
    entry.session.onApproval(undefined);
    entry.session.onApprovalError(undefined);
    this.#agents.delete(sessionId);
    try { await entry.host.connection.command("session/leave", { sessionId }); } catch { /* older/mock hosts may not support it */ }
    return true;
  }

  /** Drop everything kept about a deleted chat. */
  forget(sessionId) {
    for (const m of [this.#sessionInfo, this.#usage, this.#turnStats, this.#lastUsed, this.#historyCache, this.#agents, this.#children]) m.delete(sessionId);
    this.#warm.delete(sessionId);
  }

  async closeAll(budgetMs = 5000) {
    const all = [...this.#hosts.values()];
    this.#hosts.clear();
    await Promise.all(
      all.map(async (rec) => {
        try {
          const h = await rec.ready;
          await Promise.race([h.client.close(), new Promise((r) => setTimeout(r, budgetMs))]);
        } catch { /* ignore */ }
      }),
    );
  }
}

/**
 * Muse reports subscription usage only while replies run, so a figure taken
 * before a window's reset still shows the old percentage after it. Past its
 * reset time such a window is empty (0%, `rolledOver`) until Muse reports
 * again; its next reset time is unknown until then. Returns `u` itself when
 * nothing rolled over.
 */
export function rollUsage(u, now = Date.now()) {
  if (!u) return u;
  const stale = (w) => !!w && Number(w.resetsAtMs) > 0 && w.resetsAtMs <= now && (Number(u.observedAtMs) || 0) < w.resetsAtMs;
  if (!stale(u.window) && !stale(u.weekly)) return u;
  const roll = (w) => (stale(w) ? { ...w, usedPercent: 0, resetsAtMs: null, rolledOver: true } : w);
  return { ...u, window: roll(u.window), weekly: roll(u.weekly) };
}

/**
 * Add one model step (a session/tokenUsage) to per-turn totals. Input is the
 * server's counted-once promptTokens: whether the raw inputTokens include the
 * cached part depends on the provider.
 */
function addStep(t, params) {
  const usage = params.usage || {};
  t.steps += 1;
  t.input += Number(params.promptTokens ?? usage.inputTokens) || 0;
  t.cached += Number(usage.cacheReadTokens ?? usage.cachedTokens) || 0;
  t.output += Number(usage.outputTokens) || 0;
}

/** Item fold used for history pages (the browser applies the same rules live). */
function foldEvent(items, method, params) {
  if (!params) return;
  switch (method) {
    case "item/started":
    case "item/updated":
    case "item/completed": {
      const item = params.item;
      if (!item || !item.itemId) return;
      const prev = items.get(item.itemId);
      if (!prev || (item.revision ?? 0) >= (prev.revision ?? 0)) items.set(item.itemId, { ...item });
      return;
    }
    case "item/delta": {
      const it = items.get(params.itemId);
      if (!it) return;
      applyDelta(it, params.field, params.delta);
      return;
    }
    default:
  }
}

function applyDelta(item, field, delta) {
  const f = field || "text";
  if (f === "output") item.visibleOutput = (item.visibleOutput || "") + delta;
  else if (f.startsWith("summary.")) {
    const i = Number(f.slice(8));
    item.summary = Array.isArray(item.summary) ? [...item.summary] : [];
    item.summary[i] = (item.summary[i] || "") + delta;
  } else if (f === "text") item.text = (item.text || "") + delta;
}
