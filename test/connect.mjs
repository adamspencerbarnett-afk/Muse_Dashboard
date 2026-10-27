// Muse Dashboard · test/connect.mjs
// Author: Adam S. Barnett
//
// The Muse Code connection check (lib/connect.js) and its server flow, against
// mock/mock-muse.mjs, which is signed in only while MUSE_AUTH_PATH exists:
// installed / signed out / not installed / unclear answers are told apart;
// a dashboard started signed out reports it, "Sign in with Meta" runs the
// sign-in and the server notices the new sign-in by itself; a reply that
// fails for lack of a sign-in flips the state back; Check again re-asks.
// Usage: node test/connect.mjs   (npm run test:connect)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkConnection, startSignIn, authFile, INSTALL_COMMAND } from "../lib/connect.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOCK = path.join(APP, "mock", "mock-muse.mjs");
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { failN++; console.log("FAIL", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 8000) => { for (const t = Date.now(); Date.now() - t < ms;) { const v = await cond(); if (v) return v; await sleep(100); } return cond(); };

const T = fs.mkdtempSync(path.join(os.tmpdir(), "mdconnect-"));
const AUTH = path.join(T, "auth.json");
process.env.MUSE_AUTH_PATH = AUTH;
const mockConfig = { museBin: process.execPath, museArgs: [MOCK] };

// ---- lib/connect.js ----
ok(authFile({ MUSE_AUTH_PATH: "x/auth.json" }) === "x/auth.json", "MUSE_AUTH_PATH names the sign-in file");
ok(authFile({ XDG_CONFIG_HOME: path.join(T, "cfg") }) === path.join(T, "cfg", "muse", "auth.json"), "otherwise <config home>/muse/auth.json, like Muse's launcher");
ok(/dev\.meta\.ai\/install\.(ps1|sh)/.test(INSTALL_COMMAND), `install command is Meta's official installer: ${INSTALL_COMMAND}`);
let c = await checkConnection(mockConfig);
ok(c.state === "signedOut", `no sign-in: signedOut (got ${c.state})`);
const r = await startSignIn({ ...mockConfig, loginCommand: [process.execPath, MOCK, "login"] }, T);
ok(r.started === true && fs.existsSync(AUTH), "startSignIn runs Muse's login (test hook), which saves the sign-in");
c = await checkConnection(mockConfig);
ok(c.state === "connected" && c.tier === "Mock Tier", `after sign-in: connected with the subscription tier (got ${c.state} ${c.tier})`);
c = await checkConnection({ museBin: path.join(T, "no-such-muse.exe") });
ok(c.state === "notInstalled", `a Muse binary that does not exist: notInstalled (got ${c.state})`);
c = await checkConnection({ museBin: process.execPath, museArgs: ["-e", "console.error('network down'); process.exit(3)"] });
ok(c.state === "unknown" && /network down/.test(c.message), `any other failure is "unknown" with Muse's message, not a sign-in problem (got ${c.state}: ${c.message})`);
c = await checkConnection({ museBin: process.execPath, museArgs: ["-e", "setTimeout(() => {}, 60000)"] }, { timeoutMs: 500 });
ok(c.state === "unknown" && /in time/.test(c.message), "a Muse that does not answer times out as unknown");
if (process.platform !== "win32") ok((await startSignIn(mockConfig, T)).manual === "muse login", "outside Windows the page shows `muse login` to run in a terminal");

// ---- the server flow ----
fs.rmSync(AUTH, { force: true });
const dataDir = path.join(T, "data");
const cfg = path.join(T, "config.json");
fs.writeFileSync(cfg, JSON.stringify({ ...mockConfig, loginCommand: [process.execPath, MOCK, "login"], projectsDir: path.join(T, "Projects"), idleShutdownSeconds: 0, autoUpdate: false, open: false, approvalMode: "allowAll" }));
const server = spawn(process.execPath, [path.join(APP, "server.js"), "--no-open", "--data-dir", dataDir, "--config", cfg], {
  cwd: APP, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MOCK_MUSE_STATE: path.join(T, "mock-state.json"), MUSE_DASHBOARD_SUPERVISED: "" },
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const stop = () => {
  if (process.platform === "win32") { try { execFileSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ } }
  else server.kill("SIGTERM");
};
process.on("exit", stop);
const ctl = new AbortController();
try {
  const rt = await until(() => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, "runtime.json"), "utf8")); } catch { return null; } });
  if (!rt) throw new Error(`dashboard did not start\n${log}`);
  const cookie = ((await fetch(rt.launchUrl, { redirect: "manual" })).headers.get("set-cookie") || "").split(";")[0];
  const H = { Cookie: cookie, "X-Muse-Dashboard": "1", "Content-Type": "application/json" };
  const api = async (method, p, body) => (await fetch(rt.url + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) })).json();

  const events = [];
  void (async () => {
    try {
      const s = await fetch(rt.url + "api/events", { headers: { Cookie: cookie }, signal: ctl.signal });
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of s.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = (/^event: (.*)$/m.exec(block) || [])[1];
          const data = (/^data: (.*)$/m.exec(block) || [])[1];
          if (type) events.push({ type, data: data ? JSON.parse(data) : null });
        }
      }
    } catch { /* aborted at the end */ }
  })();
  const sawConnection = (state) => events.some((e) => e.type === "connection" && e.data.state === state);
  await until(() => events.length >= 3);
  ok(events[0]?.type === "hello" && events[1]?.type === "muse-status" && events[2]?.type === "connection", "the event stream opens with the current Muse status and connection, so a page never misses an earlier change");

  const first = await until(async () => { const x = await api("GET", "api/connection"); return x.state !== "checking" && x; });
  ok(first.state === "signedOut", `a dashboard started without a Meta sign-in says so (got ${first.state})`);
  const st = await api("GET", "api/state");
  ok(st.connection?.state === "signedOut" && st.installCommand === INSTALL_COMMAND, "/api/state carries the connection and the install command for the page");

  const si = await api("POST", "api/connection/sign-in", {});
  ok(si.started === true, "Sign in with Meta starts Muse's login");
  ok(await until(() => sawConnection("connected")), "the server notices the new sign-in by itself (no Check again needed) and tells the page");
  ok(await until(() => events.some((e) => e.type === "muse-restarted" && e.data.reason === "signIn")), "the Muse host restarts once idle to pick up the sign-in (reason signIn, not an update)");

  // The sign-in expires: the next reply fails with authRequired and the page is told.
  fs.rmSync(AUTH, { force: true });
  const chat = await api("POST", "api/chats", { title: "Auth check" });
  const sent = await api("POST", `api/chats/${chat.id}/messages`, { text: "hello" });
  ok(!!sent.chatId, "a message can still be sent while signed out");
  ok(await until(() => events.some((e) => e.type === "muse" && e.data.method === "turn/completed" && e.data.params?.error?.kind === "authRequired")), "the reply fails with authRequired");
  ok(await until(() => events.filter((e) => e.type === "connection").at(-1)?.data.state === "signedOut"), "a reply failing for lack of a sign-in switches the connection to signedOut");

  const again = await api("POST", "api/connection/check", {});
  ok(again.state === "signedOut", "Check again re-asks Muse (still signed out)");
  fs.writeFileSync(AUTH, "{}");
  const back = await api("POST", "api/connection/check", {});
  ok(back.state === "connected" && back.tier === "Mock Tier", "Check again after signing in elsewhere: connected");
} catch (e) {
  failN++;
  console.log("FAIL exception", e, log.slice(-2000));
} finally {
  ctl.abort();
  stop();
  await sleep(300);
  fs.rmSync(T, { recursive: true, force: true, maxRetries: 5 });
}
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
