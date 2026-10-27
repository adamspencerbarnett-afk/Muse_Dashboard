// Muse Dashboard · lib/recycle.js
// Author: Adam S. Barnett
//
// Delete sends a chat's Projects folder to the Recycle Bin, never further.
//
// The dashboard deletes only folders inside its own Projects folder (folders
// opened from elsewhere are the user's to delete), and those go to the Recycle
// Bin so they can be restored. Windows quietly deletes for good anything that
// does not fit in a drive's Recycle Bin, or that is on a drive without one, so
// recycleCheck() compares the folder with the bin's size limit beforehand and
// moveToRecycleBin() looks the folder up in the bin afterwards.
//
// `test` ({ dir, maxBytes, permanent }) replaces the real bin in tests: folders
// are moved into `dir`, `maxBytes` is the bin's limit, and `permanent` makes
// the "bin" delete for good, like Windows does with a folder that does not fit.
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const BIN_NAME = process.platform === "darwin" || process.platform === "linux" ? "Trash" : "Recycle Bin";
// Windows tools by full path: a Git Bash PATH puts GNU `whoami` first.
const sys32 = (exe) => path.join(process.env.SystemRoot || "C:\\Windows", "System32", exe);

function run(cmd, args, { env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { windowsHide: true, timeout: 10 * 60000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).replace(/#< CLIXML[\s\S]*$/, "").trim().split(/\r?\n/)[0] || `${cmd} failed`));
      resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Files and bytes in a folder (links are counted, never followed). */
async function folderSize(dir) {
  let files = 0, bytes = 0;
  const walk = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else { files++; bytes += (await fsp.lstat(p).catch(() => ({ size: 0 }))).size; }
    }
  };
  await walk(dir);
  return { files, bytes };
}

/** The Recycle Bin limit of the folder's drive (Windows): { maxBytes, nuke }, { none: true } for a drive without one, or null when unknown. */
async function binLimit(dir) {
  const root = path.parse(path.resolve(dir)).root;
  if (root.startsWith("\\\\")) return { none: true }; // network share
  let volume;
  try { volume = (await run(sys32("mountvol.exe"), [root, "/L"])).match(/\{[0-9a-f-]+\}/i)?.[0]; } catch { return { none: true }; }
  if (!volume) return null;
  try {
    const out = await run(sys32("reg.exe"), ["query", `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume\\${volume}`]);
    const dword = (name) => { const m = out.match(new RegExp(`${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, "i")); return m ? parseInt(m[1], 16) : null; };
    const mb = dword("MaxCapacity");
    return { maxBytes: mb === null ? null : mb * 1024 * 1024, nuke: dword("NukeOnDelete") === 1 };
  } catch {
    return null; // never configured: Windows' default size, not readable here
  }
}

/**
 * Can this folder go to the Recycle Bin? { files, bytes, binName, bin, binMaxBytes } where bin is
 * "fits", "tooLarge" (bigger than the bin's limit), "noBin" (a drive without one, or set to delete at once)
 * or "unknown" (Windows did not say; moveToRecycleBin still reports what happened).
 */
export async function recycleCheck(dir, { test } = {}) {
  const size = await folderSize(dir);
  let limit = null;
  if (test) limit = { maxBytes: test.maxBytes ?? null };
  else if (process.platform === "win32") limit = await binLimit(dir);
  else limit = { maxBytes: null }; // the macOS / Linux trash has no size limit
  let bin = "fits";
  if (!limit) bin = "unknown";
  else if (limit.none || limit.nuke) bin = "noBin";
  else if (limit.maxBytes !== null && size.bytes > limit.maxBytes) bin = "tooLarge";
  return { ...size, binName: test ? "Recycle Bin" : BIN_NAME, bin, binMaxBytes: limit?.maxBytes ?? null };
}

// SHFileOperation with every dialog off (no "file in use" prompt from a background process). The
// path arrives in an environment variable, never spliced into the script.
const SH_DELETE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MuseRecycle {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct SHFILEOPSTRUCT { public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags; [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHFileOperation(ref SHFILEOPSTRUCT op);
  public static int Recycle(string path) {
    // FO_DELETE with FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT
    SHFILEOPSTRUCT op = new SHFILEOPSTRUCT { wFunc = 3, pFrom = path + "\0\0", fFlags = 0x40 | 0x10 | 0x400 | 0x4 };
    int r = SHFileOperation(ref op);
    return r != 0 ? r : (op.fAnyOperationsAborted ? -1 : 0);
  }
}
'@
[Console]::Out.Write([MuseRecycle]::Recycle($env:MUSE_RECYCLE_PATH))
`;

let sid = null;
/**
 * Windows: where `dir`, deleted at or after `since`, is kept in its drive's Recycle Bin, or null. Each item
 * is a $R… copy with a $I… index file naming the original path; reading those is fast, unlike the shell.
 */
async function inWindowsBin(dir, since) {
  sid ??= run(sys32("whoami.exe"), ["/user", "/fo", "csv", "/nh"]).then((o) => o.trim().split(",").pop().replace(/"/g, ""), () => "");
  const binDir = path.join(path.parse(dir).root, "$Recycle.Bin", await sid);
  const want = path.resolve(dir).toLowerCase();
  for (const name of await fsp.readdir(binDir).catch(() => [])) {
    if (!name.startsWith("$I")) continue;
    const p = path.join(binDir, name);
    try {
      if ((await fsp.stat(p)).mtimeMs < since - 2000) continue;
      const b = await fsp.readFile(p);
      // Version 2 (Windows 10+): path length at 24, path from 28. Version 1: a 520-byte path at 24.
      const original = b.readBigInt64LE(0) === 2n ? b.toString("utf16le", 28, 28 + (b.readInt32LE(24) - 1) * 2) : b.toString("utf16le", 24, 24 + 520).replace(/\0[\s\S]*$/, "");
      const copy = path.join(binDir, `$R${name.slice(2)}`);
      if (original.toLowerCase() === want && fs.existsSync(copy)) return copy;
    } catch { /* another program's entry, mid-write */ }
  }
  return null;
}

/**
 * Move a folder to the Recycle Bin (macOS / Linux: the Trash). Resolves to { inBin, binPath? }: inBin is
 * false when the folder is gone but not in the bin (Windows deleted it for good); binPath is its copy in the
 * Windows bin. Throws when the folder is still there.
 */
export async function moveToRecycleBin(dir, { test } = {}) {
  const target = path.resolve(dir);
  const since = Date.now();
  if (test) {
    if (test.permanent) await fsp.rm(target, { recursive: true, force: true });
    else await fsp.rename(target, path.join(test.dir, `${path.basename(target)}-${since}`));
  } else if (process.platform === "win32") {
    const code = (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SH_DELETE], { env: { MUSE_RECYCLE_PATH: target } })).trim();
    if (code !== "0" && fs.existsSync(target)) throw new Error(`Windows could not move it to the Recycle Bin (code ${code}); a file in it may be open in another program`);
  } else if (process.platform === "darwin") {
    await run("osascript", ["-e", "on run argv", "-e", 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', "-e", "end run", target]);
  } else {
    await run("gio", ["trash", "--", target]);
  }
  if (fs.existsSync(target)) throw new Error(`some files could not be moved to the ${BIN_NAME} (one may be open in another program); the rest are already there`);
  if (test) return { inBin: !test.permanent };
  if (process.platform !== "win32") return { inBin: true };
  const binPath = await inWindowsBin(target, since);
  return binPath ? { inBin: true, binPath } : { inBin: false };
}
