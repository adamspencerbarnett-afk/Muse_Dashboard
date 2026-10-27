// Muse Dashboard · test/skills.mjs
// Author: Adam S. Barnett
//
// scripts/install-skills.mjs installs every bundled skill (each folder in
// skills/ with a SKILL.md) through `muse skills install <dir> --scope user
// --force`, here against mock/mock-muse.mjs so nothing is installed for real.
// Usage: node test/skills.mjs   (npm run test:skills)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { failN++; console.log("FAIL", m); } };

const T = fs.mkdtempSync(path.join(os.tmpdir(), "mdskills-"));
const cfg = path.join(T, "config.json");
const log = path.join(T, "installs.log");
fs.writeFileSync(cfg, JSON.stringify({ museBin: process.execPath, museArgs: [path.join(APP, "mock", "mock-muse.mjs")] }));
const bundled = fs.readdirSync(path.join(APP, "skills")).filter((n) => fs.existsSync(path.join(APP, "skills", n, "SKILL.md")));
const r = spawnSync(process.execPath, [path.join(APP, "scripts", "install-skills.mjs"), "--config", cfg], { encoding: "utf8", env: { ...process.env, MOCK_MUSE_SKILLS_LOG: log } });
ok(r.status === 0, `install-skills exits 0 (got ${r.status}) ${r.stderr || ""}`);
const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
ok(bundled.length > 0 && calls.length === bundled.length, `every bundled skill is installed once (${bundled.join(", ")})`);
ok(calls.every((c) => c[0] === "install" && c.includes("--scope") && c[c.indexOf("--scope") + 1] === "user" && c.includes("--force")), "each install uses --scope user --force");
ok(calls.every((c) => fs.existsSync(path.join(c[1], "SKILL.md"))), "each install points at a folder with a SKILL.md");
for (const n of bundled) {
  const text = fs.readFileSync(path.join(APP, "skills", n, "SKILL.md"), "utf8");
  ok(/^---\nname: [a-z0-9-]+\ndescription: .+\n---\n/.test(text.replace(/\r\n/g, "\n")), `skills/${n}/SKILL.md starts with name + description front matter`);
}
fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
