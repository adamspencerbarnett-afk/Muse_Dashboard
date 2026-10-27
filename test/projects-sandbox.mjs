// Muse Dashboard · test/projects-sandbox.mjs
// Author: Adam S. Barnett
//
// Focused check: named chat -> Projects/<name> (+ seeded MASTER.md and
// LOG.md), the configured default model is applied to the new session, and a
// Muse host that reports sandbox "unavailable" is restarted once with
// --disable-sandbox (sandboxFallback) instead of failing every tool call.
// Also covers adopting a terminal session with no recorded folder (PATCH a
// folder on, open it, and re-lock once it has one), and that a loaded session
// is switched to the dashboard's approval mode (terminal sessions start in Ask).
// Usage: node test/projects-sandbox.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "mdproj-"));
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { failN++; console.log("FAIL", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const projects = path.join(T, "Projects");
const dataDir = path.join(T, "data");
fs.mkdirSync(dataDir, { recursive: true });
let mockBin = path.join(APP, "mock", "mock-muse.sh");
let museArgs = [];
if (process.platform === "win32") {
  // Node cannot spawn a .cmd wrapper, so run the mock script through Node itself.
  mockBin = process.execPath;
  museArgs = [path.join(APP, "mock", "mock-muse.mjs")];
}
const cfg = path.join(T, "config.json");
fs.writeFileSync(cfg, JSON.stringify({ projectsDir: projects, autoUpdate: false, idleShutdownSeconds: 0, sandbox: true, sandboxFallback: true, model: "mock-big", approvalMode: "allowAll", museSettings: { "run.reminder_roster": { agents: [] }, "context_compaction.tool_result_clearing_enabled": true }, ...(museArgs.length ? { museArgs } : {}) }));
const stateFile = path.join(T, "mock-state.json");
// A terminal-started session the host knows no folder for (no workspaceRoot,
// no dashboard record): the open path must let the user attach one.
const ghostId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ghostAt = new Date().toISOString();
fs.writeFileSync(stateFile, JSON.stringify({ [ghostId]: { sessionId: ghostId, createdAt: ghostAt, updatedAt: ghostAt, events: [], turnCount: 0 } }));
const child = spawn(process.execPath, ["server.js", "--no-open", "--data-dir", dataDir, "--config", cfg], {
  cwd: APP, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, MUSE_BIN: mockBin, MOCK_MUSE_STATE: stateFile, MOCK_SANDBOX: "unavailable", MUSE_DASHBOARD_SUPERVISED: "" },
});
let log = "";
child.stdout.on("data", (c) => (log += c));
child.stderr.on("data", (c) => (log += c));
try {
  let rt = null;
  for (let i = 0; i < 100 && !rt; i++) { try { rt = JSON.parse(fs.readFileSync(path.join(dataDir, "runtime.json"), "utf8")); } catch { await sleep(100); } }
  if (!rt) throw new Error("server did not start: " + log);
  const r0 = await fetch(rt.launchUrl, { redirect: "manual" });
  const cookie = (r0.headers.get("set-cookie") || "").split(";")[0];
  const H = { Cookie: cookie, "X-Muse-Dashboard": "1", "Content-Type": "application/json" };
  const mockState = () => {
    for (let i = 0; ; i++) {
      try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch (e) { if (i > 20) throw e; }
    }
  };
  const st = await (await fetch(rt.url + "api/state", { headers: H })).json();
  ok(st.projectsDir === projects, "new chats default to the Projects folder");
  const draft = await (await fetch(rt.url + "api/chats", { method: "POST", headers: H, body: JSON.stringify({ title: "Fallback Check" }) })).json();
  ok(path.basename(draft.workspace || "") === "fallback-check" && fs.existsSync(draft.workspace), "named chat creates Projects/fallback-check");
  ok(fs.existsSync(path.join(draft.workspace, "MASTER.md")) && fs.existsSync(path.join(draft.workspace, "LOG.md")), "new project folder is seeded with MASTER.md and LOG.md (session boot reads must not fail)");
  const agents = fs.existsSync(path.join(draft.workspace, "AGENTS.md")) ? fs.readFileSync(path.join(draft.workspace, "AGENTS.md"), "utf8") : "";
  ok(agents.includes("EXECUTION-POLICY.md") && !agents.includes("SESSION BOOT"), "new project folder seeds AGENTS.md as a pointer to the root policy, not a copy");
  ok(agents.includes(path.join(APP, "EXECUTION-POLICY.md")), "AGENTS.md names the policy file in this dashboard's own folder (no fixed install path)");
  const sent = await (await fetch(rt.url + `api/chats/${draft.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ text: "hello fallback" }) })).json();
  ok(!!sent.chatId, "first message starts a session despite sandbox being unavailable");
  ok(mockState()[sent.chatId]?.modelId === "mock-big", "configured default model is applied to the new session");
  let status = null;
  for (let i = 0; i < 50; i++) { status = await (await fetch(rt.url + "api/muse/status", { headers: H })).json(); if (status.host?.sandboxEffective) break; await sleep(100); }
  ok(status?.host?.sandboxFallback === true && status?.host?.sandboxEffective === "off-fallback", `sandbox fallback engaged: ${JSON.stringify(status?.host)}`);
  const hosts = fs.readFileSync(`${stateFile}.hosts`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  ok(hosts.length >= 2 && !hosts[0].includes("--disable-sandbox") && hosts[1].includes("--disable-sandbox"), "host was restarted once with --disable-sandbox");
  ok(hosts.every((h) => h.join(" ").includes('-c run.reminder_roster={"agents":[]}') && h.join(" ").includes("-c context_compaction.tool_result_clearing_enabled=true")), "museSettings reach every muse serve start as -c key=<json>");
  await fetch(rt.url + `api/chats/${sent.chatId}`, { headers: H });
  await sleep(600);
  let listed = null;
  for (let i = 0; i < 50; i++) {
    const l = await (await fetch(rt.url + "api/chats", { headers: H })).json();
    listed = l.chats.find((c) => c.id === sent.chatId);
    if (listed?.tokenUsage?.totalTokens > 0) break;
    await sleep(100);
  }
  ok(listed?.tokenUsage?.totalTokens > 0, "chat list carries the per-chat token total");
  const ghostRes = await fetch(rt.url + `api/chats/${ghostId}`, { headers: H });
  ok(ghostRes.status === 409, "folderless terminal session is not openable without a folder");
  const adoptDir = path.join(T, "adopted");
  fs.mkdirSync(adoptDir, { recursive: true });
  const adoptReal = fs.realpathSync(adoptDir);
  const adoptRes = await fetch(rt.url + `api/chats/${ghostId}`, { method: "PATCH", headers: H, body: JSON.stringify({ workspace: adoptDir }) });
  const adopt = await adoptRes.json();
  ok(adoptRes.status === 200 && adopt.workspace === adoptReal, "attaching a folder to a folderless session is allowed");
  const opened = await (await fetch(rt.url + `api/chats/${ghostId}`, { headers: H })).json();
  ok(Array.isArray(opened.items) && opened.workspace === adoptReal, "adopted session opens like any other chat");
  ok(opened.approvalMode === "allowAll", "an opened terminal session shows the dashboard approval mode");
  // Loading it (typing in it, or sending) switches the session itself to that mode.
  await fetch(rt.url + `api/chats/${ghostId}/warm`, { method: "POST", headers: H, body: JSON.stringify({ load: true }) });
  for (let i = 0; i < 50 && mockState()[ghostId]?.approvalMode !== "allowAll"; i++) await sleep(100);
  ok(mockState()[ghostId]?.approvalMode === "allowAll", `loaded terminal session is switched to the dashboard approval mode (${mockState()[ghostId]?.approvalMode})`);
  const relock = await fetch(rt.url + `api/chats/${ghostId}`, { method: "PATCH", headers: H, body: JSON.stringify({ workspace: T }) });
  ok(relock.status === 409, "a chat that already has a folder keeps it");
} catch (e) {
  failN++; console.log("FAIL exception", e, log);
} finally {
  child.kill();
}
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
