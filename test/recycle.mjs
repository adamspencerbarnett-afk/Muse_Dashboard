// Muse Dashboard · test/recycle.mjs
// Author: Adam S. Barnett
//
// Focused check of Delete → Recycle Bin (lib/recycle.js + server): size and
// bin-limit check, a real round trip through the Windows Recycle Bin (the
// test folder is restored and removed again), and the server's three
// outcomes: kept in the bin; too large, so permanent only when confirmed; and
// "Windows deleted it for good" reported when the bin did not keep it.
// Usage: node test/recycle.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { recycleCheck, moveToRecycleBin } from "../lib/recycle.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mdbin-")));
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { failN++; console.log("FAIL", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const makeFolder = (dir, bytes) => { fs.mkdirSync(path.join(dir, "sub"), { recursive: true }); fs.writeFileSync(path.join(dir, "a.txt"), "x".repeat(bytes)); fs.writeFileSync(path.join(dir, "sub", "b.txt"), "yz"); };

let child = null;
try {
  // ---- module, stand-in bin ----
  const bin = path.join(T, "bin");
  fs.mkdirSync(bin);
  const f1 = path.join(T, "small");
  makeFolder(f1, 100);
  let c = await recycleCheck(f1, { test: { dir: bin, maxBytes: 1000 } });
  ok(c.files === 2 && c.bytes === 102 && c.bin === "fits", `size and fit: ${JSON.stringify(c)}`);
  c = await recycleCheck(f1, { test: { dir: bin, maxBytes: 50 } });
  ok(c.bin === "tooLarge" && c.binMaxBytes === 50, "bigger than the bin's limit: tooLarge");
  let r = await moveToRecycleBin(f1, { test: { dir: bin } });
  ok(r.inBin && !fs.existsSync(f1) && fs.readdirSync(bin).length === 1, "moved into the (stand-in) bin");

  // ---- the real Windows Recycle Bin: in and back out ----
  if (process.platform === "win32") {
    const real = path.join(T, `md-recycle-test-${Date.now()}`);
    makeFolder(real, 10);
    c = await recycleCheck(real);
    ok(["fits", "unknown"].includes(c.bin) && c.binName === "Recycle Bin", `real bin limit read for the drive: ${c.bin}, ${c.binMaxBytes} bytes`);
    r = await moveToRecycleBin(real);
    ok(r.inBin && r.binPath && fs.existsSync(r.binPath) && !fs.existsSync(real), "a real folder goes to the Windows Recycle Bin and is found there");
    // Put it back the way Explorer's Restore does, then clean up.
    const restore = `$bin = (New-Object -ComObject Shell.Application).Namespace(10); foreach ($i in $bin.Items()) { if ($i.Path -eq $env:MD_BIN_PATH) { $i.InvokeVerb('undelete'); break } }`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", restore], { env: { ...process.env, MD_BIN_PATH: r.binPath }, windowsHide: true });
    for (let i = 0; i < 30 && !fs.existsSync(path.join(real, "sub", "b.txt")); i++) await sleep(100);
    ok(fs.existsSync(path.join(real, "sub", "b.txt")), "it can be restored from the Recycle Bin to where it was");
    fs.rmSync(path.join(path.dirname(r.binPath), `$I${path.basename(r.binPath).slice(2)}`), { force: true }); // the index file Windows may leave behind
  } else console.log("SKIP real Recycle Bin round trip (Windows only)");

  // ---- server: the Delete outcomes ----
  const projects = path.join(T, "Projects");
  const dataDir = path.join(T, "data");
  const cfg = path.join(T, "config.json");
  let log = "";
  const start = async (testRecycleBin) => {
    fs.writeFileSync(cfg, JSON.stringify({ projectsDir: projects, autoUpdate: false, idleShutdownSeconds: 0, open: false, museArgs: [path.join(APP, "mock", "mock-muse.mjs")], testRecycleBin }));
    child = spawn(process.execPath, ["server.js", "--no-open", "--data-dir", dataDir, "--config", cfg], { cwd: APP, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MUSE_BIN: process.execPath, MOCK_MUSE_STATE: path.join(T, "mock.json"), MUSE_DASHBOARD_SUPERVISED: "" } });
    child.stdout.on("data", (x) => (log += x));
    child.stderr.on("data", (x) => (log += x));
    let rt = null;
    for (let i = 0; i < 150 && !rt; i++) { try { rt = JSON.parse(fs.readFileSync(path.join(dataDir, "runtime.json"), "utf8")); if (rt.pid !== child.pid) rt = null; } catch { /* starting */ } if (!rt) await sleep(100); }
    if (!rt) throw new Error("server did not start: " + log);
    const cookie = ((await fetch(rt.launchUrl, { redirect: "manual" })).headers.get("set-cookie") || "").split(";")[0];
    const H = { Cookie: cookie, "X-Muse-Dashboard": "1", "Content-Type": "application/json" };
    return async (method, p, body) => { const x = await fetch(rt.url + p, { method, headers: H, body: body && JSON.stringify(body) }); return { status: x.status, body: await x.json() }; };
  };
  const stop = async () => { const p = child; child = null; p.kill(); if (p.exitCode === null) await new Promise((res) => p.once("exit", res)); };
  const projectChat = async (call, title, bytes) => { const d = (await call("POST", "api/chats", { title })).body; fs.writeFileSync(path.join(d.workspace, "big.bin"), "z".repeat(bytes)); return d; };

  // A bin that holds 4 KB.
  let call = await start({ dir: bin, maxBytes: 4096 });
  const big = await projectChat(call, "Big Project", 8000);
  c = (await call("GET", `api/chats/${big.id}/delete-check`)).body;
  ok(c.bin === "tooLarge" && c.binMaxBytes === 4096 && c.bytes > 8000, "delete-check: a folder bigger than the bin is tooLarge");
  r = await call("DELETE", `api/chats/${big.id}?folder=recycle`);
  ok(r.status === 409 && /would be permanent/.test(r.body.error) && fs.existsSync(big.workspace), "too large: nothing is deleted without the user's OK");
  r = await call("DELETE", `api/chats/${big.id}?folder=recycle&permanent=1`);
  ok(r.status === 200 && r.body.chosenPermanent === true && r.body.inBin === false && !fs.existsSync(big.workspace), "too large + confirmed: deleted permanently, and the answer says so");
  const small = await projectChat(call, "Small Project", 10);
  r = await call("DELETE", `api/chats/${small.id}?folder=recycle&permanent=1`);
  ok(r.status === 200 && r.body.inBin === true && !r.body.chosenPermanent && fs.readdirSync(bin).some((n) => n.startsWith("small-project-")), "a folder that fits goes to the bin even if permanent=1 was sent");
  await stop();

  // A bin that "keeps" nothing, like Windows with a folder it cannot hold: the answer reports it.
  call = await start({ dir: bin, permanent: true });
  const lost = await projectChat(call, "Lost Project", 10);
  c = (await call("GET", `api/chats/${lost.id}/delete-check`)).body;
  r = await call("DELETE", `api/chats/${lost.id}?folder=recycle`);
  ok(c.bin === "fits" && r.status === 200 && r.body.inBin === false && !r.body.chosenPermanent && !fs.existsSync(lost.workspace), "the bin did not keep it: the answer says it was deleted for good (the page tells the user)");
  await stop();
} catch (e) {
  failN++; console.log("FAIL exception", e);
} finally {
  if (child) child.kill();
  await sleep(300);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* a mock may still hold a file */ }
}
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
