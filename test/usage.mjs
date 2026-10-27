// Muse Dashboard · test/usage.mjs
// Author: Adam S. Barnett
//
// Unit checks for rollUsage (lib/muse.js): subscription windows whose reset
// time has passed must not keep showing the percentage Muse last reported.
// Usage: node test/usage.mjs   (npm run test:usage)
import { rollUsage } from "../lib/muse.js";

let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { failN++; console.log("FAIL", m); } };

const now = Date.UTC(2026, 9, 26, 12);
const H = 3600000;
const u = { tier: "power", observedAtMs: now - 2 * H, window: { usedPercent: 64, resetsAtMs: now - H, windowDurationMins: 300 }, weekly: { usedPercent: 40, resetsAtMs: now + 48 * H } };

const r = rollUsage(u, now);
ok(r.window.usedPercent === 0 && r.window.rolledOver === true && r.window.resetsAtMs === null, "5-hour window past its reset shows 0% (reset), not the old 64%");
ok(r.weekly === u.weekly, "weekly window not yet reset keeps its figure");
ok(u.window.usedPercent === 64, "the reported figure itself is not changed");
const both = rollUsage({ ...u, weekly: { usedPercent: 90, resetsAtMs: now - 1000 } }, now);
ok(both.window.usedPercent === 0 && both.weekly.usedPercent === 0 && both.weekly.rolledOver, "weekly reset rolls over too");
const after = { ...u, observedAtMs: now - 1000 };
ok(rollUsage(after, now) === after && after.window.usedPercent === 64, "a figure Muse observed after the reset is kept");
const fresh = { ...u, window: { usedPercent: 10, resetsAtMs: now + H } };
ok(rollUsage(fresh, now) === fresh, "nothing due: the same object comes back (no re-read needed)");
ok(rollUsage(null, now) === null && rollUsage({ window: { usedPercent: 5 } }, now).window.usedPercent === 5, "missing data or reset times are left alone");

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
