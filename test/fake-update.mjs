// Muse Dashboard · test/fake-update.mjs
// Author: Adam S. Barnett
//
// Stands in for `muse --version` during tests: behaves like Muse's launcher
// applying an update (rewrites .muse-version, prints the update notice).
import fs from "node:fs";
import path from "node:path";
const [dir, to] = process.argv.slice(2);
const file = path.join(dir, ".muse-version");
const from = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "0.0.0";
if (process.env.MUSE_SYNC_UPDATE !== "1" || process.env.MUSE_LOGIN !== "0") {
  console.error("expected MUSE_SYNC_UPDATE=1 and MUSE_LOGIN=0");
  process.exit(3);
}
await new Promise((r) => setTimeout(r, 300));
if (from !== to) {
  fs.writeFileSync(file, to);
  console.error(`Muse Code updated ${from} -> ${to}`);
}
console.log(`muse ${to}`);
