// Muse Dashboard · lib/connect.js
// Author: Adam S. Barnett
//
// Is Muse Code installed, and signed in to a Meta account (or given an API
// key)? `muse serve` starts without a sign-in and only fails each reply
// ("authRequired"), so the dashboard asks `muse usage --json` instead: it needs
// no model call and says "not logged in" plainly. When the account is not
// connected, the page offers Meta's own `muse login` (approve a code in the
// browser), which on Windows opens in a console window of its own, just as it
// would in a terminal, or an API key (lib/api-key.js).
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveMuse } from "./install.js";
import { withMetaApiKey } from "./api-key.js";

/** Meta's official installers (they put `muse` on PATH, where the dashboard finds it). */
export const INSTALL_COMMAND = process.platform === "win32"
  ? "irm https://dev.meta.ai/install.ps1 | iex"
  : "curl -fsSL https://dev.meta.ai/install.sh | bash";

/** Where Muse keeps its Meta sign-in (the same rule as Muse's launcher). */
export function authFile(env = process.env) {
  if (env.MUSE_AUTH_PATH) return env.MUSE_AUTH_PATH;
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "muse", "auth.json");
}

/**
 * Ask Muse whether it can run replies, with the same API key the Muse host
 * gets (`metaApiKey`, or null for the subscription sign-in). Never throws.
 * Returns { state, message?, tier?, bin, checkedAt } where state is:
 *   connected     installed and signed in (tier = the subscription's name), or
 *                 given an API key (Muse cannot check a key; Settings checks it with Meta)
 *   signedOut     installed, but no Meta sign-in (or it expired)
 *   notInstalled  no Muse binary could be started
 *   unknown       some other answer (offline, or a Muse without `usage`); not shown as a problem
 */
export async function checkConnection(config, { metaApiKey = null, timeoutMs = 20000 } = {}) {
  const { bin, env } = resolveMuse(config);
  const r = await run(bin, [...(config.museArgs || []), "usage", "--json"], { env: withMetaApiKey({ ...process.env, ...env, MUSE_LOGIN: "0" }, metaApiKey), timeoutMs });
  const base = { bin, checkedAt: new Date().toISOString() };
  if (r.notFound) return { ...base, state: "notInstalled", message: `Muse Code was not found (${bin}).` };
  if (r.code === 0) {
    let tier = null;
    try { tier = JSON.parse(r.out).allowance?.tier || null; } catch { /* not JSON: still signed in */ }
    return { ...base, state: "connected", tier };
  }
  const text = `${r.err}\n${r.out}`.trim();
  if (/not logged in|muse login|authRequired/i.test(text)) return { ...base, state: "signedOut", message: "Muse Code is not signed in to a Meta account." };
  const detail = r.timedOut ? "Muse did not answer the sign-in check in time." : text.split(/\r?\n/).slice(-2).join(" ") || `exit code ${r.code}`;
  return { ...base, state: "unknown", message: detail };
}

/**
 * Start Meta's sign-in (`muse login`). On Windows it opens in its own console
 * window, which shows the code and closes once the sign-in is approved; other
 * systems get the command to run in a terminal. Returns { started: true } or
 * { manual: "muse login" }. `config.loginCommand` (an argv array) replaces it
 * in tests.
 */
export async function startSignIn(config, dataDir) {
  const { bin, env } = resolveMuse(config);
  const childEnv = { ...process.env, ...env };
  if (Array.isArray(config.loginCommand) && config.loginCommand.length) {
    const [cmd, ...args] = config.loginCommand;
    await new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { env: childEnv, stdio: "ignore", windowsHide: true });
      child.on("error", reject);
      child.on("exit", resolve);
    });
    return { started: true };
  }
  if (process.platform !== "win32") return { manual: "muse login" };
  // The command reaches the script through an environment variable, so paths
  // with spaces or non-ASCII characters survive cmd's code page.
  childEnv.MUSE_DASHBOARD_SIGN_IN = [bin, ...(config.museArgs || []), "login"].map((a) => `"${a}"`).join(" ");
  const script = path.join(dataDir, "muse-sign-in.cmd");
  await fsp.writeFile(script, [
    "@echo off",
    "title Muse Code sign-in",
    "echo Signing in to Muse Code with your Meta account.",
    "echo Approve the code in your browser. This window closes by itself when you are done.",
    "echo.",
    "%MUSE_DASHBOARD_SIGN_IN%",
    "if errorlevel 1 (",
    "  echo.",
    "  echo Sign-in did not finish. Close this window and try again from the dashboard.",
    "  pause",
    ")",
    "",
  ].join("\r\n"), "utf8");
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", `start "Muse Code sign-in" "${script}"`], { windowsVerbatimArguments: true, windowsHide: true, stdio: "ignore", env: childEnv });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  return { started: true };
}

/** Run a command (with exactly `env`) and collect its output, with a timeout. Never throws. */
function run(cmd, args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    let out = "", err = "", done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve({ out, err, ...r }); } };
    let child;
    try {
      child = spawn(cmd, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ out, err: e.message, code: -1, notFound: e.code === "ENOENT" });
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ code: -1, timedOut: true }); }, timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => { err += e.message; finish({ code: -1, notFound: e.code === "ENOENT" }); });
    child.on("close", (code) => finish({ code }));
  });
}
