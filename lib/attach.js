// Muse Dashboard · lib/attach.js
// Author: Adam S. Barnett
//
// Attachment helpers. Uploaded files are saved in the chat's folder
// (<chat folder>/attachments, or <project>/.muse-uploads/<chat-id>) and given to
// Muse as @relative/path mentions; images also go to the model as pictures. An
// identical file uploaded twice in the same chat is stored only once.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const IMAGE_EXT = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export async function describePath(p) {
  const st = await fsp.stat(p);
  return { path: p, name: path.basename(p), isDir: st.isDirectory(), size: st.isDirectory() ? undefined : st.size };
}

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(p).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

/**
 * An existing file in `dir` with the same name (or the same name plus a -N
 * suffix from an earlier clash) and identical content, or null.
 */
export async function findDuplicate(dir, name, size, hash) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc(stem)}(-\\d+)?${esc(ext)}$`, process.platform === "win32" ? "i" : "");
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return null; }
  for (const n of names) {
    if (!re.test(n)) continue;
    const p = path.join(dir, n);
    try {
      const st = await fsp.stat(p);
      if (!st.isFile() || st.size !== size) continue;
      if ((await hashFile(p)) === hash) return p;
    } catch { /* skip */ }
  }
  return null;
}
