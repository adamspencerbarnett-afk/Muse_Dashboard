// Muse Dashboard · test/spend.mjs
// Author: Adam S. Barnett
//
// Unit checks for lib/spend.js: the per-folder token record, the price table and the dollar estimate.
// Usage: node test/spend.mjs   (npm run test:spend)
import path from "node:path";
import { folderKey, emptySpend, addTokens, normalizePrices, estimate, fmtUsd, catalogPrices, mergePrices, sumEntries } from "../lib/spend.js";

let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { failN++; console.log("FAIL", m); } };

const a = path.resolve("Projects/Snake"), b = path.resolve("Projects/snake/../SNAKE");
ok(folderKey(a) === folderKey(b) === (process.platform === "win32"), "one key per folder regardless of spelling on Windows");

let e = addTokens(emptySpend(a), "api", "muse-spark-1.3", [100, 900, 20]);
ok(e.api["muse-spark-1.3"].join() === "100,900,20" && !!e.updatedAt, "a step adds fresh, cached and output tokens under its model and connection");
const e2 = addTokens(e, "api", "muse-spark-1.3", [50, 0, 5]);
ok(e2.api["muse-spark-1.3"].join() === "150,900,25" && e.api["muse-spark-1.3"][0] === 100, "steps accumulate; the previous record is not mutated");
ok(addTokens(e2, "sub", "muse-wonder-1.0", [10, 0, 1]).sub["muse-wonder-1.0"].join() === "10,0,1", "subscription use is kept apart");
ok(addTokens(e2, "api", "x", [0, 0, 0]) === e2 && addTokens(e2, "nope", "x", [1, 1, 1]) === e2 && addTokens(e2, "api", "", [1, 1, 1]) === e2, "nothing to add, an unknown connection or no model: unchanged");
ok(addTokens(e2, "api", "x", [-5, "7.6", null]).api.x.join() === "0,8,0", "tokens are clamped to whole non-negative numbers");

// prices
const p = normalizePrices({ enabled: true, touch: true, models: { "muse-spark-1.3": { input: "1.25", cached: 0.15, output: 5 }, "muse-wonder-1.0": { input: "", cached: "", output: "" }, "  ": { input: 1 } } });
ok(p.enabled && !!p.updatedAt && Object.keys(p.models).join() === "muse-spark-1.3" && p.models["muse-spark-1.3"].input === 1.25, "the price table keeps numbers, drops empty rows and blank ids, and stamps the save");
ok(normalizePrices({ updatedAt: "2026-10-27T10:00:00.000Z", models: {} }).updatedAt === "2026-10-27T10:00:00.000Z" && normalizePrices(null).enabled === true && normalizePrices({ enabled: false }).enabled === false, "a reload keeps the stamp; estimates are on unless switched off");
let threw = null; try { normalizePrices({ models: { m: { input: "abc" } } }); } catch (x) { threw = x.message; }
ok(/m: input price/.test(threw || ""), "a bad number is refused with the model and field named");
threw = null; try { normalizePrices({ models: { m: { output: -1 } } }); } catch (x) { threw = x.message; }
ok(!!threw, "a negative price is refused");

// estimate: only API-key use is money
const spend = addTokens(addTokens(addTokens(emptySpend(a), "api", "muse-spark-1.3", [1000000, 2000000, 100000]), "api", "muse-wonder-1.0", [500000, 0, 10000]), "sub", "muse-spark-1.3", [9000000, 0, 0]);
let est = estimate(spend, p);
ok(Math.abs(est.usd - (1.25 + 0.3 + 0.5)) < 1e-9 && est.partial && est.missing.join() === "muse-wonder-1.0", "dollars = fresh × input + cached × cached + output × output per 1M, per priced model; an unpriced model with tokens makes it partial");
ok(est.tokens.api.join() === "1500000,2000000,110000" && est.tokens.sub.join() === "9000000,0,0", "token totals are reported for both connections");
ok(est.models["muse-spark-1.3"].usd > 2 && est.models["muse-wonder-1.0"].usd === 0, "per-model breakdown");
est = estimate(spend, normalizePrices({ enabled: true, models: { "muse-spark-1.3": { input: 1.25, cached: 0.15, output: 5 }, "muse-wonder-1.0": { input: 2 } } }));
ok(est.missing.join() === "muse-wonder-1.0" && Math.abs(est.usd - (2.05 + 1)) < 1e-9, "a partly priced model is priced for what it has and still listed as missing");
est = estimate(addTokens(emptySpend(a), "api", "muse-wonder-1.0", [0, 0, 0]), p);
ok(est.usd === 0 && !est.partial, "no tokens, nothing missing");
ok(estimate(null, p).usd === 0 && estimate(spend, null).partial, "no record or no prices: zero, and all models missing");

// Meta's catalog prices (Muse model/list cost blocks, decimal strings) and the user's overrides
const cat = catalogPrices([{ modelId: "muse-spark-1.3", cost: { input: "1.25", output: "4.25", cached: "0.15", currency: "USD" } }, { modelId: "muse-wonder-full-1.0", cost: null }, { modelId: "x", cost: { input: "abc" } }, { cost: { input: "1" } }]);
ok(Object.keys(cat).join() === "muse-spark-1.3" && cat["muse-spark-1.3"].output === 4.25 && cat["muse-spark-1.3"].cached === 0.15, "catalog prices: numbers from the cost blocks; null blocks, bad numbers and nameless rows are left out");
const merged = mergePrices({ "muse-spark-1.3": { input: 2 }, "muse-wonder-1.0": { output: 20 } }, cat);
ok(merged.models["muse-spark-1.3"].input === 2 && merged.models["muse-spark-1.3"].output === 4.25 && merged.models["muse-wonder-1.0"].output === 20, "merge: a typed price overrides the catalog field by field; models only the user priced are kept");
ok(Math.abs(estimate(spend, merged).models["muse-spark-1.3"].usd - (2 + 0.3 + 0.425)) < 1e-9, "estimates use the merged table");

// all project folders together → the sidebar Total
const rec = (f, c, o) => addTokens(emptySpend(""), "api", "muse-spark-1.3", [f, c, o]);
const all = sumEntries([addTokens(rec(1000000, 0, 0), "sub", "muse-spark-1.3", [5, 0, 0]), rec(0, 1000000, 0), rec(0, 0, 1000000), null]);
const tot = estimate(all, p);
ok(all.api["muse-spark-1.3"].join() === "1000000,1000000,1000000" && Math.abs(tot.usd - 6.40) < 1e-9 && tot.tokens.sub[0] === 5, "folders are summed per model and connection, then priced");
ok(sumEntries([]).api && Object.keys(sumEntries([]).api).length === 0 && estimate(sumEntries([]), p).usd === 0, "no folders: zero");

ok(fmtUsd(3.4167) === "$3.42" && fmtUsd(12.34) === "$12.3" && fmtUsd(120.6) === "$121" && fmtUsd(0.004) === "<$0.01" && fmtUsd(0) === "$0.00", "dollar formatting");

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
