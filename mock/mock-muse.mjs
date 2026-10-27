#!/usr/bin/env node
// Muse Dashboard · mock/mock-muse.mjs
// Author: Adam S. Barnett
//
// A small fake `muse` for testing the dashboard without Muse installed or
// signed in. `serve` speaks newline-delimited JSON-RPC 2.0 on stdio like the
// real host, with the subset of the Muse Session Protocol the dashboard uses;
// `usage`, `login` and `skills install` stand in for the matching commands.
// Tests run it as `node mock/mock-muse.mjs` (config museBin + museArgs);
// mock-muse.sh is the same for POSIX shells.
import readline from "node:readline";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Sign-in: with MUSE_AUTH_PATH set, the mock is signed in only while that
// file exists (`login` creates it); without it, it is always signed in.
// META_API_KEY beats the sign-in, as in Muse; a key starting "refused-" is
// one Meta does not accept (replies fail with authRequired).
const AUTH_FILE = process.env.MUSE_AUTH_PATH;
const API_KEY = process.env.META_API_KEY || null;
const signedIn = () => (API_KEY ? !API_KEY.startsWith("refused-") : !AUTH_FILE || fs.existsSync(AUTH_FILE));
const [command, ...rest] = process.argv.slice(2);
if (command === "usage") {
  if (API_KEY) {
    // Muse does not check the key here.
    console.log(JSON.stringify({ schemaVersion: 1, allowance: null, reason: "api_key", hint: null }));
    process.exit(0);
  }
  if (!signedIn()) {
    console.error("muse usage: not logged in: run `muse login` first");
    process.exit(1);
  }
  console.log(JSON.stringify({ schemaVersion: 1, allowance: { tier: "Mock Tier", window: { usedPercent: 1, resetsAtMs: Date.now() + 3600000 }, weekly: { usedPercent: 2, resetsAtMs: Date.now() + 86400000 }, asOfMs: Date.now() }, reason: null, hint: null }));
  process.exit(0);
}
if (command === "login") {
  if (AUTH_FILE) fs.writeFileSync(AUTH_FILE, JSON.stringify({ mock: true }));
  console.log("Signed in (mock).");
  process.exit(0);
}
if (command === "skills" && rest[0] === "install") {
  // MOCK_MUSE_SKILLS_LOG records each install so tests can check what was installed.
  const dir = rest[1];
  if (!dir || !fs.existsSync(path.join(dir, "SKILL.md"))) {
    console.error(`muse skills install: no SKILL.md in ${dir}`);
    process.exit(1);
  }
  if (process.env.MOCK_MUSE_SKILLS_LOG) fs.appendFileSync(process.env.MOCK_MUSE_SKILLS_LOG, `${JSON.stringify(rest)}\n`);
  console.log(`Installed skill ${path.basename(dir)} (mock).`);
  process.exit(0);
}
if (command !== "serve") {
  console.log(`mock-muse ${process.env.MOCK_MUSE_VERSION || "0.0.0"}`);
  process.exit(0);
}
const STATE_FILE = process.env.MOCK_MUSE_STATE || path.join(process.cwd(), ".mock-muse-state.json");
try { fs.appendFileSync(`${STATE_FILE}.hosts`, `${JSON.stringify(process.argv.slice(2))}\n`); } catch { /* ignore */ }
// Which API key this host got (last 4 characters only), for test/api-key.mjs.
try { fs.appendFileSync(`${STATE_FILE}.env`, `${JSON.stringify({ metaApiKeyLast4: API_KEY ? API_KEY.slice(-4) : null })}\n`); } catch { /* ignore */ }
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { sessions = {}; }
const save = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(sessions)); } catch { /* ignore */ } };

const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
let seq = 0;
const cursor = () => `c${String(++seq + Date.now() * 1000).padStart(20, "0")}`;
const range = () => ({ first: { id: crypto.randomUUID(), sequence: seq }, last: { id: crypto.randomUUID(), sequence: seq }, stream: { id: "s", kind: "session" } });
const subscribed = new Set();
const approvalWaits = new Map();
const interrupted = new Set();

function emit(sessionId, method, params) {
  const p = { sessionId, viewCursor: cursor(), sourceRange: range(), ...params };
  const s = sessions[sessionId];
  if (s) { s.events.push({ method, params: p }); s.updatedAt = new Date().toISOString(); save(); }
  if (subscribed.has(sessionId)) out({ jsonrpc: "2.0", method, params: p });
}
function wireSession(s, status = "idle") {
  return {
    sessionId: s.sessionId, activeTurnId: s.activeTurnId || null, createdAt: s.createdAt, updatedAt: s.updatedAt, lastActivityAt: s.updatedAt,
    forkedFrom: null, kind: s.kind || "root", modelId: s.modelId || "mock-model", providerId: "echo", path: "", status, turnCount: s.turnCount || 0,
    workspaceRoot: s.workspaceRoot, firstUserPrompt: s.firstUserPrompt, title: s.firstUserPrompt ? s.firstUserPrompt.slice(0, 40) : undefined,
    approvalMode: { mode: s.approvalMode || "onRequest", source: "startup", lastCommandId: null },
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- subagents and workflows ("use agents finish|linger|burn" in a prompt) ----
// Like the real host they outlive the turn that started them: a native
// subagent plus a two-child workflow whose children are subagent items too.
// finish: done after a moment; linger: run until subagent/stop or
// workflow/cancel; burn: keep adding usage until stopped.
const agentRuns = new Map(); // sessionId -> Map(itemId -> item)
const usageOf = (input, out) => ({ inputTokens: input, outputTokens: out, cachedTokens: Math.round(input * 0.6), cacheReadTokens: Math.round(input * 0.6), cacheWriteTokens: 0, reasoningTokens: 0 });
function putAgent(sessionId, item, method = "item/updated") {
  const m = agentRuns.get(sessionId) || new Map();
  agentRuns.set(sessionId, m);
  const prev = m.get(item.itemId);
  const next = { ...prev, ...item, revision: (prev?.revision || 0) + 1 };
  m.set(item.itemId, next);
  emit(sessionId, method, { item: next });
  return next;
}
function startAgents(sessionId, turnId, how) {
  const childSession = (objective) => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    sessions[id] = { sessionId: id, kind: "subagent", workspaceRoot: sessions[sessionId].workspaceRoot, createdAt: now, updatedAt: now, events: [], turnCount: 1 };
    emit(id, "item/completed", { item: { itemId: crypto.randomUUID(), kind: "userMessage", revision: 1, status: "completed", text: objective } });
    emit(id, "item/completed", { item: { itemId: crypto.randomUUID(), kind: "toolCall", revision: 1, status: "completed", tool: "read_file", args: "{}" } });
    emit(id, "item/completed", { item: { itemId: crypto.randomUUID(), kind: "agentMessage", revision: 1, status: "completed", text: `Done: ${objective}` } });
    return id;
  };
  const wf = `workflow-run-${crypto.randomUUID()}`;
  const kids = [];
  kids.push(putAgent(sessionId, { itemId: crypto.randomUUID(), kind: "subagent", status: "inProgress", controlStatus: "running", subagentId: "subagent-1", role: "helper", objective: "Do part A", childSessionId: childSession("Do part A"), turnId }, "item/started"));
  const wfItem = putAgent(sessionId, { itemId: crypto.randomUUID(), kind: "workflow", status: "inProgress", stopAvailable: true, workflowRunId: wf, children: [], turnId }, "item/started");
  for (const n of [1, 2]) kids.push(putAgent(sessionId, { itemId: crypto.randomUUID(), kind: "subagent", status: "inProgress", controlStatus: "running", subagentId: `wf-child-${n}`, workflowRunId: wf, objective: `Workflow part ${n}`, childSessionId: childSession(`Workflow part ${n}`), turnId }, "item/started"));
  const wfChildren = () => kids.filter((k) => k.workflowRunId).map((k, i) => ({ childId: k.subagentId, attempt: 1, status: agentRuns.get(sessionId).get(k.itemId).controlStatus === "running" ? "started" : "completed", usage: agentRuns.get(sessionId).get(k.itemId).usage, label: `part ${i + 1}` }));
  let round = 0;
  const tick = () => {
    round += 1;
    const live = kids.filter((k) => agentRuns.get(sessionId).get(k.itemId).controlStatus === "running");
    if (!live.length) return;
    for (const k of live) putAgent(sessionId, { itemId: k.itemId, usage: usageOf(30000 * round, 500 * round) });
    putAgent(sessionId, { itemId: wfItem.itemId, children: wfChildren() });
    if (how === "finish") {
      for (const k of live) putAgent(sessionId, { itemId: k.itemId, controlStatus: "resultReady", durationMs: 200, result: { summary: "part done", text: "part done", artifactRefs: [], evidenceRefs: [] } });
      putAgent(sessionId, { itemId: wfItem.itemId, status: "completed", stopAvailable: false, children: wfChildren(), durationMs: 200, finalSummary: "Both parts done." }, "item/completed");
    } else if (how === "burn") setTimeout(tick, 100);
  };
  setTimeout(tick, 100);
}
function stopAgent(sessionId, match, record) {
  const m = agentRuns.get(sessionId);
  if (!m) return false;
  let hit = false;
  for (const it of m.values()) {
    if (!match(it)) continue;
    hit = true;
    if (it.kind === "workflow") putAgent(sessionId, { itemId: it.itemId, status: "cancelled", stopAvailable: false }, "item/completed");
    else if (it.controlStatus === "running") putAgent(sessionId, { itemId: it.itemId, controlStatus: "resultReady", result: { summary: "stopped", artifactRefs: [], evidenceRefs: [] } });
  }
  const s = sessions[sessionId];
  if (s && hit) { (s.agentStops ||= []).push(record); save(); }
  return hit;
}

async function runTurn(sessionId, turnId, input) {
  const s = sessions[sessionId];
  s.activeTurnId = turnId;
  const text = input.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  const images = input.filter((p) => p.type === "image");
  emit(sessionId, "turn/started", { turnId, commandId: turnId });
  const uid = crypto.randomUUID();
  emit(sessionId, "item/completed", { item: { itemId: uid, kind: "userMessage", revision: 1, status: "completed", text, displayText: sessions[sessionId]?.lastTurn?.displayText, turnId, attachments: images.map((i) => ({ type: "image", mediaType: i.mediaType })) } });
  if (!signedIn()) {
    // Like the real host without a Meta sign-in: the turn fails at once.
    s.activeTurnId = null;
    const message = "not logged in: run /login to add an API key";
    emit(sessionId, "turn/completed", { turnId, terminal: "failed", reason: message, durationMs: 5, error: { kind: "authRequired", message, retryable: false } });
    return;
  }
  if (/approve/i.test(text) && sessions[sessionId]?.approvalMode === "allowAll") {
    // Like the real host: allowAll runs the tool without sending an approval request.
    const tid = crypto.randomUUID();
    emit(sessionId, "item/started", { item: { itemId: tid, kind: "toolCall", revision: 1, status: "inProgress", tool: "shell", args: JSON.stringify({ command: "echo hello" }), turnId } });
    emit(sessionId, "item/completed", { item: { itemId: tid, kind: "toolCall", revision: 2, status: "completed", tool: "shell", args: JSON.stringify({ command: "echo hello" }), visibleOutput: "hello\n", turnId } });
  } else if (/approve/i.test(text)) {
    const tid = crypto.randomUUID();
    emit(sessionId, "item/started", { item: { itemId: tid, kind: "toolCall", revision: 1, status: "inProgress", tool: "shell", args: JSON.stringify({ command: "echo hello" }), turnId } });
    const approvalId = crypto.randomUUID();
    const req = {
      approvalId, itemId: tid, turnId, taskId: "t1", toolCallId: "tc1", toolName: "shell", rawArgs: "{\"command\":\"echo hello\"}",
      judgeEscalated: false, protectedWrite: false, currentRequirementId: { approvalId, sourceIndex: 0 },
      subject: { kind: "shell", command: "echo hello" },
      availableChoices: [
        { choiceId: "allow-once", decision: "approved", label: "Allow once", scope: "once" },
        { choiceId: "deny", decision: "denied", label: "Deny", scope: "once", acceptsFeedback: true },
      ],
    };
    const decided = new Promise((r) => approvalWaits.set(approvalId, r));
    emit(sessionId, "approval/requested", req);
    const choice = await decided;
    emit(sessionId, "approval/resolved", { approvalId, itemId: tid, turnId, decision: choice === "deny" ? "denied" : "approved", policyResult: choice === "deny" ? "deny" : "allow", resolvedBy: "user", stageEvidence: [] });
    emit(sessionId, "item/completed", { item: { itemId: tid, kind: "toolCall", revision: 2, status: choice === "deny" ? "rejected" : "completed", tool: "shell", args: JSON.stringify({ command: "echo hello" }), visibleOutput: choice === "deny" ? "" : "hello\n", turnId } });
  }
  const agentsHow = (text.match(/use agents (finish|linger|burn)/i) || [])[1];
  if (agentsHow) startAgents(sessionId, turnId, agentsHow.toLowerCase());
  const aid = crypto.randomUUID();
  emit(sessionId, "item/started", { item: { itemId: aid, kind: "agentMessage", revision: 1, status: "inProgress", text: "", turnId } });
  const reply = `**Mock Muse** received: _${text.replace(/[_*]/g, "") || "(no text)"}_${images.length ? `\n\nPlus ${images.length} image(s).` : ""}\n\n\`\`\`js\nconsole.log("hello from the mock");\n\`\`\`\n`;
  let acc = "";
  let cancelled = false;
  // "many steps" in the prompt: one model step (session/tokenUsage) per chunk, like a long agent loop.
  const manySteps = /many steps/i.test(text);
  for (const chunk of reply.match(/.{1,12}/gs)) {
    if (interrupted.has(turnId)) { cancelled = true; break; }
    if (manySteps) emit(sessionId, "session/tokenUsage", { turnId, modelId: s.modelId || "mock-model", usage: { inputTokens: 100, outputTokens: 5, cachedTokens: 80, cacheReadTokens: 80, reasoningTokens: 0 }, cumulative: { ...(s.usageTotals || { promptTokens: 0, totalTokens: 0, outputTokens: 0 }) } });
    acc += chunk;
    emit(sessionId, "item/delta", { itemId: aid, delta: chunk, field: "text" });
    await sleep(Number(process.env.MOCK_MUSE_DELAY || 30));
  }
  emit(sessionId, "item/completed", { item: { itemId: aid, kind: "agentMessage", revision: 2, status: cancelled ? "cancelled" : "completed", text: acc, turnId } });
  s.activeTurnId = null;
  s.turnCount = (s.turnCount || 0) + 1;
  s.usageTotals = s.usageTotals || { promptTokens: 0, totalTokens: 0, outputTokens: 0 };
  s.usageTotals.promptTokens += 10; s.usageTotals.outputTokens += 5; s.usageTotals.totalTokens += 15;
  emit(sessionId, "session/tokenUsage", { turnId, modelId: s.modelId || "mock-model", promptTokens: 10, totalTokens: 15, usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0 }, cumulative: { ...s.usageTotals } });
  out({ jsonrpc: "2.0", method: "usage/changed", params: { tier: "mock-tier", observedAtMs: Date.now(), window: { usedPercent: 12, resetsAtMs: Date.now() + 3600000, windowDurationMins: 300 }, weekly: { usedPercent: 3, resetsAtMs: Date.now() + 86400000 } } });
  emit(sessionId, "turn/completed", { turnId, terminal: cancelled ? "cancelled" : "completed", usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0 } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notifications such as `initialized`
  const reply = (result) => out({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message, kind) => out({ jsonrpc: "2.0", id: msg.id, error: { code, message, data: { kind } } });
  const p = msg.params || {};
  switch (msg.method) {
    case "initialize":
      return reply({
        experimentalApi: false, grantedCapabilities: [], museHome: process.cwd(), platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: process.platform === "win32" ? "windows" : "linux", schema: { version: Number(process.env.MOCK_SCHEMA_VERSION || 1), fingerprint: "sha256:" + "0".repeat(64) },
        serverInfo: { name: "mock-muse", version: process.env.MOCK_MUSE_VERSION || "0.0.0" }, someFutureField: { ignored: true }, sessionDurability: "durable", sandboxAvailability: process.env.MOCK_SANDBOX || "available", sandboxUnavailableReason: process.env.MOCK_SANDBOX === "unavailable" ? "windowsElevatedSetupNotRun" : undefined, userAgent: "mock",
      });
    case "session/start": {
      const id = p.sessionId || crypto.randomUUID();
      const now = new Date().toISOString();
      sessions[id] = { sessionId: id, workspaceRoot: p.workspaceRoot || process.cwd(), createdAt: now, updatedAt: now, events: [], turnCount: 0 };
      save();
      subscribed.add(id);
      return reply({ session: wireSession(sessions[id]), viewCursor: cursor() });
    }
    case "session/resume": {
      const s = sessions[p.sessionId];
      if (!s) return fail(-32011, "session not found", "notFound");
      subscribed.add(p.sessionId);
      return reply({ session: wireSession(s), viewCursor: cursor(), history: { mode: "none", items: null, snapshot: null, noneReason: "excluded" }, pendingRequests: [] });
    }
    case "session/list":
      return reply({ sessions: Object.values(sessions).map((s) => wireSession(s, subscribed.has(s.sessionId) ? "idle" : "notLoaded")), nextCursor: null });
    case "view/page": {
      // Durable events only, ascending; `cursor` is exclusive in both directions.
      const s = sessions[p.sessionId];
      if (!s) return fail(-32011, "session not found", "notFound");
      const evs = s.events.filter((e) => e.method !== "item/delta");
      const limit = Math.max(1, Math.min(1000, Number(p.limit) || 1000));
      const at = (c) => evs.findIndex((e) => e.params.viewCursor === c);
      if (p.direction === "backward") {
        const end = p.cursor ? Math.max(0, at(p.cursor)) : evs.length;
        const start = Math.max(0, end - limit);
        const page = evs.slice(start, end);
        return reply({ events: page, nextCursor: start > 0 && page.length ? page[0].params.viewCursor : null });
      }
      const start = p.cursor ? at(p.cursor) + 1 : 0;
      const page = evs.slice(start, start + limit);
      return reply({ events: page, nextCursor: start + limit < evs.length && page.length ? page[page.length - 1].params.viewCursor : null });
    }
    case "session/leave":
      subscribed.delete(p.sessionId);
      return reply({ commandId: p.commandId, status: "accepted" });
    case "model/list": {
      const activeId = (p.sessionId && sessions[p.sessionId]?.modelId) || "mock-model";
      const row = (modelId, label) => ({ modelId, displayLabel: label, description: null, providerId: "echo", profileId: null, isActive: modelId === activeId, isDefault: modelId === "mock-model", contextLimit: null, outputLimit: null, cost: null, releaseDate: null, defaultReasoningEffort: "high", variants: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] });
      return reply({ models: [row("mock-model", "Mock"), row("mock-big", "Mock Big")], providerId: "echo", profileId: null, source: "fakeCatalog" });
    }
    case "session/setModel": {
      const s = sessions[p.sessionId];
      if (!s) return fail(-32011, "session not found", "notFound");
      s.modelId = p.model?.modelId || s.modelId;
      emit(p.sessionId, "session/modelChanged", { model: { modelId: s.modelId, providerId: "echo", source: "user" } });
      return reply({ commandId: p.commandId, status: "accepted" });
    }
    case "session/setReasoningEffort": {
      const s = sessions[p.sessionId];
      if (!s) return fail(-32011, "session not found", "notFound");
      s.reasoningEffort = p.reasoningEffort;
      emit(p.sessionId, "session/reasoningEffortChanged", { reasoningEffort: p.reasoningEffort, source: "user" });
      return reply({ commandId: p.commandId, status: "accepted" });
    }
    case "session/setApprovalMode": {
      const s = sessions[p.sessionId];
      if (!s) return fail(-32011, "session not found", "notFound");
      s.approvalMode = p.mode;
      emit(p.sessionId, "session/approvalModeChanged", { mode: p.mode, source: "approvalReconfigure", clientName: "muse_dashboard", commandId: p.commandId });
      return reply({ commandId: p.commandId, status: "accepted", applyOutcome: "completed", effectiveMode: { mode: p.mode, source: "approvalReconfigure", lastCommandId: p.commandId } });
    }
    case "usage/read": {
      // Realistic host: nothing observed until a turn has run.
      const anyTurn = Object.values(sessions).some((s) => (s.turnCount || 0) > 0);
      if (!anyTurn) return reply({});
      return reply({ usage: { tier: "mock-tier", observedAtMs: Date.now(), window: { usedPercent: 12, resetsAtMs: Date.now() + 3600000, windowDurationMins: 300 }, weekly: { usedPercent: 3, resetsAtMs: Date.now() + 86400000 } } });
    }
    case "turn/start": {
      const s = sessions[p.sessionId];
      if (!s) return fail(-32011, "session not found", "notFound");
      s.lastTurn = {
        input: p.input.map((x) => (x.type === "image" ? { type: "image", mediaType: x.mediaType, bytes: Buffer.from(x.base64Data || "", "base64").length } : x)),
        displayText: p.displayText,
      };
      if (!s.firstUserPrompt) s.firstUserPrompt = (p.input.find((x) => x.type === "text") || {}).text;
      const turnId = p.commandId;
      reply({ commandId: p.commandId, turnId, disposition: "started", startedNewTurn: true, status: "accepted" });
      return runTurn(p.sessionId, turnId, p.input);
    }
    case "turn/interrupt":
      interrupted.add(p.turnId || sessions[p.sessionId]?.activeTurnId);
      return reply({ commandId: p.commandId, turnId: p.turnId || sessions[p.sessionId]?.activeTurnId, status: "accepted" });
    case "subagent/stop":
      if (!stopAgent(p.sessionId, (it) => it.kind === "subagent" && it.subagentId === p.subagentId, `subagent:${p.subagentId}`)) return fail(-32052, "no such subagent", "notFound");
      return reply({ commandId: p.commandId, status: "accepted" });
    case "workflow/cancel":
      if (!stopAgent(p.sessionId, (it) => it.workflowRunId === p.workflowRunId, `workflow:${p.workflowRunId}`)) return fail(-32052, "no such workflow", "notFound");
      return reply({ commandId: p.commandId, status: "accepted" });
    case "session/compact": {
      const s = sessions[p.sessionId];
      if (!s) return fail(-32011, "session not found", "notFound");
      emit(p.sessionId, "item/completed", { item: { itemId: crypto.randomUUID(), kind: "compaction", revision: 1, status: "completed" } });
      return reply({ commandId: p.commandId, status: "accepted" });
    }
    case "approval/decide": {
      const w = approvalWaits.get(p.approvalId);
      if (!w) return fail(-32052, "no such approval", "notFound");
      approvalWaits.delete(p.approvalId);
      reply({ approvalId: p.approvalId, commandId: p.commandId, status: "accepted", terminal: true });
      return w(p.choiceId);
    }
    default:
      return fail(-32601, `mock does not implement ${msg.method}`, "methodNotFound");
  }
});
// Test knobs: MOCK_STUBBORN=1 ignores stdin EOF and SIGTERM (a hung host);
// MOCK_GRANDCHILD=1 starts a child of its own (`sleep 4242`) to check tree kills.
if (process.env.MOCK_GRANDCHILD === "1") {
  const { spawn } = await import("node:child_process");
  spawn("sleep", ["4242"], { stdio: "ignore" });
}
if (process.env.MOCK_STUBBORN === "1") {
  process.on("SIGTERM", () => {});
  rl.on("close", () => setInterval(() => {}, 1 << 30));
} else {
  rl.on("close", () => process.exit(0));
}
