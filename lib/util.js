// Muse Dashboard · lib/util.js
// Author: Adam S. Barnett
//
// Small shared helpers: atomic JSON files, folder and file-name checks, HTTP
// errors and opening the browser.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fsp.rename(tmp, file);
}

/** Resolve a user-supplied folder to a canonical absolute existing directory, or throw. */
export async function canonicalDir(input) {
  if (typeof input !== "string" || input.trim() === "") throw httpError(400, "A folder path is required.");
  const raw = input.trim().replace(/^"(.*)"$/, "$1");
  if (!path.isAbsolute(raw)) throw httpError(400, `Not an absolute path: ${raw}`);
  let real;
  try {
    real = await fsp.realpath(raw);
  } catch {
    throw httpError(400, `Folder does not exist: ${raw}`);
  }
  const st = await fsp.stat(real);
  if (!st.isDirectory()) throw httpError(400, `Not a folder: ${raw}`);
  return real;
}

export function samePath(a, b) {
  if (!a || !b) return false;
  const na = path.resolve(a), nb = path.resolve(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Make an uploaded file name safe to write inside the uploads folder. */
export function safeFileName(name) {
  let base = path.basename(String(name || "file")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  base = base.replace(/\s+/g, "_").replace(/^\.+/, "_"); // no spaces: names are used in @mentions
  if (base === "" ) base = "file";
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(base)) base = `_${base}`;
  return base.slice(0, 120);
}

export async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 2; fs.existsSync(candidate); i += 1) candidate = path.join(dir, `${stem}-${i}${ext}`);
  return candidate;
}

export function openBrowser(url) {
  let cmd, args;
  if (process.platform === "win32") {
    cmd = "rundll32.exe";
    args = ["url.dll,FileProtocolHandler", url];
  } else if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => console.log(`Could not open a browser automatically. Open this URL: ${url}`));
    child.unref();
  } catch {
    console.log(`Could not open a browser automatically. Open this URL: ${url}`);
  }
}
