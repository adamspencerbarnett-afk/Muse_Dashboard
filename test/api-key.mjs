// Muse Dashboard · test/api-key.mjs
// Author: Adam S. Barnett
//
// Focused check of the API-key connection (lib/api-key.js + server): the key
// is stored encrypted by the OS (no plaintext anywhere in data/), Meta's key
// check against a local stand-in (accepted, refused, unreachable), Muse
// getting META_API_KEY only when a key is chosen (subscription mode strips one
// inherited from the environment), the sign-in check following the chosen
// connection (signed out → add a key → connected), and a key Meta refuses
// during a reply turning into "keyRefused". Never prints a key.
// Usage: node test/api-key.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ApiKeyStore, checkApiKey, secretStoreKind, looksLikeApiKey, withMetaApiKey } from "../lib/api-key.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mdkey-")));
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { failN++; console.log("FAIL", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeKey = (prefix = "test-") => `${prefix}${crypto.randomBytes(24).toString("hex")}`;
/** Does any file under dir contain s? */
const anyFileHas = (dir, s) => fs.readdirSync(dir, { recursive: true }).some((n) => { const p = path.join(dir, n); return fs.statSync(p).isFile() && fs.readFileSync(p, "latin1").includes(s); });

// A stand-in for Meta's /v1/models: one good key, everything else refused.
const GOOD = fakeKey();
const meta = http.createServer((req, res) => {
  const good = req.url === "/v1/models" && req.headers.authorization === `Bearer ${GOOD}`;
  res.writeHead(good ? 200 : 401, { "Content-Type": "application/json" });
  res.end(JSON.stringify(good ? { data: [{ id: "muse-spark-1.3" }, { id: "muse-wonder-1.0" }] } : { error: { code: "invalid_api_key" } }));
});
await new Promise((r) => meta.listen(0, "127.0.0.1", r));
const META = `http://127.0.0.1:${meta.address().port}/v1`;

let child = null;
try {
  // ---- module ----
  ok(looksLikeApiKey(GOOD) && !looksLikeApiKey("short") && !looksLikeApiKey(`${GOOD} x`) && !looksLikeApiKey(`${GOOD}"`), "key format check");
  const env = withMetaApiKey({ PATH: "x", Meta_Api_Key: "inherited" }, null);
  ok(!Object.keys(env).some((k) => k.toUpperCase() === "META_API_KEY") && env.PATH === "x" && withMetaApiKey(env, "k").META_API_KEY === "k", "withMetaApiKey removes any inherited key (any case) and sets exactly the chosen one");
  const good = await checkApiKey(GOOD, META);
  ok(good.ok && good.models.length === 2, "a good key passes the check and lists its models");
  const bad = await checkApiKey(fakeKey(), META);
  ok(!bad.ok && bad.reason === "refused" && /invalid_api_key/.test(bad.message), "a refused key is reported as refused");
  const off = await checkApiKey(GOOD, "http://127.0.0.1:9/v1");
  ok(!off.ok && off.reason === "unreachable", "no answer is reported as unreachable, not as refused");

  const kind = await secretStoreKind();
  if (!kind) console.log("SKIP secure key store tests (no Secret Service on this system)");
  else {
    const dir = path.join(T, "store");
    fs.mkdirSync(dir);
    const s1 = new ApiKeyStore(dir);
    await s1.load();
    const k = fakeKey();
    await s1.save(k);
    ok(s1.saved?.last4 === k.slice(-4) && s1.saved.store === kind, `saved in the ${kind} store; only the last 4 characters are kept in the clear`);
    ok(!anyFileHas(dir, k) && !anyFileHas(dir, k.slice(0, 20)), "no plaintext key in the data folder");
    const s2 = new ApiKeyStore(dir);
    await s2.load();
    ok((await s2.read()) === k, "a fresh load decrypts the same key");
    await s2.setMode("apiKey");
    await s2.remove();
    ok(s2.saved === null && s2.mode === "subscription" && (await s2.read()) === null, "remove deletes the key and falls back to the subscription");
  }

  // ---- server + mock Muse ----
  const dataDir = path.join(T, "data");
  const stateFile = path.join(T, "mock-state.json");
  const envLog = `${stateFile}.env`;
  const authPath = path.join(T, "auth.json"); // the mock's Meta sign-in: signed in while this file exists
  const cfg = path.join(T, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ projectsDir: path.join(T, "Projects"), autoUpdate: false, idleShutdownSeconds: 0, open: false, approvalMode: "allowAll", metaApiBaseUrl: META, museArgs: [path.join(APP, "mock", "mock-muse.mjs")] }));
  const INHERITED = fakeKey();
  let log = "";
  const start = async (extraEnv) => {
    child = spawn(process.execPath, ["server.js", "--no-open", "--data-dir", dataDir, "--config", cfg], { cwd: APP, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MUSE_BIN: process.execPath, MOCK_MUSE_STATE: stateFile, MUSE_AUTH_PATH: authPath, MUSE_DASHBOARD_SUPERVISED: "", ...extraEnv } });
    child.stdout.on("data", (c) => (log += c));
    child.stderr.on("data", (c) => (log += c));
    let rt = null;
    for (let i = 0; i < 150 && !rt; i++) { try { rt = JSON.parse(fs.readFileSync(path.join(dataDir, "runtime.json"), "utf8")); if (rt.pid !== child.pid) rt = null; } catch { /* starting */ } if (!rt) await sleep(100); }
    if (!rt) throw new Error("server did not start: " + log);
    const cookie = ((await fetch(rt.launchUrl, { redirect: "manual" })).headers.get("set-cookie") || "").split(";")[0];
    const H = { Cookie: cookie, "X-Muse-Dashboard": "1", "Content-Type": "application/json" };
    return async (method, p, body) => { const r = await fetch(rt.url + p, { method, headers: H, body: body && JSON.stringify(body) }); const text = await r.text(); return { status: r.status, text, body: JSON.parse(text || "null") }; };
  };
  const stop = async () => { if (!child) return; const c = child; child = null; c.kill(); if (c.exitCode === null) await new Promise((r) => c.once("exit", r)); };
  // The key the newest Muse host started with: null, or its last 4 characters (the mock logs nothing more).
  const hostLines = () => (fs.existsSync(envLog) ? fs.readFileSync(envLog, "utf8").trim().split("\n") : []);
  const hostCount = () => hostLines().length;
  /** Wake the Muse host (a model list starts one) and wait for a host newer than `after`. */
  const nextHost = async (call, after) => { for (let i = 0; i < 100 && hostCount() <= after; i++) { await call("GET", "api/models"); await sleep(100); } return hostCount() > after ? JSON.parse(hostLines().at(-1)).metaApiKeyLast4 : undefined; };
  /** The connection once the startup check has run. */
  const settled = async (call) => { for (let i = 0; i < 100; i++) { const c = (await call("GET", "api/connection")).body; if (c.state !== "checking") return c; await sleep(100); } return null; };

  // Signed in, started with META_API_KEY in the environment and no saved choice: "env" (as before this setting existed).
  fs.writeFileSync(authPath, "{}");
  let call = await start({ META_API_KEY: INHERITED });
  let c = await settled(call);
  ok(c.via === "env" && c.envKey === true && c.apiKey === null && c.state === "connected", `with META_API_KEY in the environment the default is "env" (${c.via}, ${c.state})`);
  ok((await nextHost(call, 0)) === INHERITED.slice(-4), "env mode: Muse gets the inherited key");
  let n = hostCount();
  let r = await call("POST", "api/connection/mode", { mode: "subscription" });
  ok(r.status === 200 && r.body.via === "subscription" && r.body.state === "connected" && r.body.tier === "Mock Tier", "switch to the subscription: checked again, shows the subscription tier");
  ok((await nextHost(call, n)) === null, "subscription mode: Muse is restarted without META_API_KEY, even though the environment has one");
  await stop();

  // Signed out: the Connect dialog's "Use an API key" path.
  fs.rmSync(authPath);
  call = await start({ META_API_KEY: "" });
  c = await settled(call);
  ok(c.state === "signedOut" && c.via === "subscription" && c.envKey === false, "signed out, no key: signedOut");
  r = await call("POST", "api/connection/mode", { mode: "apiKey" });
  ok(r.status === 409, "API-key mode needs a saved key first");
  r = await call("POST", "api/connection/mode", { mode: "env" });
  ok(r.status === 409, "env mode needs META_API_KEY in the environment");
  r = await call("POST", "api/connection/api-key", { key: "not a key" });
  ok(r.status === 400, "a malformed key is refused before any check");
  r = await call("POST", "api/connection/api-key", { key: fakeKey() });
  ok(r.status === 422 && /refused/.test(r.body.error) && (await call("GET", "api/connection")).body.apiKey === null, "a key Meta refuses is not saved");
  n = hostCount();
  r = await call("POST", "api/connection/api-key", { key: GOOD });
  ok(r.status === 200 && r.body.via === "apiKey" && r.body.state === "connected" && r.body.apiKey?.last4 === GOOD.slice(-4) && r.body.models === 2 && r.body.checked === true, "a good key is checked, saved and switched to; the sign-in check now says connected");
  ok(!r.text.includes(GOOD), "the answer never carries the key");
  ok((await nextHost(call, n)) === GOOD.slice(-4), "Muse is restarted with the saved key");
  const shown = await call("GET", "api/connection");
  ok(!shown.text.includes(GOOD) && shown.body.apiKey.last4 === GOOD.slice(-4), "status shows only the last 4 characters");
  ok(!anyFileHas(dataDir, GOOD.slice(0, 20)), "no plaintext key anywhere in data/");
  const draft = (await call("POST", "api/chats", { title: "Key chat" })).body;
  const sent = await call("POST", `api/chats/${draft.id}/messages`, { text: "hello" });
  ok(sent.status === 200, "a reply runs on the key");
  await stop();

  // A restart keeps the choice and decrypts the key again.
  call = await start({ META_API_KEY: "" });
  n = hostCount();
  c = await settled(call);
  ok(c.via === "apiKey" && c.state === "connected" && !c.notice, "after a restart the saved choice and key are back");
  ok((await nextHost(call, n)) === GOOD.slice(-4), "the restarted dashboard gives Muse the decrypted key");

  // A key Meta stops accepting: the next reply fails and the connection says so.
  r = await call("POST", "api/connection/api-key", { key: fakeKey("refused-"), skipCheck: true });
  ok(r.status === 200 && r.body.checked === false && r.body.via === "apiKey", "skipCheck saves without Meta's check (offered only when Meta was unreachable)");
  const d2 = (await call("POST", "api/chats", { title: "Refused" })).body;
  await call("POST", `api/chats/${d2.id}/messages`, { text: "hello" });
  let refused = null;
  for (let i = 0; i < 60 && refused?.state !== "keyRefused"; i++) { refused = (await call("GET", "api/connection")).body; await sleep(100); }
  ok(refused?.state === "keyRefused", "a reply refused for the key turns the connection into keyRefused (Connect dialog)");

  n = hostCount();
  r = await call("DELETE", "api/connection/api-key");
  ok(r.status === 200 && r.body.via === "subscription" && r.body.apiKey === null && r.body.state === "signedOut", "remove: key gone, back on the subscription (still signed out, so the dialog asks to sign in)");
  ok((await nextHost(call, n)) === null, "Muse is restarted without a key");
  ok(!/(test|refused)-[0-9a-f]{20}/.test(log), "no key in the server's output");
} catch (e) {
  failN++; console.log("FAIL exception", e.message);
} finally {
  if (child) child.kill();
  meta.close();
  await sleep(300);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* a mock may still hold a file */ }
}
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
