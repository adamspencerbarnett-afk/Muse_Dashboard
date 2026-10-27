// Muse Dashboard · test/lifecycle-mock.mjs
// Author: Adam S. Barnett
//
// Lifecycle checks (box/CI only, POSIX): idle auto-shutdown, never mid-turn,
// no orphaned `muse serve` (mock) processes after idle stop, SIGTERM, or SIGKILL
// of the dashboard, and stale runtime.json handling.
// Usage: node test/lifecycle-mock.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "mdlife-"));
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { failN++; console.log("FAIL", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// List processes from ps (pgrep -f via a shell would also match that shell).
const procs = () => execSync("ps -eo pid=,args=").toString().split("\n").map((l) => l.trim()).filter(Boolean)
  .map((l) => { const m = /^(\d+)\s+(.*)$/.exec(l); return { pid: Number(m[1]), args: m[2] }; });
const find = (re) => procs().filter((p) => re.test(p.args)).map((p) => p.pid);
const mocks = () => find(/^node \S*mock-muse\.mjs serve/);
const grandkids = () => find(/^sleep 4242$/);
const watchdogs = () => find(/lib\/watchdog\.js/);

function start(name, { idle = 3, env = {} } = {}) {
  const dir = path.join(T, name);
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ projectsDir: path.join(dir, "Projects"), idleShutdownSeconds: idle, autoUpdate: false }));
  return launch(dir, env);
}
function launch(dir, env = {}) {
  const log = fs.openSync(path.join(dir, "server.log"), "a");
  const child = spawn(process.execPath, ["server.js", "--no-open", "--data-dir", path.join(dir, "data"), "--config", path.join(dir, "config.json")], {
    cwd: APP, stdio: ["ignore", log, log],
    env: { ...process.env, MUSE_BIN: path.join(APP, "mock/mock-muse.sh"), MOCK_MUSE_STATE: path.join(dir, "mock-state.json"), MOCK_GRANDCHILD: "1", ...env },
  });
  child.exitCode_ = null;
  child.on("exit", (c) => { child.exitCode_ = c; child.exited = true; });
  return { dir, child, rt: () => JSON.parse(fs.readFileSync(path.join(dir, "data/runtime.json"), "utf8")), log: () => fs.readFileSync(path.join(dir, "server.log"), "utf8") };
}
async function ready(s) {
  for (let i = 0; i < 100; i++) { try { return s.rt(); } catch { await sleep(100); } }
  throw new Error("server did not start: " + s.log());
}
async function login(rt) {
  const r = await fetch(rt.launchUrl, { redirect: "manual" });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  return { Cookie: cookie, "X-Muse-Dashboard": "1", "Content-Type": "application/json" };
}
function tab(rt, H, client = Math.random().toString(36).slice(2)) {
  const ctl = new AbortController();
  const events = [];
  const done = (async () => {
    try {
      const s = await fetch(rt.url + `api/events?client=${client}`, { headers: { Cookie: H.Cookie }, signal: ctl.signal });
      const rd = s.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf("\n\n")) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(blk)?.[1]; const d = /^data: (.*)$/m.exec(blk)?.[1]; if (ev) events.push({ ev, data: d ? JSON.parse(d) : null }); }
      }
    } catch { /* aborted */ }
  })();
  return { close: () => ctl.abort(), events, done, client };
}
async function startChat(rt, H, text) {
  let r = await fetch(rt.url + "api/chats", { method: "POST", headers: H, body: "{}" });
  const c = await r.json();
  r = await fetch(rt.url + `api/chats/${c.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ text }) });
  return r.json();
}
async function until(fn, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(100); } return false; }

try {
  // ---- A: idle auto-shutdown, refresh survives, never mid-turn ----
  const A = start("A", { env: { MOCK_STUBBORN: "1", MOCK_MUSE_DELAY: "200" } }); // stubborn host: must be force-killed
  let rt = await ready(A); let H = await login(rt);
  ok(watchdogs().length >= 1, "watchdog helper running");
  let t1 = tab(rt, H);
  await startChat(rt, H, "hello");
  await until(() => mocks().length > 0 && grandkids().length > 0, 5000);
  ok(mocks().length === 1 && grandkids().length === 1, "muse host (mock) and its child are running");
  let h = await (await fetch(rt.url + "api/health")).json();
  ok(h.tabs === 1, "server counts 1 open tab");
  // refresh: close + reopen within the idle window
  t1.close(); await sleep(1500);
  const t2 = tab(rt, H); await sleep(2500);
  ok(!A.child.exited, "closing and reopening the tab (refresh) does not stop the server");
  // beacon hint: tab says goodbye but its connection lingers -> counted as gone
  await fetch(rt.url + `api/bye?client=${t2.client}`, { method: "POST", headers: { Cookie: H.Cookie } });
  h = await (await fetch(rt.url + "api/health")).json();
  ok(h.tabs === 0, "sendBeacon /api/bye marks that tab as leaving");
  // reopen a tab, start a long turn, close the tab: must wait for the turn
  const t3 = tab(rt, H); t2.close(); await sleep(300);
  const long = await startChat(rt, H, "long one ".repeat(60));
  await sleep(300); t3.close();
  const turnStart = Date.now();
  await sleep(3800);
  h = await fetch(rt.url + "api/health").then((r) => r.json()).catch(() => null);
  console.log("   health mid-turn:", JSON.stringify(h));
  ok(!A.child.exited && h && h.busy, "no tab for > idle time but a turn is running: still up");
  await until(() => A.child.exited, 40000);
  ok(A.child.exited && A.child.exitCode_ === 0, `stopped by itself after the turn finished (${Math.round((Date.now() - turnStart) / 1000)} s), exit code 0`);
  ok(/shutting down/.test(A.log()), "log explains the idle shutdown");
  ok(!fs.existsSync(path.join(A.dir, "data/runtime.json")), "runtime.json removed");
  await sleep(500);
  ok(mocks().length === 0, "no muse host left after idle shutdown (stubborn host force-killed)");
  ok(grandkids().length === 0, "no grandchild left after idle shutdown");
  await until(() => watchdogs().length === 0, 3000);
  ok(watchdogs().length === 0, "watchdog exited");

  // ---- B: dashboard killed hard (SIGKILL ~ console closed / Task Manager) ----
  const B = start("B", { idle: 0, env: { MOCK_STUBBORN: "1" } });
  rt = await ready(B); H = await login(rt);
  await startChat(rt, H, "hello");
  await until(() => mocks().length > 0 && grandkids().length > 0, 5000);
  ok(mocks().length === 1, "B: host running");
  const staleRt = rt;
  B.child.kill("SIGKILL");
  const gone = await until(() => mocks().length === 0 && grandkids().length === 0, 5000);
  ok(gone, "after SIGKILL of the dashboard the watchdog killed the host and its child");
  await until(() => watchdogs().length === 0, 3000);
  ok(watchdogs().length === 0, "watchdog exited after cleaning up");
  ok(fs.existsSync(path.join(B.dir, "data/runtime.json")), "B left a stale runtime.json (expected after SIGKILL)");

  // ---- C: stale runtime.json is ignored ----
  const C = launch(B.dir);
  const rtC = await ready({ ...C, rt: () => { const x = JSON.parse(fs.readFileSync(path.join(B.dir, "data/runtime.json"), "utf8")); if (x.instance === staleRt.instance) throw 0; return x; } });
  ok(rtC.instance !== staleRt.instance && !C.child.exited, "new start ignores the stale runtime.json and runs");
  ok(/stale/.test(C.log()), "log mentions the stale file");
  // a second start while C is running just reuses it
  const D = launch(B.dir);
  await until(() => D.child.exited, 8000);
  ok(D.child.exited && D.child.exitCode_ === 0 && /already running/.test(D.log()), "second start detects the running instance and exits");
  // ---- E: SIGTERM (Ctrl+C) graceful ----
  H = await login(rtC);
  await startChat(rtC, H, "hello");
  await until(() => mocks().length > 0, 5000);
  C.child.kill("SIGTERM");
  await until(() => C.child.exited, 10000);
  ok(C.child.exited && mocks().length === 0 && grandkids().length === 0, "SIGTERM: stopped, no host or child left");
  ok(!fs.existsSync(path.join(B.dir, "data/runtime.json")), "SIGTERM: runtime.json removed");

  // ---- F: idleShutdownSeconds 0 disables ----
  const F = start("F", { idle: 0 });
  rt = await ready(F); H = await login(rt);
  const tf = tab(rt, H); await sleep(300); tf.close();
  await sleep(4000);
  ok(!F.child.exited, "idleShutdownSeconds 0: stays up with no tab");
  F.child.kill("SIGTERM"); await until(() => F.child.exited, 5000);

  // ---- G: page notice event ----
  const G = start("G", { idle: 1 });
  rt = await ready(G); H = await login(rt);
  const tg = tab(rt, H);
  await sleep(300);
  G.child.kill("SIGTERM");
  await until(() => G.child.exited, 5000);
  await sleep(200);
  ok(tg.events.some((e) => e.ev === "server-stopping"), "open tab is told the server is stopping");
} catch (e) {
  failN++; console.log("FAIL exception", e);
} finally {
  for (const p of [...mocks(), ...grandkids(), ...watchdogs()]) { try { process.kill(p, "SIGKILL"); } catch {} }
}
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
