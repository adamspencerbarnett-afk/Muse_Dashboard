// Muse Dashboard · lib/install.js
// Author: Adam S. Barnett
//
// Finding the installed Muse Code, and keeping it current with Muse's own updater.
//
// How Meta's installer sets Muse up (dev.meta.ai/install.ps1 or install.sh):
//  - `muse` on PATH is a small launcher: muse.cmd in %LOCALAPPDATA%\Programs\muse
//    on Windows, ~/.local/bin/muse elsewhere. On Windows it runs the active
//    binary `muse-bin-<version>.exe` named by the `.muse-version` file next to it.
//  - The launcher checks for updates at most once an hour in the background.
//    With MUSE_SYNC_UPDATE=1 it updates now (download, checksum, switch
//    `.muse-version`) before running the command; MUSE_LOGIN=0 stops it from
//    starting an interactive sign-in.
//  - Node cannot use muse.cmd as a stdio JSON-RPC host (it goes through
//    PowerShell), so `muse serve` is spawned on the active binary the same way
//    the launcher resolves it, with the same MUSE_RELEASE_INFO environment.
//    Where no such binary sits next to the launcher, the launcher itself is used.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.\-+]*$/;
const IS_WIN = process.platform === "win32";

function readTrim(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

/** Find muse.cmd (Windows) or muse (elsewhere) on PATH, plus the default Windows install folder. */
function findLauncher() {
  const names = IS_WIN ? ["muse.cmd", "muse.bat", "muse.exe"] : ["muse"];
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  if (IS_WIN) dirs.push(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "muse"));
  else dirs.push(path.join(os.homedir(), ".local", "bin"));
  for (const d of dirs) {
    for (const n of names) {
      const full = path.join(d, n);
      try {
        if (fs.statSync(full).isFile()) return { launcher: full, dir: d };
      } catch { /* keep looking */ }
    }
  }
  return null;
}

/** The binary the launcher would run right now, read from its own state files. */
function activeBinary(dir) {
  const version = readTrim(path.join(dir, ".muse-version"));
  if (!version || !VERSION_RE.test(version)) return null;
  const exe = path.join(dir, IS_WIN ? `muse-bin-${version}.exe` : `muse-bin-${version}`);
  if (!fs.existsSync(exe)) return null;
  const env = {};
  const info = readTrim(path.join(dir, ".muse-release-info.json"));
  if (info) {
    try {
      if (JSON.parse(info).version === version) env.MUSE_RELEASE_INFO = info;
    } catch { /* optional */ }
  }
  return { bin: exe, version, env };
}

/**
 * Decide what to spawn for `muse serve`. Order: config.museBin, MUSE_BIN,
 * the launcher's active binary, then plain `muse` on PATH.
 */
export function resolveMuse(config) {
  if (config.museBin) return { bin: config.museBin, env: {}, how: "config.museBin", version: null, launcher: null };
  if (process.env.MUSE_BIN) return { bin: process.env.MUSE_BIN, env: {}, how: "MUSE_BIN", version: null, launcher: null };
  const found = findLauncher();
  if (found) {
    const active = activeBinary(found.dir);
    if (active) return { ...active, how: `active binary from ${found.dir}`, launcher: found.launcher };
    if (!IS_WIN) return { bin: found.launcher, env: {}, how: "PATH", version: null, launcher: found.launcher };
  }
  return { bin: IS_WIN ? "muse.exe" : "muse", env: {}, how: "PATH (fallback)", version: null, launcher: found?.launcher || null };
}

/** Run a command, collect output, with a timeout. Never throws. */
function run(cmd, args, { env, timeoutMs, verbatim }) {
  return new Promise((resolve) => {
    let out = "", err = "";
    let child;
    try {
      child = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true, windowsVerbatimArguments: !!verbatim, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: -1, out, err: e.message, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ code: -1, out, err: `${err}\n(timed out)`, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: `${err}${e.message}`, timedOut: false }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, timedOut: false }); });
  });
}

/**
 * Ask Muse's own launcher to update now: `muse --version` with
 * MUSE_SYNC_UPDATE=1 (synchronous update check) and MUSE_LOGIN=0 (never prompt).
 * Returns { state: "updated" | "current" | "failed" | "skipped", from, to, message }.
 */
export async function runUpdate(config) {
  if (config.autoUpdate === false) return { state: "skipped", message: "Auto-update is off (config.autoUpdate=false)." };
  const env = { MUSE_SYNC_UPDATE: "1", MUSE_LOGIN: "0" };
  let cmd, args, verbatim = false, dir = null;
  if (Array.isArray(config.updateCommand) && config.updateCommand.length) {
    [cmd, ...args] = config.updateCommand; // test hook / custom setups
    dir = config.updateStateDir || null;
  } else {
    if (config.museBin || process.env.MUSE_BIN) return { state: "skipped", message: "A custom Muse binary is configured, so the dashboard does not update it." };
    const found = findLauncher();
    if (!found || /\.exe$/i.test(found.launcher)) return { state: "skipped", message: "Muse's launcher (muse.cmd) was not found, so it can't be updated from here." };
    dir = found.dir;
    if (IS_WIN) {
      cmd = process.env.ComSpec || "cmd.exe";
      args = ["/d", "/s", "/c", `""${found.launcher}" --version"`];
      verbatim = true;
    } else {
      cmd = found.launcher;
      args = ["--version"];
    }
  }
  const before = dir ? readTrim(path.join(dir, ".muse-version")) : null;
  const r = await run(cmd, args, { env, timeoutMs: (Number(config.updateTimeoutSec) || 900) * 1000, verbatim });
  const after = dir ? readTrim(path.join(dir, ".muse-version")) : null;
  const notice = /Muse Code updated (\S+) -> (\S+)/.exec(r.err);
  const reported = (r.out.match(/\d+\.\d+\.\d+[^\s]*/) || [])[0] || after;
  if (before && after && before !== after) return { state: "updated", from: before, to: after, message: `Updated Muse ${before} → ${after}.`, version: reported };
  if (r.code !== 0) {
    const tail = `${r.err}`.trim().split(/\r?\n/).slice(-3).join(" ");
    return { state: "failed", message: `Update check failed: ${tail || `exit ${r.code}`}`, version: after || before };
  }
  if (notice && notice[1] !== notice[2]) return { state: "updated", from: notice[1], to: notice[2], message: `Muse was updated ${notice[1]} → ${notice[2]} (since it last reported).`, version: reported };
  return { state: "current", message: "Muse is up to date.", version: reported };
}

/** Best effort: what version does Muse's public release channel advertise? `signal` cancels the request. */
export async function channelVersion(config, signal) {
  const found = findLauncher();
  const channel = process.env.MUSE_CHANNEL || (found && readTrim(path.join(found.dir, ".muse-channel"))) || "muse-stable";
  if (!/^[a-z0-9-]+$/.test(channel)) return null;
  const url = config.channelUrl || `https://api.meta.ai/muse-code/channels/${channel}`;
  const j = await getJson(url, signal);
  return typeof j?.version === "string" ? j.version : null;
}

/**
 * GET a small JSON document on a connection that is closed afterwards. (A
 * pooled keep-alive TLS socket, as fetch leaves behind, makes process.exit
 * crash Node on Windows: "Assertion failed ... src\win\async.c".) Never throws.
 */
function getJson(url, signal) {
  return new Promise((resolve) => {
    let req;
    try {
      req = (url.startsWith("https:") ? https : http).get(url, { agent: false, signal, timeout: 8000, headers: { Accept: "application/json" } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; if (body.length > 65536) req.destroy(); });
        res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
        res.on("error", () => resolve(null));
      });
    } catch {
      return resolve(null);
    }
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}
