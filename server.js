#!/usr/bin/env node
// Muse Dashboard · server.js
// Author: Adam S. Barnett
//
// Entry point: a local web server for the Muse Dashboard, a browser UI for
// Meta's Muse Code. It serves the page in public/, exposes the JSON API and
// the live event stream the page uses, and drives Muse through lib/muse.js.
// It binds to 127.0.0.1 only, on a port the OS picks (or a preferred port
// that falls back automatically), protects every request with a per-run
// access token, and writes the real URL to data/runtime.json and
// .dashboard-url. A second launch reopens the running instance.
//
// Sections: configuration · single instance · state and budgets · Muse
// version and connection · HTTP helpers · chat helpers · folder browser ·
// routes · server start · auto-shutdown.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Store } from "./lib/store.js";
import { MuseHosts, REASONING_EFFORTS, APPROVAL_MODES } from "./lib/muse.js";
import { AGENT_MODES, agentDirective, agentTotals, workspaceTrust, trustFolder } from "./lib/agents.js";
import { folderGit, saveSnapshot, restoreSnapshot } from "./lib/snapshot.js";
import { githubLinksInText, githubAccounts, findClone, cloneRepo, excludeStarterFiles, githubRules } from "./lib/github.js";
import { ApiKeyStore, checkApiKey, looksLikeApiKey, CONNECTION_MODES, DEFAULT_META_API_BASE } from "./lib/api-key.js";
import { recycleCheck, moveToRecycleBin } from "./lib/recycle.js";
import { runUpdate, channelVersion, resolveMuse } from "./lib/install.js";
import { checkConnection, startSignIn, authFile, INSTALL_COMMAND } from "./lib/connect.js";
import { describePath, findDuplicate, IMAGE_EXT, MAX_IMAGE_BYTES } from "./lib/attach.js";
import { Reaper } from "./lib/reaper.js";
import { pickFolderNative } from "./lib/folder-dialog.js";
import { readJson, writeJsonAtomic, canonicalDir, samePath, httpError, safeFileName, uniquePath, openBrowser } from "./lib/util.js";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = "muse-dashboard";
const VERSION = (await readJson(path.join(APP_DIR, "package.json"), {})).version || "0.0.0";

// ---------- configuration ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const fileConfig = await readJson(path.resolve(opt("--config") || path.join(APP_DIR, "config.json")), {});
const config = {
  preferredPort: 0, // 0 = let the OS pick a free port
  open: true,
  museBin: null,
  approvalMode: "onRequest", // allowAll | promptUnmatched | onRequest | denyUnmatched
  sandbox: true,
  sandboxFallback: true, // if Muse reports sandbox unavailable, restart it once without sandbox instead of failing every tool call
  sandboxNetwork: null,
  trustWorkspace: false,
  model: null,
  reasoningEffort: null, // standing default for new chats; null = Muse default (high)
  maxUploadMB: 200,
  debug: false,
  autoUpdate: true, // run Muse's own updater (muse --version with MUSE_SYNC_UPDATE=1) at startup
  updateWaitSec: 20, // how long the first Muse start waits for that update check
  updateTimeoutSec: 900,
  idleShutdownSeconds: 120, // stop when no dashboard tab has been open this long (0 = never)
  historyTurns: 6, // turns shown when a chat opens; older ones load on demand
  maxLoadedSessions: 6, // sessions kept loaded in the Muse host; the least recently used idle ones are unloaded
  turnStepWarn: 80, // tell the user when one reply has taken this many model steps (0 = never)
  turnStepLimit: 250, // stop a reply after this many model steps (0 = no limit); each step re-sends the whole context
  museDeveloperPrompt: "EXECUTION-POLICY.md", // file (relative to the dashboard folder) sent to Muse as run.developer_prompt on every request; null = none
  agentMode: "solo", // Agents mode for chats without their own: solo (no subagents) | auto (Muse decides) | parallel
  agentHelperModel: "muse-spark-1.3", // model the parallel instruction asks workflow children to use
  agentHelperEffort: "medium",
  agentMaxChildren: 4, // children at once the parallel instruction allows (museSettings agents.execution_capacity is the hard cap)
  agentTokenWarn: 1500000, // tell the user when one reply's subagents have read this many input tokens (0 = never)
  agentTokenLimit: 4000000, // stop a reply's subagents and workflows past this many input tokens (0 = no limit)
  agentStallMinutes: 10, // tell the user when a working subagent has shown no progress this long (0 = never); it may be stuck in a command
  museSettings: null, // Muse settings passed to `muse serve` as `-c key=<json>` (e.g. "context_compaction.provider_context_limit_tokens": 256000)
  sharedHost: true, // one `muse serve` for all chats (each session has its own workspace root)
  projectsDir: null, // where per-chat project folders are created (default: <dashboard>/Projects)
  metaApiBaseUrl: DEFAULT_META_API_BASE, // where Settings → Connection checks an API key (GET <url>/models, no cost)
  testRecycleBin: null, // tests only: { dir, maxBytes, permanent } stands in for the Recycle Bin (lib/recycle.js)
  ...fileConfig,
};
if (opt("--port") !== undefined) config.preferredPort = Number(opt("--port")) || 0;
if (flag("--no-open")) config.open = false;
if (flag("--debug")) config.debug = true;
// Relative folders in config.json are relative to the dashboard folder, so a moved copy keeps working.
const DATA_DIR = opt("--data-dir") ? path.resolve(opt("--data-dir")) : path.resolve(APP_DIR, config.dataDir || "data");
const RUNTIME_FILE = path.join(DATA_DIR, "runtime.json");
const URL_FILE = path.join(APP_DIR, ".dashboard-url");
await fsp.mkdir(DATA_DIR, { recursive: true });
const PROJECTS_DIR = path.resolve(APP_DIR, config.projectsDir || "Projects");
await fsp.mkdir(PROJECTS_DIR, { recursive: true });
config.hostCwd = PROJECTS_DIR;
// The working rules sent to Muse with every request. Read once at startup;
// an edit applies after Settings > Restart.
const POLICY_FILE = config.museDeveloperPrompt ? path.resolve(APP_DIR, config.museDeveloperPrompt) : null;
config.developerPromptText = null;
if (POLICY_FILE) {
  try {
    config.developerPromptText = (await fsp.readFile(POLICY_FILE, "utf8")).trim() || null;
  } catch (e) {
    console.warn(`museDeveloperPrompt ${config.museDeveloperPrompt}: ${e.message}`);
  }
}

// ---------- single instance ----------
async function probe(url) {
  try {
    const ctl = AbortSignal.timeout(1500);
    const res = await fetch(new URL("api/health", url), { signal: ctl });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// runtime.json can be stale (crash, power loss, killed window). Only trust it when
// that exact instance answers its health check; otherwise start fresh.
const previous = await readJson(RUNTIME_FILE, null);
if (previous && !flag("--force-new")) {
  let h = previous.url ? await probe(previous.url) : null;
  // Still starting up, or busy: give a live process a few more seconds.
  for (let i = 0; !h && i < 3 && pidAlive(previous.pid) && previous.pid !== process.pid; i++) {
    await sleep(1000);
    h = await probe(previous.url);
  }
  const same = h && h.app === APP_NAME && h.instance === previous.instance;
  if (same && !h.stopping) {
    console.log(`Muse Dashboard is already running at ${previous.url}`);
    if (config.open && previous.launchUrl) openBrowser(previous.launchUrl);
    process.exit(0);
  }
  if (same && h.stopping) {
    console.log("The previous dashboard is shutting down; waiting for it to finish...");
    for (let i = 0; i < 40 && pidAlive(previous.pid); i++) await sleep(250);
  } else {
    console.log("Ignoring a stale data\\runtime.json from an earlier run.");
  }
  await fsp.rm(RUNTIME_FILE, { force: true }).catch(() => undefined);
}

// ---------- state and budgets ----------
// A Settings "Restart" leaves a short-lived handoff so the new instance keeps
// the same port and access token: the open page just reloads, no new link.
const RESTART_CODE = 75; // start-dashboard.bat / .sh start the server again on this exit code
// Read once and removed, so Muse and the shells its agents run do not inherit it
// (a test run from such a shell must not restart for real).
const SUPERVISED = process.env.MUSE_DASHBOARD_SUPERVISED === "1";
delete process.env.MUSE_DASHBOARD_SUPERVISED;
const HANDOFF_FILE = path.join(DATA_DIR, "restart.json");
const handoff = await readJson(HANDOFF_FILE, null);
await fsp.rm(HANDOFF_FILE, { force: true }).catch(() => undefined);
const resumed = !!handoff && Date.now() - Number(handoff.at) < 60000 && /^[0-9a-f]{48}$/.test(String(handoff.token)) && Number(handoff.port) > 0;
if (resumed) {
  config.preferredPort = Number(handoff.port);
  config.open = false;
}
const token = resumed ? handoff.token : crypto.randomBytes(24).toString("hex");
const instance = crypto.randomUUID();
const store = new Store(DATA_DIR);
await store.load();
// The dashboard folder was moved (or projectsDir changed): chat folders that moved along with Projects/ follow it.
if (store.data.projectsDir && !samePath(store.data.projectsDir, PROJECTS_DIR)) {
  const moved = store.rebase(store.data.projectsDir, PROJECTS_DIR, (p) => fs.existsSync(p));
  if (moved) console.log(`Projects folder moved: ${moved} chat folder(s) now point into ${PROJECTS_DIR}`);
}
if (!samePath(store.data.projectsDir, PROJECTS_DIR)) {
  store.data.projectsDir = PROJECTS_DIR;
  void store.save();
}
const sseClients = new Set();
function emit(type, payload) {
  if (type === "muse" && payload?.method === "turn/completed" && payload.sessionId) onTurnCompleted(payload.sessionId, payload.params);
  if (type === "turn-stats") checkStepBudget(payload);
  if (type === "agent-stats") checkAgentBudget(payload);
  if (type === "host-status") {
    onHostStatus(payload);
    return void emitMuseStatus(); // fold into the full version/update status
  }
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(data);
}
/** Save the chat's token total (existing records only: a terminal session never gets a record as a side effect). */
function onTurnCompleted(sessionId, params) {
  stepNotices.delete(`warn#${params?.turnId}`);
  stepNotices.delete(`stop#${params?.turnId}`);
  // Meta refused the API key, or the sign-in is missing or expired: show the Connect dialog.
  if (params?.error?.kind === "authRequired" && !["signedOut", "keyRefused"].includes(connection.state)) {
    const checkedAt = new Date().toISOString();
    setConnection(museKey ? { state: "keyRefused", message: "Meta refused the API key.", checkedAt } : { state: "signedOut", message: "Muse Code is not signed in to a Meta account.", checkedAt });
  }
  const meta = store.chat(sessionId);
  if (!meta) return;
  const u = muse.usageOf(sessionId);
  if (u) {
    store.upsertChat(sessionId, { tokenUsage: u });
    emit("chat-usage", { id: sessionId, tokenUsage: u, agentUsage: agentTotals(meta.agentItems) });
  }
}
// Every model step re-sends the whole context, so a runaway reply is the
// costliest failure: warn at turnStepWarn steps, stop at turnStepLimit.
const stepNotices = new Set();
function checkStepBudget({ sessionId, turnId, steps }) {
  const warn = Number(config.turnStepWarn) || 0;
  const limit = Number(config.turnStepLimit) || 0;
  if (limit && steps >= limit && !stepNotices.has(`stop#${turnId}`)) {
    stepNotices.add(`stop#${turnId}`);
    muse.interrupt(sessionId).then(
      () => emit("app-error", { sessionId, message: `Stopped this reply after ${steps} model steps (turnStepLimit). Send "continue" to keep going.` }),
      (e) => emit("app-error", { sessionId, message: `This reply reached ${steps} model steps (turnStepLimit) but could not be stopped: ${e.message}` }),
    );
  } else if (warn && steps === warn && !stepNotices.has(`warn#${turnId}`)) {
    stepNotices.add(`warn#${turnId}`);
    emit("app-notice", { sessionId, message: `This reply has taken ${steps} model steps. Each step re-sends the whole context; press Stop if it is going in circles.` });
  }
}
// Subagents have no per-step events on the parent, so their budget is in
// tokens: the input their model steps have read for one reply (cached included).
function checkAgentBudget({ sessionId, turnId, input }) {
  const warn = Number(config.agentTokenWarn) || 0;
  const limit = Number(config.agentTokenLimit) || 0;
  if (!turnId || !input) return;
  if (limit && input >= limit && !stepNotices.has(`agentstop#${turnId}`)) {
    stepNotices.add(`agentstop#${turnId}`);
    muse.stopAgents(sessionId, "agentTokenLimit").then(
      (n) => emit("app-error", { sessionId, message: `Stopped ${n} subagent run(s): they read ${Math.round(input / 1000)}k input tokens for this reply (agentTokenLimit).` }),
      (e) => emit("app-error", { sessionId, message: `Subagents passed agentTokenLimit but could not be stopped: ${e.message}` }),
    );
  } else if (warn && input >= warn && !stepNotices.has(`agentwarn#${turnId}`)) {
    stepNotices.add(`agentwarn#${turnId}`);
    emit("app-notice", { sessionId, message: `This reply's subagents have read ${Math.round(input / 1000)}k input tokens. Press Stop if that is more than the task is worth.` });
  }
}
/** Trust and isolation facts for a chat folder (see lib/agents.js). */
const trustOf = (workspace) => workspaceTrust(workspace, { trustAll: !!config.trustWorkspace });
const agentModeOf = (meta) => (AGENT_MODES.includes(meta?.agentMode) ? meta.agentMode : AGENT_MODES.includes(config.agentMode) ? config.agentMode : "auto");
const muse = new MuseHosts({ config, store, emit, clientVersion: VERSION });
// A subagent stuck in a tool call sends no updates and never finishes on its own: say so once, Stop stops it.
const stallMs = (Number(config.agentStallMinutes) || 0) * 60000;
if (stallMs > 0) {
  setInterval(() => {
    for (const a of muse.stalledAgents(stallMs)) {
      if (stepNotices.has(`stall#${a.itemId}`)) continue;
      stepNotices.add(`stall#${a.itemId}`);
      emit("app-notice", { sessionId: a.sessionId, message: `A subagent has shown no progress for ${Math.round((Date.now() - a.changedAt) / 60000) || "<1"} min; it may be stuck in a command. Press Stop to stop it.` });
    }
  }, Math.min(60000, Math.max(1000, stallMs / 2))).unref();
}
const reaper = new Reaper({ watchdog: config.watchdog !== false });
muse.setReaper(reaper);

// Drafts that never got a message or attachment leave nothing behind.
for (const c of Object.values(store.data.chats)) if (c.draft && !c.autoFolder) store.removeChat(c.id);

// ---------- Muse version and connection ----------
const museInfo = {
  installed: resolveMuse(config).version, // from Muse's own .muse-version file
  update: { state: autoUpdateState() },
  latest: null,
};
function autoUpdateState() {
  return config.autoUpdate === false ? "skipped" : "checking";
}
function museStatus() {
  return { ...museInfo, host: muse.status, bin: muse.binInfo };
}
function emitMuseStatus() {
  emit("muse-status", museStatus());
}
async function checkForUpdate() {
  museInfo.update = { state: autoUpdateState(), startedAt: new Date().toISOString() };
  emitMuseStatus();
  const r = await runUpdate(config);
  museInfo.update = { ...r, checkedAt: new Date().toISOString() };
  museInfo.installed = resolveMuse(config).version || r.version || museInfo.installed;
  if (r.state === "failed" || r.state === "skipped") {
    const latest = await channelVersion(config, updateAbort.signal);
    museInfo.latest = latest;
    if (latest && museInfo.installed && latest !== museInfo.installed) museInfo.update.available = latest;
  }
  console.log(`[update] ${r.message}`);
  if (r.state === "updated" && muse.status.state === "ready" && muse.status.serverVersion !== museInfo.installed) muse.restartWhenIdle();
  emitMuseStatus();
  return r;
}
// Exiting while the release-channel request is still resolving can crash Node
// on Windows (exit code 0xC0000409 instead of ours), so shutdown waits for it.
const updateAbort = new AbortController();
const updatePromise = checkForUpdate().catch((e) => {
  museInfo.update = { state: "failed", message: e.message };
  emitMuseStatus();
});
const startGate = Promise.race([updatePromise, sleep((Number(config.updateWaitSec) || 0) * 1000)]);
muse.setStartGate(startGate, (Number(config.updateWaitSec) || 0) * 1000);

// How Muse connects (Settings → Connection, lib/api-key.js): "subscription"
// (Muse's own Meta sign-in, no META_API_KEY), "apiKey" (the key saved here,
// encrypted by the OS) or "env" (the META_API_KEY the dashboard was started
// with; the default when one is set and nothing was chosen, as before this
// setting existed). The key is given only to the Muse processes the dashboard
// starts, and never sent to the page.
const apiKeys = new ApiKeyStore(DATA_DIR);
await apiKeys.load();
const ENV_API_KEY = process.env.META_API_KEY || null;
let museKey = null; // the key Muse runs with; null = its own Meta sign-in
let keyNotice = null; // why a saved key could not be used this run
const connectionVia = () => (keyNotice ? "subscription" : apiKeys.mode || (ENV_API_KEY ? "env" : "subscription"));
/** Give Muse the key for the chosen connection (`key`: the one just saved, so it need not be decrypted again). */
async function useConnection(key) {
  const via = connectionVia();
  museKey = via === "apiKey" ? key || (await apiKeys.read()) : via === "env" ? ENV_API_KEY : null;
  muse.setMetaApiKey(museKey);
}
try {
  await useConnection();
} catch (e) {
  keyNotice = `The saved API key could not be read (${e.message}), so Muse uses the subscription sign-in for now. Add the key again in Settings → Connection.`;
  await useConnection();
}

// Is Muse installed and signed in (or given a key)? Checked once Muse is
// current, again on request (Connect dialog) or a connection change, and
// whenever a reply fails for lack of a sign-in or a refused key.
// States: checking | connected | signedOut | keyRefused | notInstalled | hostError | unknown.
let connection = { state: "checking" };
let connectionCheck = null;
/** The connection as the page sees it: the check's state plus how Muse connects (the key's last 4 characters only). */
/**
 * Refuse a model the current connection does not offer (a subscription-only model on an API key, say):
 * Meta would fail every reply with "does not exist or you lack access". Muse's own list is the truth.
 */
async function assertModelOffered(modelId) {
  if (!modelId) return;
  let models;
  try { models = (await muse.listModels()).models; } catch { return; } // Muse not up yet: it answers for itself
  if (!models.length || models.some((m) => m.modelId === modelId)) return;
  const via = connectionVia() === "subscription" ? "your Muse Code subscription" : connectionVia() === "apiKey" ? "this API key" : "META_API_KEY";
  throw httpError(409, `${modelId} is not available with ${via}. Pick another model in the header: ${models.map((m) => m.modelId).join(", ")}.`);
}
function connectionView() {
  return { ...connection, via: connectionVia(), apiKey: apiKeys.saved, envKey: !!ENV_API_KEY, notice: keyNotice };
}
function setConnection(next) {
  const was = connection.state;
  connection = next;
  // A host started before the sign-in may still hold the old credentials.
  if ((was === "signedOut" || was === "notInstalled") && next.state === "connected") muse.restartWhenIdle("signIn");
  emit("connection", connectionView());
}
function refreshConnection() {
  connectionCheck ||= checkConnection(config, { metaApiKey: museKey }).then(setConnection).finally(() => { connectionCheck = null; });
  return connectionCheck;
}
/** After a connection change: wait out a check still running with the old key, then check with the new one. */
async function recheckConnection() {
  await connectionCheck;
  await refreshConnection();
}
/** A Muse host that fails to start is a connection problem too; a later successful start clears it. */
function onHostStatus(status) {
  if ((status.state === "error" || status.state === "incompatible") && ["checking", "connected", "unknown"].includes(connection.state)) {
    setConnection({ state: "hostError", message: status.message, checkedAt: new Date().toISOString() });
  } else if (status.state === "ready" && connection.state === "hostError") {
    void refreshConnection();
  }
}
// After "Sign in with Meta", watch Muse's credential file and check again as
// soon as it changes, so the page continues by itself (for up to 10 minutes).
// `before` is the file's time stamp from just before the sign-in started.
let signInWatch = null;
const authStamp = () => { try { return fs.statSync(authFile()).mtimeMs; } catch { return 0; } };
function watchSignIn(before) {
  clearInterval(signInWatch);
  const until = Date.now() + 10 * 60000;
  signInWatch = setInterval(() => {
    if (Date.now() > until || connection.state === "connected") return clearInterval(signInWatch);
    if (authStamp() !== before) { clearInterval(signInWatch); void refreshConnection(); }
  }, 1500);
  signInWatch.unref();
}
void startGate.then(refreshConnection);

// ---------- HTTP helpers ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const STATIC = {
  "/": path.join(APP_DIR, "public", "index.html"),
  "/app.js": path.join(APP_DIR, "public", "app.js"),
  "/style.css": path.join(APP_DIR, "public", "style.css"),
  "/favicon.svg": path.join(APP_DIR, "public", "favicon.svg"),
  "/vendor/marked.js": path.join(APP_DIR, "node_modules", "marked", "lib", "marked.umd.js"),
  "/vendor/purify.js": path.join(APP_DIR, "node_modules", "dompurify", "dist", "purify.min.js"),
  "/vendor/highlight.js": path.join(APP_DIR, "node_modules", "@highlightjs", "cdn-assets", "highlight.min.js"),
  "/vendor/hljs.css": path.join(APP_DIR, "node_modules", "@highlightjs", "cdn-assets", "styles", "github-dark.min.css"),
};
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" });
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function tokenOk(value) {
  if (typeof value !== "string" || value.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(token));
}
async function readBody(req, limitBytes) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) throw httpError(413, "Request too large.");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
async function readJsonBody(req, limitBytes = 64 * 1024 * 1024) {
  const buf = await readBody(req, limitBytes);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw httpError(400, "Invalid JSON.");
  }
}

// ---------- chat helpers ----------
function chatTitle(meta, s) {
  return (
    meta?.title ||
    s?.name ||
    s?.generatedName ||
    s?.title ||
    (s?.firstUserPrompt ? s.firstUserPrompt.slice(0, 60) : "") ||
    "New chat"
  );
}
function slugify(text) {
  const words = String(text || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean).slice(0, 10);
  return words.join("-").slice(0, 80).replace(/-+$/, "") || "chat";
}
/** Folder for a chat inside Projects/, named from the chat name the user gave (or a placeholder name). */
function chatFolderPath(id, text) {
  const base = path.join(PROJECTS_DIR, text ? slugify(text) : `new-chat-${id.replace(/-/g, "").slice(0, 6)}`);
  let dir = base;
  for (let i = 2; fs.existsSync(dir); i += 1) dir = `${base}-${i}`;
  return dir;
}
/**
 * Starter files for a project folder. The execution policy has Muse read
 * MASTER.md and LOG.md first, so every new folder gets both (a missing file
 * would show as a failed read in Activity). AGENTS.md is a short pointer that
 * Muse loads as project rules whenever it works in the folder, including from
 * the terminal; it names the one policy file in the dashboard folder, so the
 * policy is never copied per project. Existing files are never overwritten.
 */
// Inside the dashboard folder (Projects/) the policy is named by a relative path, so the link survives moving the dashboard.
function agentsSeed(workspace) {
  const inside = POLICY_FILE && isWithinDir(APP_DIR, workspace);
  const policy = !POLICY_FILE ? null : inside ? path.relative(workspace, POLICY_FILE).split(path.sep).join("/") : POLICY_FILE;
  return `# Project rules (loaded every session)

Muse Code reads this file as project rules when it runs in this folder.
${policy ? `
Standing operating guide: \`${policy}\` (${inside ? "relative to this folder; " : ""}quality first: boot from MASTER.md + LOG.md, read the files you change, verify through the real interface, log the entry). Chats started from the Muse Dashboard already have it in their instructions; otherwise read it before project work.
` : ""}
Project notes live in MASTER.md; session history in LOG.md.

## This project

(Chat-specific rules go here.)
`;
}
async function initProjectFiles(workspace, title, id) {
  const seeds = {
    "MASTER.md": `# ${title || "New chat"}\n\n- Chat id: ${id}\n- Created: ${new Date().toISOString()}\n\nProject notes for this chat.\n`,
    "LOG.md": `# LOG.md\n\n${new Date().toISOString().slice(0, 10)} — Chat ${id} created ("${title || "New chat"}").\n`,
    "AGENTS.md": agentsSeed(workspace),
  };
  for (const [name, body] of Object.entries(seeds)) {
    const file = path.join(workspace, name);
    try { await fsp.access(file); } catch { await fsp.writeFile(file, body, "utf8").catch(() => undefined); }
  }
}
/** Create this chat's own folder under Projects/ (once). Without a name it gets a placeholder name. */
async function ensureChatFolder(id, firstText) {
  const meta = store.chat(id);
  if (meta?.workspace) return meta.workspace;
  const name = meta?.title || firstText;
  const dir = chatFolderPath(id, name);
  await fsp.mkdir(dir, { recursive: true });
  const real = await fsp.realpath(dir);
  store.upsertChat(id, { workspace: real, autoFolder: true, placeholderName: !name });
  await initProjectFiles(real, name || "New chat", id);
  return real;
}
/** A folder made early (for a fallback upload) gets its real name with the first message. */
async function nameChatFolder(id, text) {
  const meta = store.chat(id);
  if (!meta?.autoFolder || !meta.placeholderName || !text) return null;
  const from = meta.workspace;
  const to = chatFolderPath(id, text);
  try {
    await fsp.rename(from, to);
  } catch {
    return null; // e.g. a file in it is open elsewhere: keep the placeholder name
  }
  store.upsertChat(id, { workspace: to, placeholderName: false });
  return { from, to };
}
function isWithinDir(root, p) {
  const r = path.relative(path.resolve(root), path.resolve(p));
  return !!r && !r.startsWith("..") && !path.isAbsolute(r);
}
/** p is root itself or inside it (path.relative compares case-insensitively on Windows). */
function isSameOrWithin(root, p) {
  return path.relative(path.resolve(root), path.resolve(p)) === "" || isWithinDir(root, p);
}
const STARTER_FILES = new Set(["MASTER.md", "LOG.md", "AGENTS.md"]);
/** Operating-system folders the dashboard never offers, works in or deletes. */
const SYSTEM_DIRS = process.platform === "win32"
  ? [process.env.SystemRoot, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramData].filter(Boolean)
  : ["/bin", "/boot", "/dev", "/etc", "/lib", "/opt", "/proc", "/sbin", "/sys", "/usr", "/System", "/Library", "/Applications"];
/** Delete a dashboard-made Projects folder nobody uses any more, but only while it holds nothing beyond the starter files. */
async function removeUnusedChatFolder(dir) {
  const resolved = path.resolve(dir);
  if (!isWithinDir(PROJECTS_DIR, resolved)) return false;
  try {
    if ((await fsp.readdir(resolved)).some((n) => !STARTER_FILES.has(n))) return false;
    await fsp.rm(resolved, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
/**
 * Why Delete must not touch this chat's folder, or null when it may go to the
 * Recycle Bin. The dashboard deletes only folders inside its Projects folder;
 * folders opened from elsewhere are the user's to delete. A folder another chat
 * still works in is kept too.
 */
async function folderDeleteBlock(dir, id) {
  let real;
  try { real = await fsp.realpath(dir); } catch { return null; } // already gone
  const projects = await fsp.realpath(PROJECTS_DIR).catch(() => PROJECTS_DIR);
  if (!isWithinDir(projects, real)) return "it is not inside the dashboard's Projects folder. The dashboard never deletes folders opened from elsewhere; delete it yourself if you no longer need it";
  for (const p of [APP_DIR, DATA_DIR]) if (isSameOrWithin(real, p)) return `it contains ${p}`;
  for (const [otherId, c] of Object.entries(store.data.chats)) {
    if (otherId === id || c.deleted || !c.workspace) continue;
    if (isSameOrWithin(real, c.workspace) || isWithinDir(c.workspace, real)) return `the chat "${c.title || "New chat"}" also uses it`;
  }
  return null;
}
/** What the New-chat popup needs to know about a folder the user picked. */
async function folderInfo(p) {
  const dir = await canonicalDir(p);
  const exists = async (n) => fsp.access(path.join(dir, n)).then(() => true, () => false);
  const missing = [];
  for (const n of ["AGENTS.md", "MASTER.md", "LOG.md"]) if (!(await exists(n))) missing.push(n);
  const usedBy = Object.values(store.data.chats).filter((c) => !c.deleted && c.workspace && path.relative(c.workspace, dir) === "").map((c) => c.title || "New chat");
  return { path: dir, name: path.basename(dir) || dir, hasAgents: !missing.includes("AGENTS.md"), missingStarterFiles: missing, usedBy, trusted: trustOf(dir).trusted, git: await folderGit(dir) };
}
/**
 * Existing project folders named in a message ("the game located here: C:\Users\me\Games\Neon. The ...").
 * Paths may contain spaces, so each match is trimmed back word by word / folder by folder until it exists;
 * a file resolves to its folder. Drive roots, the home folder and system folders are skipped. At most 3.
 */
async function foldersInText(text) {
  const found = [];
  const home = path.resolve(os.homedir());
  const trimEnd = (s) => s.replace(/[\s.,;:!?)\]}>]+$/, "");
  for (const m of String(text).slice(0, 20000).matchAll(/[A-Za-z]:[\\/][^\r\n"'`<>|?*]*/g)) {
    let cand = trimEnd(m[0]);
    let segmentsDropped = 0; // words after the path are trimmed freely; only one missing path segment (a file not made yet)
    for (let guard = 0; cand.length > 3 && guard < 60; guard++) {
      const st = await fsp.stat(cand).catch(() => null);
      if (st) {
        let dir;
        try { dir = await fsp.realpath(st.isDirectory() ? cand : path.dirname(cand)); } catch { break; }
        const skip = path.relative(path.parse(dir).root, dir) === "" || path.relative(home, dir) === "" || SYSTEM_DIRS.some((p) => isSameOrWithin(p, dir));
        if (!skip && !found.some((f) => path.relative(f, dir) === "")) found.push(dir);
        break;
      }
      const space = cand.lastIndexOf(" ");
      const sep = Math.max(cand.lastIndexOf("\\"), cand.lastIndexOf("/"));
      if (space > sep) cand = trimEnd(cand.slice(0, space));
      else if (sep > 3 && segmentsDropped++ === 0) cand = cand.slice(0, sep);
      else break;
    }
    if (found.length >= 3) break;
  }
  return Promise.all(found.map(folderInfo));
}
/** GitHub repository links in a message, each with an existing local clone (chat folders, recents, Projects/) when there is one. */
async function githubInText(text) {
  const links = githubLinksInText(text);
  if (!links.length) return { links, accounts: [] };
  const dirs = [];
  const add = (d) => { if (d && !dirs.some((x) => path.relative(x, d) === "")) dirs.push(d); };
  for (const c of Object.values(store.data.chats)) if (!c.deleted) add(c.workspace);
  for (const r of store.data.recents) add(r);
  for (const e of await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => [])) if (e.isDirectory()) add(path.join(PROJECTS_DIR, e.name));
  const existing = [];
  for (const d of dirs) if (await fsp.access(path.join(d, ".git")).then(() => true, () => false)) existing.push(d);
  const accounts = await githubAccounts();
  return { links: await Promise.all(links.map(async (l) => ({ ...l, clone: await findClone(l.url, existing) }))), accounts };
}
/** Clone a linked repository into Projects/<repo>, with starter files (local only) whose AGENTS.md carries the GitHub rules. */
async function cloneForChat(url, id) {
  const link = githubLinksInText(url)[0];
  if (!link) throw httpError(400, "That is not a GitHub repository link.");
  const accounts = await githubAccounts();
  let r;
  try {
    r = await cloneRepo(link, PROJECTS_DIR, { account: accounts[0] });
  } catch (e) {
    throw httpError(502, `Could not clone ${link.url}: ${e.message}`);
  }
  const had = new Set();
  for (const n of ["MASTER.md", "LOG.md", "AGENTS.md"]) if (await fsp.access(path.join(r.dir, n)).then(() => true, () => false)) had.add(n);
  await initProjectFiles(r.dir, link.repo, id || "-");
  const created = ["MASTER.md", "LOG.md", "AGENTS.md"].filter((n) => !had.has(n));
  // The repository's own AGENTS.md is never changed; then the rules go into the new MASTER.md.
  const rulesIn = created.includes("AGENTS.md") ? "AGENTS.md" : created.includes("MASTER.md") ? "MASTER.md" : null;
  if (rulesIn) await fsp.appendFile(path.join(r.dir, rulesIn), `\n${githubRules(link, r)}`, "utf8");
  await excludeStarterFiles(r.dir, created);
  return { ...link, path: r.dir, branch: r.branch, empty: r.empty, identity: r.identity, rulesIn, accounts };
}
/** Snapshot a picked folder for this chat (the "Save a snapshot first" tick); a failure never blocks the chat. */
async function snapshotForChat(id, dir) {
  try {
    const snap = await saveSnapshot(dir);
    store.upsertChat(id, { snapshot: snap });
    return { snapshot: { at: snap.at, files: snap.files, createdRepo: snap.createdRepo } };
  } catch (e) {
    return { snapshotError: e.message };
  }
}
async function workspaceFor(sessionId) {
  const meta = store.chat(sessionId);
  if (meta?.workspace) return meta.workspace;
  let s = muse.sessionInfo(sessionId);
  if (!s) {
    await muse.listSessions();
    s = muse.sessionInfo(sessionId);
  }
  if (!s) throw httpError(404, "Unknown chat.");
  if (!s.workspaceRoot) throw httpError(409, "This session has no recorded project folder.");
  return s.workspaceRoot;
}
const ID_RE = /^[0-9a-fA-F-]{8,64}$/;
function checkId(id) {
  if (!ID_RE.test(id)) throw httpError(400, "Bad chat id.");
  return id;
}

/**
 * The sidebar's chats. Muse keeps one session list per user account, shared by every dashboard copy and the
 * terminal, so a session belongs to this dashboard only when its index knows it or it works inside this
 * dashboard's Projects/ folder. Other sessions are listed (as `other`) only with includeOther.
 */
async function listChats(includeHidden, includeOther) {
  let sessions = [];
  let museError = null;
  try {
    sessions = await muse.listSessions();
  } catch (e) {
    museError = e.message;
  }
  const seen = new Set();
  const out = [];
  for (const s of sessions) {
    if (s.kind && s.kind !== "root") continue; // hide subagent child sessions
    if (s.sideFrom) continue; // side chats belong to their parent
    seen.add(s.sessionId);
    const meta = store.chat(s.sessionId);
    if (meta?.deleted) continue; // permanently deleted: never resurface, even with show-hidden
    if (meta?.hidden && !includeHidden) continue;
    const other = !meta && !(s.workspaceRoot && isSameOrWithin(PROJECTS_DIR, s.workspaceRoot));
    if (other && !includeOther) continue;
    out.push({
      other,
      id: s.sessionId,
      title: chatTitle(meta, s),
      workspace: meta?.workspace || s.workspaceRoot,
      updatedAt: s.lastActivityAt || s.updatedAt || meta?.createdAt,
      status: s.status,
      turnCount: s.turnCount,
      tokenUsage: meta?.tokenUsage || muse.usageOf(s.sessionId),
      agentUsage: meta?.agentItems ? agentTotals(meta.agentItems) : null,
      hidden: !!meta?.hidden,
      fromTerminal: !meta,
      createdByClient: s.createdByClient?.name,
    });
  }
  // Drafts, and chats we know about that Muse did not list (e.g. Muse unreachable).
  for (const meta of Object.values(store.data.chats)) {
    if (meta.deleted || seen.has(meta.id) || (meta.hidden && !includeHidden)) continue;
    out.push({ id: meta.id, title: meta.title || "New chat", workspace: meta.workspace, updatedAt: meta.createdAt, hidden: !!meta.hidden, draft: !!meta.draft, autoFolder: !!meta.autoFolder, unlisted: !meta.draft, tokenUsage: meta.tokenUsage || null, agentUsage: meta.agentItems ? agentTotals(meta.agentItems) : null });
  }
  for (const c of out) {
    if (!c.draft) c.autoFolder = !!store.chat(c.id)?.autoFolder;
    c.snapshotAt = store.chat(c.id)?.snapshot?.at || null;
    c.inProjects = !!c.workspace && isWithinDir(PROJECTS_DIR, c.workspace); // only these folders can be deleted (to the Recycle Bin)
  }
  out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return { chats: out, museError };
}

// The first read of a session in a fresh Muse host takes seconds; later reads
// take milliseconds. Warm the chats most likely to be opened next, one at a
// time, once per dashboard start. It is a log read: no model call, no tokens.
let prewarmed = false;
async function prewarm(chats) {
  for (const c of chats) await muse.warm(c.id, c.workspace);
}

// ---------- folder browser ----------
async function listFolders(p) {
  if (!p) {
    const roots = [];
    if (process.platform === "win32") {
      for (let c = 65; c <= 90; c += 1) {
        const d = `${String.fromCharCode(c)}:\\`;
        try {
          await fsp.access(d);
          roots.push({ name: d, path: d });
        } catch { /* not present */ }
      }
    } else {
      roots.push({ name: "/", path: "/" });
    }
    const home = os.homedir();
    const shortcuts = [{ name: "Home", path: home }];
    for (const n of ["Desktop", "Documents", "source", "repos", "Projects", "projects", "dev", "code"]) {
      const full = path.join(home, n);
      try {
        if ((await fsp.stat(full)).isDirectory()) shortcuts.push({ name: n, path: full });
      } catch { /* skip */ }
    }
    return { path: null, parent: null, entries: roots, shortcuts };
  }
  const dir = await canonicalDir(p);
  let entries = [];
  try {
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith("$"))
      .map((d) => ({ name: d.name, path: path.join(dir, d.name), hidden: d.name.startsWith(".") }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  } catch (e) {
    throw httpError(403, `Cannot read ${dir}: ${e.code || e.message}`);
  }
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, entries: entries.slice(0, 2000) };
}

// ---------- routes ----------
async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const method = req.method;
  const route = `${method} /${parts.slice(1).join("/")}`;

  if (route === "GET /events") {
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive" });
    res.write(`event: hello\ndata: ${JSON.stringify({ instance })}\n\n`);
    // The current Muse status and connection, in order with every later event:
    // whatever changed before this stream opened is not lost.
    res.write(`event: muse-status\ndata: ${JSON.stringify(museStatus())}\n\n`);
    res.write(`event: connection\ndata: ${JSON.stringify(connectionView())}\n\n`);
    res.clientId = String(url.searchParams.get("client") || "").slice(0, 64);
    sseClients.add(res);
    tabsChanged();
    // One comment line a minute, only so a dead connection is noticed eventually.
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 60000);
    req.on("close", () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
      tabsChanged();
    });
    return;
  }
  if (route === "POST /bye") {
    // navigator.sendBeacon from pagehide: a hint that this tab is going away.
    const id = String(url.searchParams.get("client") || "");
    for (const r of sseClients) if (id && r.clientId === id) r.leaving = true;
    tabsChanged();
    res.writeHead(204, SECURITY_HEADERS);
    return res.end();
  }
  if (route === "GET /state") {
    return sendJson(res, 200, {
      version: VERSION,
      platform: process.platform,
      home: os.homedir(),
      sep: path.sep,
      recents: store.data.recents,
      projectsDir: PROJECTS_DIR,
      muse: museStatus(),
      connection: connectionView(),
      installCommand: INSTALL_COMMAND,
      approvalMode: config.approvalMode,
      model: config.model || null,
      reasoningEffort: config.reasoningEffort || null,
      sandbox: config.sandbox !== false,
      sandboxFallback: config.sandboxFallback !== false,
      sandboxEffective: muse.status.sandboxEffective || null,
      sandboxUnavailableReason: muse.status.sandboxUnavailableReason || null,
      trustWorkspace: !!config.trustWorkspace,
      agentMode: agentModeOf(null),
    });
  }
  if (route === "GET /muse/status") return sendJson(res, 200, museStatus());
  // The Connect dialog: current state, "Check again", and "Sign in with Meta".
  if (route === "GET /connection") return sendJson(res, 200, connectionView());
  if (route === "POST /connection/check") {
    await refreshConnection();
    return sendJson(res, 200, connectionView());
  }
  if (route === "POST /connection/sign-in") {
    const before = authStamp();
    let r;
    try {
      r = await startSignIn(config, DATA_DIR);
    } catch (e) {
      throw httpError(500, `Could not start the Muse sign-in: ${e.message}`);
    }
    if (r.started) watchSignIn(before);
    return sendJson(res, 200, r);
  }
  // Settings → Connection. Each change answers with the connection after a fresh check.
  if (route === "POST /connection/api-key") {
    // Checked with Meta first (free), unless Meta was unreachable and the user chose "Save without checking".
    const body = await readJsonBody(req);
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!looksLikeApiKey(key)) throw httpError(400, "That does not look like an API key (16 or more characters, no spaces or quotes).");
    const check = body.skipCheck === true ? null : await checkApiKey(key, config.metaApiBaseUrl);
    if (check && !check.ok) throw httpError(check.reason === "refused" ? 422 : 502, check.message);
    try {
      await apiKeys.save(key);
      await apiKeys.setMode("apiKey");
    } catch (e) {
      throw httpError(500, `Could not save the key: ${e.message}`);
    }
    keyNotice = null;
    await useConnection(key);
    await recheckConnection();
    return sendJson(res, 200, { ...connectionView(), checked: !!check, models: check ? check.models.length : null, switchesAfterReply: muse.busy() });
  }
  if (route === "DELETE /connection/api-key") {
    await apiKeys.remove();
    keyNotice = null;
    await useConnection();
    await recheckConnection();
    return sendJson(res, 200, { ...connectionView(), switchesAfterReply: muse.busy() });
  }
  if (route === "POST /connection/mode") {
    const body = await readJsonBody(req);
    if (!CONNECTION_MODES.includes(body.mode)) throw httpError(400, "Unknown connection mode.");
    if (body.mode === "apiKey" && !apiKeys.saved) throw httpError(409, "Add an API key first.");
    if (body.mode === "env" && !ENV_API_KEY) throw httpError(409, "META_API_KEY was not set when the dashboard started.");
    // A key that cannot be decrypted leaves everything as it was (useConnection throws before changing the key).
    const before = { mode: apiKeys.mode, notice: keyNotice };
    await apiKeys.setMode(body.mode);
    keyNotice = null;
    try {
      await useConnection();
    } catch (e) {
      await apiKeys.setMode(before.mode);
      keyNotice = before.notice;
      throw httpError(500, `The saved API key could not be read (${e.message}). Add it again.`);
    }
    await recheckConnection();
    return sendJson(res, 200, { ...connectionView(), switchesAfterReply: muse.busy() });
  }
  if (route === "GET /models") {
    const sid = url.searchParams.get("sessionId");
    const active = sid ? store.chat(sid)?.modelId || muse.sessionInfo(sid)?.modelId : undefined;
    return sendJson(res, 200, await muse.listModels(active));
  }
  if (route === "GET /usage") return sendJson(res, 200, { usage: await muse.subscriptionUsage() });
  if (route === "POST /restart") {
    if (!SUPERVISED) throw httpError(409, "Restart works when the dashboard was started with start-dashboard.bat (or start-dashboard.sh). Stop it and start it that way.");
    if (muse.busy()) throw httpError(409, "A reply is still running or waiting for approval. Let it finish (or press Stop), then restart.");
    await writeJsonAtomic(HANDOFF_FILE, { port: PORT, token, at: Date.now() });
    sendJson(res, 200, { restarting: true });
    setTimeout(() => void shutdown(RESTART_CODE, "restart"), 100);
    return;
  }
  if (route === "POST /muse/update") {
    if (museInfo.update.state === "checking") return sendJson(res, 200, museStatus());
    void checkForUpdate();
    return sendJson(res, 200, museStatus());
  }
  if (route === "GET /chats") {
    const list = await listChats(url.searchParams.get("hidden") === "1", url.searchParams.get("other") === "1");
    if (!prewarmed && !list.museError) {
      prewarmed = true;
      void prewarm(list.chats.filter((c) => !c.draft && !c.other && c.workspace).slice(0, 3));
    }
    return sendJson(res, 200, list);
  }
  if (route === "POST /chats") {
    // Creates the project folder right away (Projects/<chat name>) unless an
    // existing project folder was chosen. The Muse session itself is still
    // created on the first message. Title comes from the New-chat name popup.
    const body = await readJsonBody(req);
    const id = crypto.randomUUID();
    const title = (typeof body.title === "string" ? body.title : typeof body.name === "string" ? body.name : "").trim().slice(0, 120);
    const patch = { draft: true, workspace: null, autoFolder: false };
    if (title) patch.title = title;
    if (typeof body.modelId === "string" && body.modelId.trim()) patch.modelId = body.modelId.trim().slice(0, 200);
    if (REASONING_EFFORTS.includes(body.reasoningEffort)) patch.reasoningEffort = body.reasoningEffort;
    if (APPROVAL_MODES.includes(body.approvalMode)) patch.approvalMode = body.approvalMode;
    if (AGENT_MODES.includes(body.agentMode)) patch.agentMode = body.agentMode;
    if (body.workspace) {
      patch.workspace = await canonicalDir(body.workspace);
      store.addRecent(patch.workspace);
      // Only when the user ticked "Add starter files"; existing files are never overwritten.
      if (body.seedProjectFiles === true) await initProjectFiles(patch.workspace, title || path.basename(patch.workspace), id);
    } else {
      const dir = chatFolderPath(id, title || null);
      await fsp.mkdir(dir, { recursive: true });
      patch.workspace = await fsp.realpath(dir);
      patch.autoFolder = true;
      patch.placeholderName = !title;
      await initProjectFiles(patch.workspace, title || "New chat", id);
    }
    store.upsertChat(id, patch);
    const snap = body.workspace && body.snapshot === true ? await snapshotForChat(id, patch.workspace) : {};
    return sendJson(res, 200, { id, workspace: patch.workspace, title: patch.title || null, autoFolder: !!patch.autoFolder, projectsDir: PROJECTS_DIR, ...snap });
  }
  if (parts[1] === "chats" && parts[2]) {
    const id = checkId(parts[2]);
    const sub = parts[3] || "";
    const draft = store.chat(id)?.draft ? store.chat(id) : null;
    if (method === "GET" && sub === "") {
      if (store.chat(id)?.deleted) throw httpError(410, "This chat was permanently deleted.");
      if (draft) {
        return sendJson(res, 200, { id, draft: true, workspace: draft.workspace, autoFolder: !!draft.autoFolder, title: draft.title || "New chat", hidden: !!draft.hidden, items: [], activeTurnId: null, approvals: [], model: draft.modelId || config.model || null, reasoningEffort: draft.reasoningEffort || config.reasoningEffort || null, approvalMode: draft.approvalMode || config.approvalMode, agentMode: agentModeOf(draft), trust: draft.workspace ? trustOf(draft.workspace) : null, tokenUsage: null, contextUsage: null });
      }
      // Opening only reads the view (no resume): the session is loaded when
      // the user starts typing (POST .../warm) or sends.
      const workspace = await workspaceFor(id);
      const before = url.searchParams.get("before") || undefined;
      const h = await muse.readHistory(id, workspace, { turns: Math.max(1, Number(config.historyTurns) || 6), before });
      if (before) return sendJson(res, 200, { id, items: h.items, earlierCursor: h.earlierCursor });
      const meta = store.chat(id);
      // Rebuild the persisted total after a restart from the host's own log.
      if (meta && h.tokenUsage) store.upsertChat(id, { tokenUsage: h.tokenUsage });
      const info = muse.sessionInfo(id);
      const live = muse.liveState(id);
      return sendJson(res, 200, {
        id,
        workspace,
        autoFolder: !!meta?.autoFolder,
        title: chatTitle(meta, info),
        hidden: !!meta?.hidden,
        items: h.items,
        earlierCursor: h.earlierCursor,
        activeTurnId: live.activeTurnId,
        approvals: live.approvals,
        turnStats: live.turnStats,
        model: meta?.modelId || info?.modelId || null,
        reasoningEffort: h.reasoningEffort || meta?.reasoningEffort || null,
        approvalMode: meta?.approvalMode || config.approvalMode,
        agentMode: agentModeOf(meta),
        agentsActive: live.agentsActive,
        trust: trustOf(workspace),
        tokenUsage: h.tokenUsage || null,
        contextUsage: h.contextUsage || null,
      });
    }
    // Hover in the sidebar: open the session's view in the host. Typing: load
    // the session so the first send does not wait for the resume.
    if (method === "POST" && sub === "warm") {
      if (draft) return sendJson(res, 200, { ok: true });
      const body = await readJsonBody(req);
      const workspace = await workspaceFor(id);
      if (body.load) void muse.ensureLoaded(id, workspace).catch(() => undefined);
      else void muse.warm(id, workspace);
      return sendJson(res, 202, { ok: true });
    }
    if (method === "PATCH" && sub === "") {
      const body = await readJsonBody(req);
      const patch = {};
      if (typeof body.title === "string") patch.title = body.title.trim().slice(0, 120) || undefined;
      if (typeof body.hidden === "boolean") patch.hidden = body.hidden;
      if (typeof body.modelId === "string" && body.modelId.trim()) patch.modelId = body.modelId.trim().slice(0, 200);
      await assertModelOffered(patch.modelId);
      if ("reasoningEffort" in body) {
        if (body.reasoningEffort === null || body.reasoningEffort === "") patch.reasoningEffort = undefined;
        else if (REASONING_EFFORTS.includes(body.reasoningEffort)) patch.reasoningEffort = body.reasoningEffort;
        else throw httpError(400, "Unknown reasoning effort tier.");
      }
      if ("approvalMode" in body) {
        if (APPROVAL_MODES.includes(body.approvalMode)) patch.approvalMode = body.approvalMode;
        else throw httpError(400, "Unknown approval mode.");
      }
      if ("agentMode" in body) {
        if (AGENT_MODES.includes(body.agentMode)) patch.agentMode = body.agentMode;
        else throw httpError(400, "Unknown agents mode.");
      }
      if ("workspace" in body) {
        // Drafts may point at an existing folder; so may a live session the
        // dashboard knows no folder for (e.g. started in the terminal with no
        // recorded project folder). A chat that already has a folder keeps it.
        // Drafts (pre-first-message) may always (re)pick; a live session may
        // only gain a folder while none is recorded for it.
        const recorded = draft ? null : await workspaceFor(id).catch(() => null);
        if (recorded) throw httpError(409, "The folder can only be changed before the first message.");
        if (body.workspace) {
          patch.workspace = await canonicalDir(body.workspace);
          patch.autoFolder = false;
          store.addRecent(patch.workspace);
          if (body.seedProjectFiles === true) await initProjectFiles(patch.workspace, draft?.title || path.basename(patch.workspace), id);
          // The draft's own Projects folder is no longer used: drop it while it still holds only the starter files.
          if (draft?.autoFolder && draft.workspace && path.resolve(draft.workspace) !== path.resolve(patch.workspace)) await removeUnusedChatFolder(draft.workspace);
        } else if (draft && !draft.autoFolder) {
          patch.workspace = null;
        }
        if (draft) patch.snapshot = undefined; // a snapshot belongs to the folder it was taken of
      }
      if (!store.chat(id) && patch.workspace === undefined) patch.workspace = await workspaceFor(id).catch(() => undefined);
      const meta = store.upsertChat(id, patch);
      emit("chat-updated", { id, title: meta.title, hidden: meta.hidden });
      const snap = draft && patch.workspace && body.snapshot === true ? await snapshotForChat(id, patch.workspace) : {};
      let applied = null;
      if (!draft && (patch.modelId || patch.reasoningEffort || patch.approvalMode)) {
        const ws = await workspaceFor(id);
        applied = await muse.applyChatPrefs(id, ws, { modelId: patch.modelId, reasoningEffort: patch.reasoningEffort, approvalMode: patch.approvalMode });
        const failed = Object.keys(applied).filter((k) => k.endsWith("Error"));
        if (failed.length) throw httpError(502, `Saved, but Muse refused: ${failed.map((k) => applied[k]).join("; ")}`);
      }
      return sendJson(res, 200, { ...meta, ...snap, applied });
    }
    if (method === "POST" && sub === "trust") {
      // "Trust this folder": adds the chat's folder to Muse's trust.json. New
      // sessions pick it up at once; a session that already exists keeps the
      // trust it started with (measured on Muse 1.4.13).
      const workspace = draft ? draft.workspace : await workspaceFor(id);
      if (!workspace) throw httpError(409, "This chat has no folder yet.");
      try {
        trustFolder(workspace);
      } catch (e) {
        throw httpError(500, e.message);
      }
      return sendJson(res, 200, { trust: trustOf(workspace), appliesToThisChat: !!draft });
    }
    if (method === "POST" && sub === "undo-snapshot") {
      // Put the folder back the way it was at the chat's snapshot (see lib/snapshot.js).
      const meta = store.chat(id);
      if (!meta?.snapshot) throw httpError(409, "This chat has no snapshot.");
      if (muse.isTurnActive(id) || muse.activeAgents(id).length || muse.sessionInfo(id)?.status === "running") throw httpError(409, "This chat is still working. Press Stop and wait for it to finish, then undo.");
      try {
        return sendJson(res, 200, await restoreSnapshot(meta.snapshot));
      } catch (e) {
        throw httpError(500, `Undo failed: ${e.message}`);
      }
    }
    if (method === "GET" && sub === "delete-check") {
      // What Delete would do with this chat's folder, for the Yes/No dialog: refused (block), or how big it
      // is and whether the Recycle Bin can keep it (lib/recycle.js).
      const workspace = store.chat(id)?.workspace || (await workspaceFor(id).catch(() => null));
      if (!workspace || !fs.existsSync(workspace)) return sendJson(res, 200, { folder: null });
      const folder = path.resolve(workspace);
      const block = await folderDeleteBlock(folder, id);
      if (block) return sendJson(res, 200, { folder, block });
      return sendJson(res, 200, { folder, ...(await recycleCheck(folder, { test: config.testRecycleBin })) });
    }
    if (method === "DELETE" && sub === "") {
      // Takes the chat off the dashboard for good (unlike Hide).
      //   ?folder=keep (default, "Remove"): the folder and everything in it stay on disk.
      //   ?folder=recycle ("Delete"): the chat's Projects folder goes to the Recycle Bin. A folder
      //     the bin cannot hold is deleted for good only with &permanent=1 (the user agreed).
      //     Folders outside Projects are never deleted (folderDeleteBlock).
      // Muse has no session-delete API, so its own session log stays in Muse's
      // store; a tombstone record keeps the chat from reappearing in the sidebar.
      const meta = store.chat(id);
      if (meta?.deleted) return sendJson(res, 200, { id, deleted: true, alreadyDeleted: true });
      const folderMode = url.searchParams.get("folder") || "keep";
      if (folderMode !== "keep" && folderMode !== "recycle") throw httpError(400, "Unknown folder option.");
      const deleteFolder = folderMode === "recycle";
      if (muse.isTurnActive(id) || muse.activeAgents(id).length || muse.sessionInfo(id)?.status === "running") throw httpError(409, `This chat is still working. Press Stop and wait for it to finish, then ${deleteFolder ? "delete" : "remove"} it.`);
      const workspace = meta?.workspace || (await workspaceFor(id).catch(() => null));
      let folder = null;
      if (workspace && deleteFolder && fs.existsSync(workspace)) {
        const resolved = path.resolve(workspace);
        const block = await folderDeleteBlock(resolved, id);
        if (block) throw httpError(409, `Nothing was deleted: the folder ${resolved} cannot be deleted because ${block}. Use Remove to take the chat off the dashboard and keep the folder.`);
        const test = config.testRecycleBin;
        const check = await recycleCheck(resolved, { test });
        const cannotKeep = check.bin === "tooLarge" || check.bin === "noBin";
        if (cannotKeep && url.searchParams.get("permanent") !== "1") throw httpError(409, `Nothing was deleted: the ${check.binName} cannot keep ${resolved}, so deleting it would be permanent. Confirm that in the Delete dialog, or delete the folder yourself.`);
        await muse.unload(id).catch(() => undefined);
        try {
          if (cannotKeep) {
            await fsp.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
            folder = { deletedFolder: resolved, inBin: false, chosenPermanent: true };
          } else {
            folder = { deletedFolder: resolved, ...(await moveToRecycleBin(resolved, { test })) };
          }
        } catch (e) {
          throw httpError(500, `Could not delete ${resolved}: ${e.message}. Close any program using it and press Delete again.`);
        }
        folder.binName = check.binName;
      } else if (workspace) {
        folder = { keptFolder: path.resolve(workspace) };
      }
      await muse.unload(id).catch(() => undefined);
      muse.forget(id);
      store.markDeleted(id);
      emit("chat-deleted", { id });
      return sendJson(res, 200, { id, deleted: true, ...folder, museHistoryKept: true });
    }
    if (method === "POST" && sub === "messages") {
      const body = await readJsonBody(req);
      await assertModelOffered(store.chat(id)?.modelId || (draft ? config.model : muse.sessionInfo(id)?.modelId));
      const text = typeof body.text === "string" ? body.text : "";
      const images = Array.isArray(body.images) ? body.images : [];
      const rawPaths = (Array.isArray(body.paths) ? body.paths : []).slice(0, 100).map(String);
      // Validate attachments before creating anything.
      const attached = [];
      const curWs = store.chat(id)?.workspace;
      const within = (root, p) => { if (!root) return false; const r = path.relative(root, p); return !!r && !r.startsWith("..") && !path.isAbsolute(r); };
      for (const p of rawPaths) {
        if (!path.isAbsolute(p)) throw httpError(400, `Not an absolute path: ${p}`);
        if (!within(PROJECTS_DIR, p) && !within(curWs, p) && !within(await workspaceFor(id).catch(() => null), p)) throw httpError(400, `Attachments must be uploaded into the chat first: ${p}`);
        try { attached.push(await describePath(p)); } catch { throw httpError(400, `Attachment no longer exists: ${p}`); }
      }
      for (const img of images) {
        if (!/^image\/(png|jpeg|gif|webp)$/.test(img?.mediaType || "")) throw httpError(400, "Images must be PNG, JPEG, GIF or WebP.");
        if (typeof img.base64Data !== "string" || img.base64Data.length === 0) throw httpError(400, "Empty image.");
      }
      if (!text.trim() && !attached.length && !images.length) throw httpError(400, "Type a message or attach something.");
      if (draft && text.trim()) {
        // Everything checks out: give an early (placeholder-named) chat folder its real name.
        const moved = await nameChatFolder(id, text);
        if (moved) for (const a of attached) if (a.path === moved.from || a.path.startsWith(moved.from + path.sep)) a.path = moved.to + a.path.slice(moved.from.length);
      }

      let chatId = id;
      let workspace;
      if (draft) {
        workspace = store.chat(id)?.workspace || (await ensureChatFolder(id, text || attached[0]?.name));
        const started = await muse.startChat(workspace);
        const cur = store.chat(id) || {};
        store.rekey(id, started.sessionId, { draft: false, workspace, autoFolder: !!cur.autoFolder, title: cur.title || (text.trim() ? text.trim().slice(0, 60) : attached[0]?.name) });
        chatId = started.sessionId;
        emit("chat-rekeyed", { from: id, to: chatId });
        const prefs = store.chat(chatId) || {};
        const effective = {
          modelId: prefs.modelId || config.model || undefined,
          reasoningEffort: prefs.reasoningEffort || config.reasoningEffort || undefined,
          approvalMode: prefs.approvalMode || config.approvalMode || undefined,
        };
        if (effective.modelId || effective.reasoningEffort || effective.approvalMode) {
          const applied = await muse.applyChatPrefs(chatId, workspace, effective);
          for (const k of Object.keys(applied)) if (k.endsWith("Error")) emit("app-error", { sessionId: chatId, message: `Chat setting not applied: ${applied[k]}` });
        }
      } else {
        workspace = await workspaceFor(id);
        // Muse resumes a session in the folder it recorded, never a new one: after the dashboard moved, say so plainly.
        if (!muse.sessionInfo(id)) await muse.listSessions().catch(() => undefined);
        const recorded = muse.sessionInfo(id)?.workspaceRoot;
        if (recorded && !samePath(recorded, workspace) && !fs.existsSync(recorded)) {
          throw httpError(409, `This chat's Muse session still works in ${recorded}, which no longer exists (the folder was moved). Its history stays readable here; start a new chat in ${workspace} to keep working on it.`);
        }
        // A session from outside this dashboard (another copy, the terminal) that is continued here becomes this dashboard's chat.
        if (!store.chat(id)) store.upsertChat(id, { workspace });
      }

      const lines = [];
      const input = [];
      for (const a of attached) {
        const rel = path.relative(workspace, a.path);
        const inside = rel && !rel.startsWith("..") && !path.isAbsolute(rel);
        lines.push(inside ? `- @${rel.split(path.sep).join("/")}${a.isDir ? "/ (folder)" : ""}` : `- ${a.path}${a.isDir ? " (folder)" : ""}`);
        const mt = IMAGE_EXT[path.extname(a.path).toLowerCase()];
        if (mt && !a.isDir && a.size && a.size <= MAX_IMAGE_BYTES) {
          input.push({ type: "image", mediaType: mt, base64Data: (await fsp.readFile(a.path)).toString("base64") });
        }
      }
      let prompt = text;
      if (lines.length) prompt += `${prompt ? "\n\n" : ""}Attached files (saved in this workspace):\n${lines.join("\n")}`;
      if (prompt.trim()) input.unshift({ type: "text", text: prompt });
      for (const img of images) input.push({ type: "image", mediaType: img.mediaType, base64Data: img.base64Data });
      if (!input.some((p) => p.type === "text")) input.unshift({ type: "text", text: "(see attached image)" });
      // The chat's Agents mode rides along as a short instruction the model sees but the transcript does not show.
      const directive = agentDirective(agentModeOf(store.chat(chatId)), { isolation: trustOf(workspace).isolation, helperModel: config.agentHelperModel, helperEffort: config.agentHelperEffort, maxChildren: config.agentMaxChildren });
      if (directive) input.find((p) => p.type === "text").text += `\n\n${directive}`;
      const names = [...attached.map((a) => a.name), ...images.map((i, n) => i.name || `image ${n + 1}`)];
      const displayText = names.length ? `${text}${text ? "\n\n" : ""}📎 ${names.join(", ")}` : text || undefined;
      const out = await muse.send(chatId, workspace, {
        input,
        displayText,
      });
      const meta = store.chat(chatId);
      if (!meta || (!meta.title && text)) store.upsertChat(chatId, { workspace, title: meta?.title || (text ? text.trim().slice(0, 60) : undefined) });
      return sendJson(res, 200, { ...out, chatId });
    }
    if (method === "POST" && sub === "upload") {
      // Saved inside the chat's workspace so Muse reads it as @relative/path:
      //   auto chat folder  -> <chat folder>/attachments/
      //   project folder    -> <project>/.muse-uploads/<chat-id>/
      // Same name + same content in the same chat is stored once; a clash gets -2, -3...
      const meta = store.chat(id);
      let workspace, dir;
      if (meta?.autoFolder || (draft && !draft.workspace)) {
        workspace = await ensureChatFolder(id, null);
        dir = path.join(workspace, "attachments");
      } else {
        workspace = meta?.workspace || (await workspaceFor(id));
        dir = path.join(workspace, ".muse-uploads", id);
      }
      await fsp.mkdir(dir, { recursive: true });
      const name = safeFileName(url.searchParams.get("name"));
      const tmp = path.join(dir, `.upload-${crypto.randomUUID()}.part`);
      const limit = (Number(config.maxUploadMB) || 200) * 1024 * 1024;
      const hash = crypto.createHash("sha256");
      let size = 0;
      const out = fs.createWriteStream(tmp, { flags: "wx" });
      try {
        for await (const c of req) {
          size += c.length;
          if (size > limit) throw httpError(413, `File is larger than ${config.maxUploadMB} MB.`);
          hash.update(c);
          if (!out.write(c)) await new Promise((r) => out.once("drain", r));
        }
        await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
      } catch (e) {
        out.destroy();
        await fsp.rm(tmp, { force: true });
        throw e;
      }
      const digest = hash.digest("hex");
      let target = await findDuplicate(dir, name, size, digest);
      const reused = !!target;
      if (reused) await fsp.rm(tmp, { force: true });
      else {
        target = await uniquePath(dir, name);
        await fsp.rename(tmp, target);
      }
      const rel = path.relative(workspace, target).split(path.sep).join("/");
      return sendJson(res, 200, { path: target, relPath: rel, name: path.basename(target), size, reused });
    }
    // Read-only transcript of one of this chat's subagents.
    if (method === "GET" && sub === "children" && parts[4]) {
      const child = checkId(parts[4]);
      return sendJson(res, 200, { items: await muse.readChild(id, child, await workspaceFor(id)) });
    }
    if (method === "POST" && sub === "interrupt") {
      return sendJson(res, 200, await muse.interrupt(id));
    }
    if (method === "POST" && sub === "compact") {
      if (draft) throw httpError(409, "Send a message first, then compact.");
      const workspace = await workspaceFor(id);
      const r = await muse.compact(id, workspace);
      emit("chat-compacted", { id, status: r?.status || "accepted" });
      return sendJson(res, 200, { id, ...(r || {}) });
    }
  }
  if (method === "POST" && parts[1] === "approvals" && parts[2]) {
    const body = await readJsonBody(req);
    return sendJson(res, 200, muse.decide(decodeURIComponent(parts[2]), String(body.choiceId || ""), body.feedback));
  }
  if (route === "GET /fs/list") return sendJson(res, 200, await listFolders(url.searchParams.get("path") || ""));
  if (route === "GET /fs/info") return sendJson(res, 200, await folderInfo(url.searchParams.get("path") || ""));
  if (route === "POST /fs/mentioned") {
    const body = await readJsonBody(req);
    return sendJson(res, 200, { folders: await foldersInText(typeof body.text === "string" ? body.text : "") });
  }
  if (route === "POST /github/mentioned") {
    const body = await readJsonBody(req);
    return sendJson(res, 200, await githubInText(typeof body.text === "string" ? body.text : ""));
  }
  if (route === "POST /github/clone") {
    const body = await readJsonBody(req);
    return sendJson(res, 200, await cloneForChat(String(body.url || ""), typeof body.chatId === "string" && ID_RE.test(body.chatId) ? body.chatId : null));
  }
  if (route === "POST /fs/pick") {
    // The Windows folder dialog; resolves when the user picks or cancels.
    const body = await readJsonBody(req);
    const start = typeof body.start === "string" && path.isAbsolute(body.start) ? body.start : "";
    const picked = await pickFolderNative({ title: "Open a folder for this chat", start });
    return sendJson(res, 200, { path: picked ? await canonicalDir(picked) : null });
  }
  if (route === "POST /recents/remove") {
    const body = await readJsonBody(req);
    store.removeRecent(String(body.path || ""));
    return sendJson(res, 200, { recents: store.data.recents });
  }
  throw httpError(404, "Not found.");
}

// ---------- server start ----------
let PORT = 0;
const server = http.createServer(async (req, res) => {
  try {
    // DNS-rebinding guard: only our own loopback host names are accepted.
    const hostHeader = String(req.headers.host || "").toLowerCase();
    if (hostHeader !== `127.0.0.1:${PORT}` && hostHeader !== `localhost:${PORT}`) return send(res, 421, "Wrong host.");
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (url.pathname === "/api/health") {
      return sendJson(res, 200, { app: APP_NAME, instance, version: VERSION, stopping, tabs: openTabs(), busy: muse.busy() });
    }
    // Token exchange: the launcher opens /?t=<token>; we set an HttpOnly,
    // SameSite=Strict cookie and redirect to a clean URL.
    if (url.pathname === "/" && url.searchParams.has("t")) {
      if (!tokenOk(url.searchParams.get("t"))) return send(res, 403, "Invalid or expired link. Start the dashboard again with start-dashboard.bat (or start-dashboard.sh).", { "Content-Type": "text/plain" });
      return send(res, 302, "", { Location: "/", "Set-Cookie": `md_token=${token}; HttpOnly; SameSite=Strict; Path=/` });
    }
    if (!tokenOk(cookies(req).md_token)) {
      return send(
        res,
        403,
        "<!doctype html><meta charset=utf-8><title>Muse Dashboard</title><body style='font-family:sans-serif;background:#212121;color:#ddd;padding:40px'><h2>Muse Dashboard</h2><p>This page must be opened through <b>start-dashboard.bat</b> (or <code>start-dashboard.sh</code> / <code>npm start</code>), which opens it with a fresh access link.</p>",
        { "Content-Type": "text/html; charset=utf-8" },
      );
    }
    if (url.pathname.startsWith("/api/")) {
      // Cross-site request guard (in addition to the SameSite cookie).
      const site = req.headers["sec-fetch-site"];
      if (site && site !== "same-origin" && site !== "none") return sendJson(res, 403, { error: "Cross-site request blocked." });
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return sendJson(res, 403, { error: "Cross-origin request blocked." });
      if (req.method !== "GET" && req.headers["x-muse-dashboard"] !== "1" && url.pathname !== "/api/bye") return sendJson(res, 403, { error: "Missing dashboard header." });
      return await handleApi(req, res, url);
    }
    const file = STATIC[url.pathname];
    if (req.method === "GET" && file) {
      const body = await fsp.readFile(file);
      return send(res, 200, body, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    }
    return send(res, 404, "Not found.");
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    if (!res.headersSent) sendJson(res, status, { error: e.message || String(e) });
    else res.end();
  }
});
server.requestTimeout = 0; // uploads and SSE can be long

function listen(port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => {
      server.off("listening", onOk);
      reject(e);
    };
    const onOk = () => {
      server.off("error", onErr);
      resolve(server.address().port);
    };
    server.once("error", onErr);
    server.once("listening", onOk);
    server.listen({ port, host: "127.0.0.1", exclusive: true });
  });
}
try {
  // After a restart the old process may need a moment to release the port.
  for (let attempt = 0; ; attempt += 1) {
    try { PORT = await listen(Number(config.preferredPort) || 0); break; }
    catch (e) { if (!resumed || e.code !== "EADDRINUSE" || attempt >= 20) throw e; await sleep(250); }
  }
} catch (e) {
  if (e.code !== "EADDRINUSE" && e.code !== "EACCES") throw e;
  console.log(`Port ${config.preferredPort} is busy; letting the OS pick a free port instead.`);
  PORT = await listen(0);
}

const baseUrl = `http://127.0.0.1:${PORT}/`;
const launchUrl = `${baseUrl}?t=${token}`;
await writeJsonAtomic(RUNTIME_FILE, { app: APP_NAME, instance, pid: process.pid, port: PORT, url: baseUrl, launchUrl, startedAt: new Date().toISOString() });
await fsp.writeFile(URL_FILE, `${launchUrl}\n`, "utf8");
console.log(`Muse Dashboard ${VERSION} running at ${baseUrl}`);
console.log(`Open this link (it includes your private access token): ${launchUrl}`);
console.log(`Muse binary: ${muse.binInfo.bin} (${muse.binInfo.how})${museInfo.installed ? `, version ${museInfo.installed}` : ""}`);
console.log(`New chats get their own project folder in ${PROJECTS_DIR}`);
console.log("Close this window or press Ctrl+C to stop.");
// After a restart the open page reloads itself, unless the port had to change.
if (config.open || (resumed && PORT !== Number(handoff.port))) openBrowser(launchUrl);

// ---------- auto-shutdown ----------
let stopping = false;
// Event-driven, no polling: the open SSE connection of each tab is the signal.
// When the last tab disconnects, one timer starts; any tab connecting cancels it.
// When it fires mid-turn, it looks again once a minute until the turn is done.
const IDLE_MS = Math.max(0, Number(config.idleShutdownSeconds ?? 120)) * 1000;
let idleTimer = null;
function openTabs() {
  let n = 0;
  for (const r of sseClients) if (!r.leaving) n++;
  return n;
}
function tabsChanged() {
  if (!IDLE_MS || stopping) return;
  if (openTabs() > 0) {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  } else if (!idleTimer) {
    idleTimer = setTimeout(idleCheck, IDLE_MS);
  }
}
function idleCheck() {
  idleTimer = null;
  if (stopping || openTabs() > 0) return;
  if (muse.busy()) {
    idleTimer = setTimeout(idleCheck, Math.min(IDLE_MS, 60000));
    return;
  }
  console.log(`No dashboard tab has been open for ${Math.round(IDLE_MS / 1000)} s, so the dashboard is shutting down.`);
  void shutdown(0, "idle");
}
// The browser may never connect (closed before loading): the same rule covers that.
tabsChanged();

async function shutdown(code = 0, reason = "stopped") {
  if (stopping) return;
  stopping = true;
  if (idleTimer) clearTimeout(idleTimer);
  // A closed console window only gives us a few seconds on Windows: be quick then.
  const hurry = reason === "SIGHUP" || reason === "SIGBREAK" || reason === "crash";
  try {
    const cur = await readJson(RUNTIME_FILE, null);
    if (cur?.instance === instance) {
      await fsp.rm(RUNTIME_FILE, { force: true });
      await fsp.rm(URL_FILE, { force: true });
    }
  } catch { /* ignore */ }
  const note = `event: server-stopping\ndata: ${JSON.stringify({ reason })}\n\n`;
  for (const r of sseClients) { try { r.end(note); } catch { /* ignore */ } }
  server.close();
  await muse.closeAll(hurry ? 1500 : 5000).catch(() => undefined);
  // Let the startup update check finish first (a few seconds at most), then cancel it.
  await Promise.race([updatePromise, sleep(hurry ? 1000 : 3000)]);
  updateAbort.abort();
  reaper.killAll(); // anything that did not exit on its own, with its child processes
  await reaper.bye();
  console.log(reason === "restart" ? "Restarting Muse Dashboard..." : "Muse Dashboard stopped.");
  process.exit(code);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  try {
    process.on(sig, () => void shutdown(0, sig));
  } catch { /* signal not supported on this platform */ }
}
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e));
process.on("uncaughtException", (e) => {
  console.error("Unexpected error, stopping:", e);
  void shutdown(1, "crash");
});
