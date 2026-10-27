// Muse Dashboard · lib/api-key.js
// Author: Adam S. Barnett
//
// A Meta API key as the second way to run Muse, next to the Muse Code
// subscription sign-in.
//
// Muse reads META_API_KEY from its environment before the account login, so
// the dashboard keeps the key itself and gives it only to the Muse processes
// it starts. Muse's own `muse auth set` is not used: it stores the key as
// plain JSON in the same single slot as the subscription login
// (~/.config/muse/auth.json), so switching back would need a new sign-in.
//
// The key is encrypted by the OS for the current user: Windows DPAPI (the
// ciphertext lives in data/connection.json), the macOS Keychain, or the Linux
// Secret Service (`secret-tool`). It reaches those helpers on stdin, never on a
// command line, and leaves the dashboard only to Muse and to Meta's key check.
import { execFile } from "node:child_process";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./util.js";

/** subscription: Muse's own Meta sign-in · apiKey: the key saved here · env: the META_API_KEY the dashboard was started with. */
export const CONNECTION_MODES = ["subscription", "apiKey", "env"];
export const DEFAULT_META_API_BASE = "https://api.meta.ai/v1";
// Printable ASCII without spaces, quotes or backslashes (it is quoted for the macOS `security -i` shell).
const KEY_RE = /^[!#-&(-[\]-~]{16,1024}$/;
const SERVICE = "muse-dashboard";
const ACCOUNT = "meta-api-key";

export const looksLikeApiKey = (key) => typeof key === "string" && KEY_RE.test(key);

/** The environment for a Muse process: exactly `key` as META_API_KEY, or none (Muse then uses its own Meta sign-in). */
export function withMetaApiKey(env, key) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (k.toUpperCase() === "META_API_KEY") delete out[k];
  if (key) out.META_API_KEY = key;
  return out;
}

function run(cmd, args, input = "") {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { windowsHide: true, timeout: 30000, encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).replace(/#< CLIXML[\s\S]*$/, "").trim().split(/\r?\n/)[0] || `${cmd} failed`));
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

// DPAPI through Windows PowerShell: base64 in on stdin, base64 out. The entropy ties the blob to this use.
const dpapiScript = (op) => [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
  "$entropy = [Text.Encoding]::UTF8.GetBytes('muse-dashboard api key')",
  `$out = [Security.Cryptography.ProtectedData]::${op}($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
  "[Console]::Out.Write([Convert]::ToBase64String($out))",
].join("; ");
const dpapi = async (op, base64) => (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", dpapiScript(op)], base64)).trim();

let secretTool = null;
/** Where this OS keeps the key: "dpapi" | "keychain" | "secret-service", or null when there is no safe place. */
export async function secretStoreKind() {
  if (process.platform === "win32") return "dpapi";
  if (process.platform === "darwin") return "keychain";
  secretTool ??= run("sh", ["-c", "command -v secret-tool"]).then(() => true, () => false);
  return (await secretTool) ? "secret-service" : null;
}

/** Meta's free key check: list the models the key may use (no model call, no cost). */
export async function checkApiKey(key, baseUrl = DEFAULT_META_API_BASE) {
  let r;
  try {
    r = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return { ok: false, reason: "unreachable", message: `Could not reach Meta to check the key (${e.cause?.code || e.message}).` };
  }
  const body = await r.json().catch(() => null);
  if (r.ok) return { ok: true, models: (Array.isArray(body?.data) ? body.data : []).map((m) => m?.id).filter(Boolean) };
  if (r.status === 401 || r.status === 403) return { ok: false, reason: "refused", message: `Meta refused this key (${body?.error?.code || r.status}).` };
  return { ok: false, reason: "unreachable", message: `Meta's key check answered ${r.status}; try again later.` };
}

/** The chosen way to connect and the encrypted key, in data/connection.json (no plaintext ever). */
export class ApiKeyStore {
  #file;
  #state = {};

  constructor(dataDir) {
    this.#file = path.join(dataDir, "connection.json");
  }

  async load() {
    const d = await readJson(this.#file, null);
    this.#state = d && typeof d === "object" ? d : {};
  }

  /** The saved choice, or null when the user never chose (then the server picks a default). */
  get mode() {
    return CONNECTION_MODES.includes(this.#state.mode) ? this.#state.mode : null;
  }

  /** What the page may see: never the key, only its last four characters. */
  get saved() {
    const k = this.#state.key;
    return k ? { last4: k.last4, savedAt: k.savedAt, store: k.store } : null;
  }

  async setMode(mode) {
    this.#state.mode = mode;
    await writeJsonAtomic(this.#file, this.#state);
  }

  async save(key) {
    const store = await secretStoreKind();
    if (!store) throw new Error("this system has no secure key store (install the Secret Service, e.g. gnome-keyring), or set META_API_KEY before starting the dashboard");
    const rec = { store, last4: key.slice(-4), savedAt: new Date().toISOString() };
    if (store === "dpapi") rec.blob = await dpapi("Protect", Buffer.from(key, "utf8").toString("base64"));
    else if (store === "keychain") await run("security", ["-i"], `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w "${key}"\n`);
    else await run("secret-tool", ["store", "--label=Muse Dashboard: Meta API key", "service", SERVICE, "account", ACCOUNT], key);
    this.#state.key = rec;
    await writeJsonAtomic(this.#file, this.#state);
  }

  /** The saved key in plain text (kept only in memory), or null. Throws when the OS cannot decrypt it. */
  async read() {
    const k = this.#state.key;
    if (!k) return null;
    let key;
    if (k.store === "dpapi") key = Buffer.from(await dpapi("Unprotect", k.blob), "base64").toString("utf8");
    else if (k.store === "keychain") key = (await run("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"])).trim();
    else key = (await run("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT])).trim();
    if (!looksLikeApiKey(key)) throw new Error("the stored key is missing or damaged");
    return key;
  }

  async remove() {
    const k = this.#state.key;
    if (k?.store === "keychain") await run("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]).catch(() => undefined);
    if (k?.store === "secret-service") await run("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT]).catch(() => undefined);
    delete this.#state.key;
    if (this.#state.mode === "apiKey") this.#state.mode = "subscription";
    await writeJsonAtomic(this.#file, this.#state);
  }
}
