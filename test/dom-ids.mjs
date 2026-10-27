// Muse Dashboard · test/dom-ids.mjs
// Author: Adam S. Barnett
//
// Focused check: every $("id") the front end looks up must exist — either as
// id="..." in public/index.html or as a `.id = "..."` the script assigns
// itself. A lookup that finds nothing returns null, and wire() runs outside
// any try/catch, so one stale id kills the whole page boot (dead sidebar,
// no chats, nothing wired after the throw).
// Usage: node test/dom-ids.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { failN++; console.log("FAIL", m); } };

const js = fs.readFileSync(path.join(APP, "public", "app.js"), "utf8");
const html = fs.readFileSync(path.join(APP, "public", "index.html"), "utf8");
const used = [...new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
const htmlIds = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const htmlSet = new Set(htmlIds);
const jsSet = new Set([...js.matchAll(/\.id\s*=\s*"([^"]+)"/g)].map((m) => m[1]));

const missing = used.filter((id) => !htmlSet.has(id) && !jsSet.has(id));
ok(used.length > 0, `found ${used.length} ids the front end looks up`);
for (const id of missing) ok(false, `$("${id}") has no element in index.html and is never assigned in app.js`);
if (!missing.length) ok(true, "every looked-up id exists in the page or is created by the script");
const dupes = [...new Set(htmlIds.filter((id, i) => htmlIds.indexOf(id) !== i))];
ok(dupes.length === 0, dupes.length ? `duplicate ids in index.html: ${dupes.join(", ")}` : "no duplicate ids in index.html");

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
