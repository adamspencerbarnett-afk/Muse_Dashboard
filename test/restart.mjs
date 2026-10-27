// Muse Dashboard · test/restart.mjs
// Author: Adam S. Barnett
//
// Settings > Restart: under start-dashboard.bat (MUSE_DASHBOARD_SUPERVISED=1)
// the server leaves a short-lived handoff and exits with code 75; the next
// start keeps the same port and access token, so an open page only reloads.
// A stale handoff is ignored. Usage: node test/restart.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "mdrestart-"));
const dataDir = path.join(T, "data");
const cfg = path.join(T, "config.json");
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(cfg, JSON.stringify({ projectsDir: path.join(T, "Projects"), idleShutdownSeconds: 0, autoUpdate: false, open: false, museBin: process.execPath, museArgs: [path.join(APP, "mock", "mock-muse.mjs")] }));
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { failN++; console.log("FAIL", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const live = new Set();
const kill = (child) => {
  if (process.platform === "win32") { try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ } }
  else child.kill("SIGTERM");
};
process.on("exit", () => { for (const c of live) kill(c); });

async function start() {
  try { fs.rmSync(path.join(dataDir, "runtime.json")); } catch { /* none */ }
  const child = spawn(process.execPath, [path.join(APP, "server.js"), "--no-open", "--data-dir", dataDir, "--config", cfg], {
    cwd: APP, stdio: "ignore", env: { ...process.env, MUSE_DASHBOARD_SUPERVISED: "1", MOCK_MUSE_STATE: path.join(T, "mock-state.json") },
  });
  live.add(child);
  child.exited = new Promise((r) => child.on("exit", (code) => { live.delete(child); r(code); }));
  for (let i = 0; i < 150; i++) {
    try { return { child, rt: JSON.parse(fs.readFileSync(path.join(dataDir, "runtime.json"), "utf8")) }; } catch { await sleep(100); }
  }
  throw new Error("server did not start");
}
const cookieOf = async (rt) => ((await fetch(rt.launchUrl, { redirect: "manual" })).headers.get("set-cookie") || "").split(";")[0];

try {
  const first = await start();
  const cookie = await cookieOf(first.rt);
  const H = { Cookie: cookie, "X-Muse-Dashboard": "1", "Content-Type": "application/json" };
  const r = await fetch(first.rt.url + "api/restart", { method: "POST", headers: H, body: "{}" });
  ok(r.status === 200, "restart accepted when supervised");
  const code = await first.child.exited;
  ok(code === 75, `server exits with the restart code (75) for start-dashboard.bat (got ${code})`);
  ok(fs.existsSync(path.join(dataDir, "restart.json")), "a handoff is left for the next start");

  const second = await start();
  ok(second.rt.port === first.rt.port && second.rt.instance !== first.rt.instance, "next start reuses the same port as a new instance");
  const st = await fetch(second.rt.url + "api/state", { headers: { Cookie: cookie } });
  ok(st.status === 200, "the open page's cookie still works (same access token)");
  ok(!fs.existsSync(path.join(dataDir, "restart.json")), "the handoff is used up");
  kill(second.child);
  await second.child.exited;

  fs.writeFileSync(path.join(dataDir, "restart.json"), JSON.stringify({ port: second.rt.port, token: cookie.split("=")[1], at: Date.now() - 120000 }));
  const third = await start();
  const stale = await fetch(third.rt.url + "api/state", { headers: { Cookie: cookie } });
  ok(stale.status === 403, "a stale handoff is ignored (fresh token)");
  kill(third.child);
  await third.child.exited;
} catch (e) {
  failN++;
  console.log("FAIL exception", e);
}
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
