// Muse Dashboard · test/snapshot.mjs
// Author: Adam S. Barnett
//
// Focused check of lib/snapshot.js against real Git: save / undo in a plain
// folder (git init + excludes), in an existing repository (branch, index and
// HEAD untouched; exact bytes despite autocrlf and .gitattributes), in a
// subfolder of a repository (nothing outside it touched), and the size limit.
// Usage: node test/snapshot.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitAvailable, folderGit, saveSnapshot, restoreSnapshot } from "../lib/snapshot.js";

let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { failN++; console.log("FAIL", m); } };
if (!(await gitAvailable())) { console.log("SKIP git is not installed"); process.exit(0); }
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mdsnap-")));
const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const same = (p, data) => fs.existsSync(p) && Buffer.compare(fs.readFileSync(p), Buffer.from(data)) === 0;

// ---- plain folder ----
const A = path.join(T, "plain");
const files = { "crlf.txt": "one\r\ntwo\r\n", "lf.txt": "one\ntwo\n", "bin.dat": Buffer.from([0, 255, 13, 10, 1]), "src/deep/x.js": "x()", "naïve ü.md": "unicode" };
for (const [n, d] of Object.entries(files)) write(path.join(A, n), d);
write(path.join(A, "node_modules", "dep", "index.js"), "dep v1");
let info = await folderGit(A);
ok(info.available && !info.repo, "a plain folder is reported as not a Git repository");
const s1 = await saveSnapshot(A);
ok(s1.createdRepo && fs.existsSync(path.join(A, ".git")) && s1.files === 5, `snapshot of a plain folder: git init + ${s1.files} files (node_modules left out)`);
ok(fs.readdirSync(A).sort().join() === [".git", "bin.dat", "crlf.txt", "lf.txt", "naïve ü.md", "node_modules", "src"].sort().join(), "no file is added to the folder itself (excludes live in .git/info/exclude)");
ok(g(A, "for-each-ref", "--format=%(refname)").startsWith("refs/muse-dashboard/snapshots/") && !g(A, "branch"), "the snapshot is a dashboard ref; no branch commit is made");
// Muse's "work": change, delete, add (also in a new nested folder), and touch an excluded folder.
write(path.join(A, "crlf.txt"), "changed\n");
fs.rmSync(path.join(A, "lf.txt"));
fs.rmSync(path.join(A, "src", "deep"), { recursive: true });
write(path.join(A, "new.txt"), "new");
write(path.join(A, "made", "by", "muse.js"), "muse()");
write(path.join(A, "node_modules", "dep", "index.js"), "dep v2");
const u1 = await restoreSnapshot(s1);
ok(Object.entries(files).every(([n, d]) => same(path.join(A, n), d)), "undo restores changed and deleted files byte for byte (CRLF, LF, binary, unicode name)");
ok(!fs.existsSync(path.join(A, "new.txt")) && !fs.existsSync(path.join(A, "made")), "undo deletes files added since, and folders it leaves empty");
ok(same(path.join(A, "node_modules", "dep", "index.js"), "dep v2"), "undo does not touch excluded folders (node_modules)");
ok(u1.restored === 3 && u1.removed === 2 && g(A, "rev-parse", "-q", "--verify", u1.beforeRef).length === 40, `undo counts (${u1.restored} restored, ${u1.removed} removed) and keeps a before-undo ref`);

// ---- existing repository with autocrlf, .gitattributes and uncommitted work ----
const B = path.join(T, "repo");
write(path.join(B, ".gitattributes"), "* text=auto\n");
write(path.join(B, "a.txt"), "committed\n");
g(B, "init", "-q", "-b", "main");
g(B, "config", "core.autocrlf", "true");
g(B, "add", "-A");
g(B, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
write(path.join(B, "a.txt"), "uncommitted\r\nwork\r\n");
write(path.join(B, "staged.txt"), "staged\n");
g(B, "add", "staged.txt");
write(path.join(B, "untracked.txt"), "untracked\r\n");
const head = g(B, "rev-parse", "HEAD");
const staged = g(B, "diff", "--cached", "--name-only");
info = await folderGit(B);
ok(info.repo && info.changes === 3, `an existing repository with uncommitted work is reported (${info.changes} changes)`);
const s2 = await saveSnapshot(B);
ok(!s2.createdRepo && g(B, "rev-parse", "HEAD") === head && g(B, "diff", "--cached", "--name-only") === staged && g(B, "log", "--oneline").split("\n").length === 1, "snapshot leaves HEAD, the branch history and the staged files as they were");
write(path.join(B, "a.txt"), "muse rewrote it\n");
fs.rmSync(path.join(B, "untracked.txt"));
write(path.join(B, "extra.txt"), "extra");
await restoreSnapshot(s2);
ok(same(path.join(B, "a.txt"), "uncommitted\r\nwork\r\n") && same(path.join(B, "untracked.txt"), "untracked\r\n") && !fs.existsSync(path.join(B, "extra.txt")), "undo in a repository restores the uncommitted work exactly (no line-ending conversion)");
ok(g(B, "rev-parse", "HEAD") === head && g(B, "diff", "--cached", "--name-only") === staged, "undo leaves HEAD and the index alone");

// ---- subfolder of a repository ----
const C = path.join(T, "mono");
write(path.join(C, "outside.txt"), "outside v1");
write(path.join(C, "app", "inside.txt"), "inside v1");
g(C, "init", "-q", "-b", "main");
const sub = path.join(C, "app");
const s3 = await saveSnapshot(sub);
ok(s3.scope === "app" && s3.files === 1, "a subfolder snapshot covers only that subfolder");
write(path.join(sub, "inside.txt"), "inside v2");
write(path.join(C, "outside.txt"), "outside v2");
await restoreSnapshot(s3);
ok(same(path.join(sub, "inside.txt"), "inside v1") && same(path.join(C, "outside.txt"), "outside v2"), "undo of a subfolder leaves the rest of the repository alone");

// ---- size limit ----
const D = path.join(T, "huge");
fs.mkdirSync(D);
for (let i = 0; i <= 20000; i++) fs.writeFileSync(path.join(D, `f${i}.txt`), "");
let tooBig = null;
try { await saveSnapshot(D); } catch (e) { tooBig = e.message; }
ok(/too large for a snapshot/.test(tooBig || "") && !fs.existsSync(path.join(D, ".git")), "a folder over the limit is refused and its fresh .git is removed again");

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
