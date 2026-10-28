// Muse Dashboard · test/theme.mjs
// Author: Adam S. Barnett
//
// Focused check of the Dark | Light theme (Settings → Appearance), on the files alone:
// every color in style.css is a variable set in the dark :root block and again in the light block,
// so a new rule cannot show a dark-only color in the light theme (or the reverse).
// The page markup carries the hooks the server rewrites when it stamps the saved theme on the page.
// Usage: node test/theme.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { failN++; console.log("FAIL", m); } };

const css = fs.readFileSync(path.join(APP, "public", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const html = fs.readFileSync(path.join(APP, "public", "index.html"), "utf8");
const server = fs.readFileSync(path.join(APP, "server.js"), "utf8");

const block = (sel) => { const i = css.indexOf(`${sel} {`); return i < 0 ? null : css.slice(i, css.indexOf("}", i) + 1); };
const dark = block(":root"), light = block(':root[data-theme="light"]');
ok(!!dark && !!light, "style.css has a dark :root block and a light :root[data-theme=\"light\"] block");
const vars = (b) => new Map([...(b || "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const dv = vars(dark), lv = vars(light);
const SHARED = new Set(["--radius", "--mono", "--sans", "--col-pad"]); // not colors: the same in both themes
const missing = [...dv.keys()].filter((k) => !SHARED.has(k) && !lv.has(k));
ok(missing.length === 0, missing.length ? `light theme does not set: ${missing.join(", ")}` : `the light theme sets all ${dv.size - SHARED.size} theme variables`);

const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const rest = css.replace(dark, "").replace(light, "");
const stray = [];
for (const m of rest.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  for (const d of m[2].split(";")) { const v = d.slice(d.indexOf(":") + 1); if (d.includes(":") && LITERAL.test(v)) stray.push(`${m[1].trim()} { ${d.trim()} }`); }
}
ok(stray.length === 0, stray.length ? `colors typed outside the theme blocks:\n  ${stray.join("\n  ")}` : "no color is typed outside the two theme blocks");

const defined = new Set([...dv.keys(), ...lv.keys()]);
const undef = [...new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]))].filter((k) => !defined.has(k));
ok(undef.length === 0, undef.length ? `var() of undefined variables: ${undef.join(", ")}` : "every var() used is defined");

ok(/<html lang="en" data-theme="dark">/.test(html), 'index.html starts dark: <html data-theme="dark"> (the server swaps it for the saved theme)');
ok(/<link id="hljsTheme" rel="stylesheet" href="\/vendor\/hljs\.css">/.test(html), "index.html has the code-highlight stylesheet the theme switch swaps (#hljsTheme)");
ok(server.includes(`'data-theme="dark"'`) && server.includes(`'href="/vendor/hljs.css"'`), "server.js rewrites exactly those two strings");
const lightCss = /"\/vendor\/hljs-light\.css":\s*path\.join\(([^)]*)\)/.exec(server);
const lightPath = lightCss && path.join(APP, ...lightCss[1].split(",").slice(1).map((s) => s.trim().replace(/"/g, "")));
ok(!!lightPath && fs.existsSync(lightPath), "the light code-highlight stylesheet is served and installed: " + lightPath);
ok((html.match(/data-theme-pick="(dark|light)"/g) || []).length === 2, "Settings → Appearance offers Dark and Light");

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
