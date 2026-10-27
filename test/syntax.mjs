// Muse Dashboard · test/syntax.mjs
// Author: Adam S. Barnett
//
// Syntax check (node --check) of every JavaScript file in the project, found
// by walking the folders, so a new file can never be left out by accident.
// Usage: node test/syntax.mjs   (npm run check)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "data", "Projects", ".git"]);
const files = [];
(function walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(d.name) || d.name.startsWith(".tmp")) continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p);
    else if (/\.m?js$/.test(d.name)) files.push(p);
  }
})(APP);
let failN = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (e) {
    failN += 1;
    console.log("FAIL", path.relative(APP, f), String(e.stderr || e.message).trim().split("\n").slice(0, 6).join("\n"));
  }
}
console.log(`\n${files.length - failN} files passed, ${failN} failed`);
process.exit(failN || !files.length ? 1 : 0);
