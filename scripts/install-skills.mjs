// Muse Dashboard · scripts/install-skills.mjs
// Author: Adam S. Barnett
//
// Installs every skill in skills/ into Muse Code for this user, with Muse's
// own `muse skills install <folder> --scope user --force` (Muse keeps its own
// copy, so run this again after editing a skill). It uses the same Muse as
// the dashboard (config.json museBin, else the installed launcher).
// Usage: npm run install-skills          (or: node scripts/install-skills.mjs --config <file>)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMuse } from "../lib/install.js";
import { readJson } from "../lib/util.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const at = process.argv.indexOf("--config");
const config = await readJson(at > 0 ? path.resolve(process.argv[at + 1]) : path.join(APP, "config.json"), {});
const { bin, env } = resolveMuse(config);
const SKILLS = path.join(APP, "skills");
const names = fs.readdirSync(SKILLS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(SKILLS, d.name, "SKILL.md")))
  .map((d) => d.name);
if (!names.length) {
  console.log("No skills found in skills/.");
  process.exit(0);
}
let failed = 0;
for (const name of names) {
  const r = spawnSync(bin, [...(config.museArgs || []), "skills", "install", path.join(SKILLS, name), "--scope", "user", "--force"], {
    env: { ...process.env, ...env, MUSE_LOGIN: "0" }, stdio: "inherit", windowsHide: true,
  });
  if (r.error) {
    console.error(`Could not run Muse Code (${bin}): ${r.error.message}\nInstall Muse Code first (see README, "Install Muse Code").`);
    process.exit(1);
  }
  if (r.status === 0) console.log(`Installed skill: ${name}`);
  else { failed += 1; console.error(`Installing ${name} failed (exit code ${r.status}).`); }
}
console.log(failed ? `${failed} of ${names.length} skill(s) failed.` : `Done: ${names.length} skill(s) installed. Restart the dashboard (Settings > Restart) so Muse loads them.`);
process.exit(failed ? 1 : 0);
