// Muse Dashboard · test/github.mjs
// Author: Adam S. Barnett
//
// Focused check of lib/github.js against real Git, with local bare
// repositories standing in for GitHub: link parsing, clone (commit identity,
// pre-push hook), an empty repository's first push, the hook refusing
// force-push and remote branch deletion, starter files kept out of the
// repository, and finding an existing clone.
// Usage: node test/github.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { githubLinksInText, findClone, cloneRepo, excludeStarterFiles, githubRules } from "../lib/github.js";
import { gitAvailable } from "../lib/snapshot.js";

let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { failN++; console.log("FAIL", m); } };
if (!(await gitAvailable())) { console.log("SKIP git is not installed"); process.exit(0); }
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mdgh-")));
// No global identity, so the clone's own identity is what commits use.
fs.writeFileSync(path.join(T, "empty.gitconfig"), "");
process.env.GIT_CONFIG_GLOBAL = path.join(T, "empty.gitconfig");
const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const fails = (cwd, ...args) => { try { g(cwd, ...args); return null; } catch (e) { return String(e.stderr || e.message); } };

// ---- links ----
const links = githubLinksInText("Update https://github.com/octocat/Hello-World. Also github.com/Org/tool.js.git and https://github.com/Org/tool.js/tree/main/src, https://github.com/a/b");
ok(links.length === 3, `three distinct links (got ${links.length})`);
ok(links[0].owner === "octocat" && links[0].repo === "Hello-World" && links[0].url === "https://github.com/octocat/Hello-World", "trailing full stop is not part of the repository name");
ok(links[1].repo === "tool.js" && links[1].url === "https://github.com/Org/tool.js", ".git and /tree/... are dropped; the same repository is listed once");
ok(githubLinksInText("see C:\\code\\x and gitlab.com/a/b").length === 0, "no link, no match");

// ---- a repository with history ----
const remote = path.join(T, "remote.git");
g(T, "init", "--bare", "-b", "main", remote);
const seed = path.join(T, "seed");
g(T, "clone", remote, seed);
fs.writeFileSync(path.join(seed, "README.md"), "hello\n");
fs.writeFileSync(path.join(seed, "LOG.md"), "tracked by the repository\n");
g(seed, "add", ".");
g(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "first");
g(seed, "push", "origin", "main");

const link = { owner: "octo", repo: "proj", url: "https://github.com/octo/proj" };
const projects = path.join(T, "Projects");
const c1 = await cloneRepo(link, projects, { cloneUrl: remote, account: "octo" });
ok(path.basename(c1.dir) === "proj" && !c1.empty && c1.branch === "main", `cloned into Projects/proj on main (${c1.branch})`);
ok(c1.identity && c1.identity.name === "octo" && /^(\d+\+)?octo@users\.noreply\.github\.com$/.test(c1.identity.email) && g(c1.dir, "config", "user.email") === c1.identity.email, `clone-only identity is the no-reply address (${c1.identity?.email})`);
ok(fs.existsSync(path.join(c1.dir, ".git", "hooks", "pre-push")), "pre-push hook installed");
const c2 = await cloneRepo(link, projects, { cloneUrl: remote, account: "octo" });
ok(path.basename(c2.dir) === "proj-2", "a taken folder name gets -2");

// Starter files stay local; one the repository tracks is left alone.
for (const n of ["MASTER.md", "AGENTS.md"]) fs.writeFileSync(path.join(c1.dir, n), "local\n");
await excludeStarterFiles(c1.dir, ["MASTER.md", "LOG.md", "AGENTS.md"]);
const ex = fs.readFileSync(path.join(c1.dir, ".git", "info", "exclude"), "utf8");
ok(ex.includes("/MASTER.md") && ex.includes("/AGENTS.md") && !ex.includes("/LOG.md"), "MASTER.md and AGENTS.md excluded, tracked LOG.md not");
ok(g(c1.dir, "status", "--porcelain") === "", "starter files do not show as changes");
await excludeStarterFiles(c1.dir, ["MASTER.md"]);
ok(fs.readFileSync(path.join(c1.dir, ".git", "info", "exclude"), "utf8") === ex, "excluding again adds nothing");

// Normal work: commit and push.
fs.writeFileSync(path.join(c1.dir, "README.md"), "hello\nmore\n");
g(c1.dir, "commit", "-am", "second");
ok(fails(c1.dir, "push", "origin", "HEAD") === null && g(remote, "log", "-1", "--format=%s %ae", "main") === `second ${c1.identity.email}`, "commit + push reach the remote with the clone's identity");
ok(fails(c1.dir, "push", "origin", "HEAD:refs/heads/feature") === null, "pushing a new branch is allowed");

// The hook: no force-push, no remote branch deletion.
g(c1.dir, "commit", "--amend", "-m", "rewritten");
const forced = fails(c1.dir, "push", "--force", "origin", "HEAD");
ok(forced && /force-push to refs\/heads\/main is blocked/.test(forced) && g(remote, "log", "-1", "--format=%s", "main") === "second", "force-push is refused and the remote keeps its commit");
const del = fails(c1.dir, "push", "origin", "--delete", "feature");
ok(del && /deleting refs\/heads\/feature on the remote is blocked/.test(del) && g(remote, "branch", "--list", "feature") !== "", "deleting a remote branch is refused");

// ---- an empty repository (like a new GitHub repo) ----
const emptyRemote = path.join(T, "empty.git");
g(T, "init", "--bare", "-b", "main", emptyRemote);
const e1 = await cloneRepo({ owner: "octo", repo: "fresh", url: "https://github.com/octo/fresh" }, projects, { cloneUrl: emptyRemote, account: "octo" });
ok(e1.empty, "an empty repository is reported as empty");
fs.writeFileSync(path.join(e1.dir, "index.html"), "<h1>hi</h1>\n");
g(e1.dir, "add", "index.html");
g(e1.dir, "commit", "-m", "start");
ok(fails(e1.dir, "push", "-u", "origin", "HEAD") === null && g(emptyRemote, "log", "-1", "--format=%s") === "start", "the first push to an empty repository creates its branch");

// ---- finding an existing clone ----
g(c1.dir, "remote", "set-url", "origin", "https://github.com/Octo/Proj.git");
ok((await findClone("https://github.com/octo/proj", [e1.dir, c1.dir])) === c1.dir, "existing clone found by origin (case and .git ignored)");
ok((await findClone("https://github.com/octo/other", [e1.dir, c1.dir])) === null, "no clone for another repository");

const rules = githubRules(link, { branch: "main", empty: false });
ok(rules.includes(link.url) && /never force-push/i.test(rules) && rules.includes("git push origin HEAD"), "AGENTS.md rules name the repository, push and the no-force rule");

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
