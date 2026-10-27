// Muse Dashboard · test/portable.mjs
// Author: Adam S. Barnett
//
// Focused check that a dashboard copy is self-contained and can be moved:
// the chat list shows only this copy's chats (Muse's session list is shared by
// every copy and the terminal), a session from outside is listed only with
// show-other and becomes this copy's chat once continued here, starter
// AGENTS.md names the policy by a relative path, and after the whole folder is
// renamed the chats' folders follow it (a session Muse still runs in the old
// path gets a plain 409 instead of a broken turn).
// Usage: node test/portable.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mdport-")));
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { failN++; console.log("FAIL", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A copy of the dashboard (node_modules linked, not copied).
const A = path.join(T, "copy-a"), B = path.join(T, "copy-b");
const skip = new Set(["node_modules", "Projects", "data", ".git", "config.json", ".dashboard-url"]);
fs.cpSync(APP, A, { recursive: true, filter: (src) => !(path.dirname(src) === APP && skip.has(path.basename(src))) });
fs.symlinkSync(path.join(APP, "node_modules"), path.join(A, "node_modules"), process.platform === "win32" ? "junction" : "dir");
const cfg = path.join(T, "config.json");
fs.writeFileSync(cfg, JSON.stringify({ autoUpdate: false, idleShutdownSeconds: 0, open: false, approvalMode: "allowAll", museArgs: [path.join(APP, "mock", "mock-muse.mjs")] }));
const stateFile = path.join(T, "mock-state.json");
const elsewhere = path.join(T, "elsewhere");
fs.mkdirSync(elsewhere);
const now = new Date().toISOString();
const foreignId = "11111111-2222-4333-8444-000000000001";
const termId = "11111111-2222-4333-8444-000000000002";
const termDir = path.join(A, "Projects", "from-terminal");
fs.mkdirSync(termDir, { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify({
  [foreignId]: { sessionId: foreignId, workspaceRoot: elsewhere, createdAt: now, updatedAt: now, events: [], turnCount: 0, firstUserPrompt: "another copy's chat" },
  [termId]: { sessionId: termId, workspaceRoot: fs.realpathSync(termDir), createdAt: now, updatedAt: now, events: [], turnCount: 0, firstUserPrompt: "muse-here chat" },
}));

async function start(dir) {
  const child = spawn(process.execPath, ["server.js", "--no-open", "--config", cfg], {
    cwd: dir, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MUSE_BIN: process.execPath, MOCK_MUSE_STATE: stateFile, MUSE_DASHBOARD_SUPERVISED: "" },
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  let rt = null;
  for (let i = 0; i < 150 && !rt; i++) { try { rt = JSON.parse(fs.readFileSync(path.join(dir, "data", "runtime.json"), "utf8")); if (rt.pid !== child.pid) rt = null; } catch { /* starting */ } if (!rt) await sleep(100); }
  if (!rt) throw new Error("server did not start: " + log);
  const cookie = ((await fetch(rt.launchUrl, { redirect: "manual" })).headers.get("set-cookie") || "").split(";")[0];
  const H = { Cookie: cookie, "X-Muse-Dashboard": "1", "Content-Type": "application/json" };
  const call = async (method, p, body) => { const r = await fetch(rt.url + p, { method, headers: H, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const stop = async () => { child.kill(); await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r))); };
  return { call, stop, log: () => log };
}
const listIds = async (s, q = "") => (await s.call("GET", `api/chats${q}`)).body.chats;

let s = null;
try {
  // ---- copy A ----
  s = await start(A);
  const realA = fs.realpathSync(A);
  let chats = await listIds(s);
  ok(!chats.some((c) => c.id === foreignId), "a session from another copy / folder is not in this copy's chat list");
  ok(chats.some((c) => c.id === termId && !c.other), "a session working inside this copy's Projects folder is listed");
  chats = await listIds(s, "?other=1");
  ok(chats.some((c) => c.id === foreignId && c.other), "show-other lists it, marked as from outside");

  const game = (await s.call("POST", "api/chats", { title: "Moved Game" })).body;
  ok(game.workspace === path.join(realA, "Projects", "moved-game"), `new chat folder inside the copy (${game.workspace})`);
  const agents = fs.readFileSync(path.join(game.workspace, "AGENTS.md"), "utf8");
  const rel = (agents.match(/Standing operating guide: `([^`]+)`/) || [])[1];
  ok(rel === "../../EXECUTION-POLICY.md" && fs.existsSync(path.resolve(game.workspace, rel)), `AGENTS.md names the policy relatively (${rel})`);
  const sent = (await s.call("POST", `api/chats/${game.id}/messages`, { text: "hello" })).body;
  const gameId = sent.chatId;
  const draft = (await s.call("POST", "api/chats", { title: "Draft Stays" })).body;

  const cont = await s.call("POST", `api/chats/${foreignId}/messages`, { text: "continue here" });
  ok(cont.status === 200, `continuing an outside session here works (${cont.status})`);
  await sleep(2200); // past the session-list cache
  chats = await listIds(s);
  ok(chats.some((c) => c.id === foreignId && !c.other), "once continued here it is this copy's chat");
  await s.stop();
  s = null;

  // ---- move the whole folder ----
  let renamed = false;
  for (let i = 0; i < 50 && !renamed; i++) { try { fs.renameSync(A, B); renamed = true; } catch { await sleep(200); } }
  ok(renamed, "the dashboard folder can be renamed after it stops");

  // ---- copy B ----
  s = await start(B);
  const realB = fs.realpathSync(B);
  const d2 = (await s.call("GET", `api/chats/${draft.id}`)).body;
  ok(d2.workspace === path.join(realB, "Projects", "draft-stays"), `chat folders follow the move (${d2.workspace})`);
  chats = await listIds(s);
  const moved = chats.find((c) => c.id === gameId);
  ok(moved && moved.workspace === path.join(realB, "Projects", "moved-game"), "the moved chat is listed with its new folder");
  ok(chats.some((c) => c.id === foreignId), "a chat adopted before the move is still this copy's chat");
  const opened = await s.call("GET", `api/chats/${gameId}`);
  ok(opened.status === 200 && Array.isArray(opened.body.items), `its history still opens (${opened.status} ${JSON.stringify(opened.body).slice(0, 300)})`);
  const again = await s.call("POST", `api/chats/${gameId}/messages`, { text: "more" });
  ok(again.status === 409 && /no longer exists/.test(again.body?.error || ""), `continuing it says plainly that Muse still uses the old folder (${again.status} ${JSON.stringify(again.body).slice(0, 300)})`);
  const rel2 = (fs.readFileSync(path.join(realB, "Projects", "moved-game", "AGENTS.md"), "utf8").match(/Standing operating guide: `([^`]+)`/) || [])[1];
  ok(fs.existsSync(path.resolve(realB, "Projects", "moved-game", rel2)), "AGENTS.md's policy link still resolves after the move");
  const fresh = (await s.call("POST", "api/chats", { title: "After Move" })).body;
  ok(fresh.workspace === path.join(realB, "Projects", "after-move"), "new chats go into the moved copy's Projects folder");
} catch (e) {
  failN++; console.log("FAIL exception", e, s?.log());
} finally {
  if (s) await s.stop();
  await sleep(300);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* a Muse mock may still hold a file */ }
}
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
