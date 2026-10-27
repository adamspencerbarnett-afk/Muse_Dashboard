// Muse Dashboard · lib/github.js
// Author: Adam S. Barnett
//
// GitHub repository links in a chat message: clone the repository into
// Projects/ and run the chat there, so Muse can edit, commit and push.
//
// Sign-in is Git's own: its credential helper (Git Credential Manager, bundled
// with Git for Windows, or the system keychain helper) keeps the GitHub account
// and asks for a sign-in the first time a push needs it. The dashboard never
// reads or stores a token. Each clone gets a local commit identity (the account's
// GitHub no-reply address) when Git has none, a pre-push hook that refuses
// force-pushes and remote branch deletion, and the starter files listed in
// .git/info/exclude so they stay out of the repository.
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

function git(args, { cwd, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
    execFile("git", args, { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split(/\r?\n/).slice(-3).join(" ")));
      resolve(stdout);
    });
  });
}

/** Repository links in a message: https://github.com/<owner>/<repo>[.git][/tree/...], at most 3. */
export function githubLinksInText(text) {
  const out = [];
  for (const m of String(text).slice(0, 20000).matchAll(/(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})/gi)) {
    const owner = m[1];
    const repo = m[2].replace(/\.git$/i, "").replace(/\.+$/, "");
    if (!repo || repo === "." || repo === "..") continue;
    const url = `https://github.com/${owner}/${repo}`;
    if (!out.some((l) => l.url.toLowerCase() === url.toLowerCase())) out.push({ owner, repo, url });
    if (out.length >= 3) break;
  }
  return out;
}

/** GitHub accounts Git Credential Manager is signed in to ([] when GCM is missing, e.g. another credential helper). */
export async function githubAccounts() {
  try {
    return (await git(["credential-manager", "github", "list"], { timeout: 15000 })).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const sameRepo = (a, b) => String(a).toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "") === String(b).toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");

/** origin's URL of a folder, or null. */
async function originOf(dir) {
  try { return (await git(["remote", "get-url", "origin"], { cwd: dir })).trim(); } catch { return null; }
}

/** The first folder (in order) whose origin is this repository. */
export async function findClone(url, dirs) {
  for (const dir of dirs) {
    const origin = await originOf(dir).catch(() => null);
    if (origin && sameRepo(origin, url)) return dir;
  }
  return null;
}

// Runs in Git for Windows' sh. Each stdin line: <local ref> <local sha> <remote ref> <remote sha>.
const PRE_PUSH = `#!/bin/sh
# Added by Muse Dashboard: refuse force-pushes and deleting branches on the remote.
zero=0000000000000000000000000000000000000000
while read local_ref local_sha remote_ref remote_sha; do
  case "$local_sha" in *[!0]*) ;; *) echo "Muse Dashboard: deleting $remote_ref on the remote is blocked." >&2; exit 1 ;; esac
  case "$remote_sha" in *[!0]*) ;; *) continue ;; esac
  if ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
    echo "Muse Dashboard: force-push to $remote_ref is blocked (it would drop commits already on GitHub). Pull and merge instead." >&2
    exit 1
  fi
done
exit 0
`;

/** The GitHub no-reply address for an account, so commits link to it without exposing a personal email. */
async function noreplyEmail(login) {
  try {
    const r = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers: { "User-Agent": "muse-dashboard" }, signal: AbortSignal.timeout(8000) });
    const id = r.ok ? (await r.json()).id : null;
    if (Number.isInteger(id)) return `${id}+${login}@users.noreply.github.com`;
  } catch { /* offline: the plain form below still works for pushing */ }
  return `${login}@users.noreply.github.com`;
}

/**
 * Clone `link` into a new folder under `parentDir` (named after the repository; -2, -3 … when taken).
 * `cloneUrl` overrides where Git clones from (tests). Returns { dir, branch, empty, identity }.
 */
export async function cloneRepo(link, parentDir, { cloneUrl, account } = {}) {
  await fsp.mkdir(parentDir, { recursive: true });
  const base = path.join(parentDir, link.repo);
  let dir = base;
  for (let i = 2; await fsp.access(dir).then(() => true, () => false); i++) dir = `${base}-${i}`;
  await git(["clone", "--", cloneUrl || `${link.url}.git`, dir], { timeout: 10 * 60000 });
  dir = await fsp.realpath(dir);
  if (!cloneUrl) await git(["remote", "set-url", "origin", `${link.url}.git`], { cwd: dir });
  const empty = !(await git(["rev-parse", "--verify", "-q", "HEAD"], { cwd: dir }).then(() => true, () => false));
  const branch = (await git(["symbolic-ref", "--short", "HEAD"], { cwd: dir }).catch(() => "")).trim() || null;
  // Commits need an identity; when Git has none, use the account's no-reply address in this clone only.
  let identity = null;
  const hasEmail = (await git(["config", "user.email"], { cwd: dir }).catch(() => "")).trim();
  if (!hasEmail) {
    const login = account || link.owner;
    identity = { name: login, email: await noreplyEmail(login) };
    await git(["config", "user.name", identity.name], { cwd: dir });
    await git(["config", "user.email", identity.email], { cwd: dir });
  }
  const gitDir = path.resolve(dir, (await git(["rev-parse", "--git-dir"], { cwd: dir })).trim());
  await fsp.mkdir(path.join(gitDir, "hooks"), { recursive: true });
  const hook = path.join(gitDir, "hooks", "pre-push");
  if (!(await fsp.access(hook).then(() => true, () => false))) await fsp.writeFile(hook, PRE_PUSH, { encoding: "utf8", mode: 0o755 });
  return { dir, branch, empty, identity };
}

/** Keep the dashboard's starter files out of the repository (only those the repository does not track itself). */
export async function excludeStarterFiles(dir, names) {
  const tracked = new Set((await git(["ls-files", "--", ...names], { cwd: dir }).catch(() => "")).split(/\r?\n/).filter(Boolean));
  const add = names.filter((n) => !tracked.has(n)).map((n) => `/${n}`);
  if (!add.length) return;
  const gitDir = path.resolve(dir, (await git(["rev-parse", "--git-dir"], { cwd: dir })).trim());
  const file = path.join(gitDir, "info", "exclude");
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const had = await fsp.readFile(file, "utf8").catch(() => "");
  const missing = add.filter((l) => !had.split(/\r?\n/).includes(l));
  if (missing.length) await fsp.appendFile(file, `${had && !had.endsWith("\n") ? "\n" : ""}# Muse Dashboard starter files (local only)\n${missing.join("\n")}\n`, "utf8");
}

/** The AGENTS.md section that tells Muse how to work with the repository. */
export function githubRules(link, { branch, empty } = {}) {
  return `## GitHub repository

This folder is a clone of ${link.url} (remote \`origin\`${branch ? `, branch \`${branch}\`` : ""}). The user wants their changes on GitHub:

- When a change is done and verified, commit it with a clear message and push it: \`git push origin HEAD\`${empty ? " (the repository was empty when cloned: the first push creates its first branch; use `git push -u origin HEAD`)" : ""}. Unless the user asks for something else, push to the current branch.
- Before starting new work, \`git pull --ff-only\` so you build on what is on GitHub. If the pull or a push is rejected because GitHub has newer commits, pull (merge, not rebase of pushed commits), resolve conflicts, verify, then push.
- Sign-in is handled by Git's credential helper (on Windows, Git Credential Manager): the first push may open a GitHub sign-in in the browser; tell the user to approve it. If a push fails for sign-in, stop and tell the user to sign in to GitHub with Git once (for example by pushing from a terminal). Never ask for, print or store a token or password.
- Never force-push, rewrite commits already on GitHub, or delete remote branches (a pre-push hook blocks these). Don't change repository settings.
- MASTER.md, LOG.md and AGENTS.md here are local notes (listed in .git/info/exclude) unless the repository already tracks them; don't add them with \`git add -f\`.
`;
}
