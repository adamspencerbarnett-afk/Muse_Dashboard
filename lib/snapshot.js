// Muse Dashboard · lib/snapshot.js
// Author: Adam S. Barnett
//
// Git snapshots of a chat's folder, so Muse's changes can be undone.
//
// A snapshot is a commit object built from a private temporary index and kept
// under refs/muse-dashboard/: the user's branch, index and working tree are
// never touched. A folder that is not in a Git repository gets `git init`
// first, with build and dependency folders excluded in .git/info/exclude (no
// file is added to the folder itself). Line-ending conversion and attribute
// filters are switched off for these commands, so an undo restores exactly the
// bytes that were saved. Files Git ignores are neither saved nor touched.
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EXACT = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", `--attr-source=${EMPTY_TREE}`];
const IDENTITY = ["-c", "user.name=Muse Dashboard", "-c", "user.email=muse-dashboard@localhost"];
const DEFAULT_EXCLUDES = ["node_modules/", ".venv/", "venv/", "__pycache__/", ".next/", ".nuxt/", ".turbo/", ".cache/", "dist/", "build/", "out/", "target/", "coverage/", ".muse-uploads/", "*.log"];
const MAX_FILES = 20000;
const MAX_BYTES = 1024 * 1024 * 1024;

function git(args, { cwd, index, input } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
    if (index) env.GIT_INDEX_FILE = index;
    const child = execFile("git", args, { cwd, env, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split(/\r?\n/).slice(-3).join(" ")));
      resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

let available = null;
/** Is Git installed? (asked once) */
export async function gitAvailable() {
  if (available === null) available = await git(["--version"]).then(() => true, () => false);
  return available;
}

async function repoRoot(dir) {
  try { return path.resolve((await git(["rev-parse", "--show-toplevel"], { cwd: dir })).trim()); } catch { return null; }
}
const scopeOf = (root, dir) => path.relative(root, dir).split(path.sep).join("/") || ".";
const splitZ = (out) => out.split("\0").filter(Boolean);

/** What the New-chat popup needs: is the folder in a repository, and does it have changes no commit holds? */
export async function folderGit(dir) {
  if (!(await gitAvailable())) return { available: false, repo: false, changes: 0 };
  const root = await repoRoot(dir);
  if (!root) return { available: true, repo: false, changes: 0 };
  const scope = scopeOf(root, dir);
  const out = await git(["status", "--porcelain", "-z", "--untracked-files=all", "--", scope], { cwd: root }).catch(() => "");
  // Renames take two NUL-separated fields; counting entries that start with a status code is close enough here.
  const changes = splitZ(out).filter((e) => /^[ MADRCU?!]{2} /.test(e)).length;
  return { available: true, repo: true, root, changes };
}

/** Commit the folder's current state from a private index; returns { commit, tree, files }. */
async function capture(root, scope, message) {
  const index = path.join(os.tmpdir(), `muse-snapshot-${crypto.randomUUID()}.idx`);
  try {
    const parent = (await git(["rev-parse", "-q", "--verify", "HEAD^{commit}"], { cwd: root }).catch(() => "")).trim();
    await git(parent ? ["read-tree", parent] : ["read-tree", "--empty"], { cwd: root, index });
    await git([...EXACT, "add", "-A", "--", scope], { cwd: root, index });
    const tree = (await git(["write-tree"], { cwd: root, index })).trim();
    const commit = (await git([...IDENTITY, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], { cwd: root })).trim();
    const files = splitZ(await git(["ls-files", "-z", "--", scope], { cwd: root, index })).length;
    return { commit, tree, files };
  } finally {
    await fsp.rm(index, { force: true }).catch(() => undefined);
  }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/**
 * Save a snapshot of `dir`. Refuses (and undoes its own `git init`) when the
 * files that would be saved exceed MAX_FILES / MAX_BYTES.
 */
export async function saveSnapshot(dir, { label = "Snapshot before Muse" } = {}) {
  if (!(await gitAvailable())) throw new Error("Git is not installed, so no snapshot can be saved.");
  let root = await repoRoot(dir);
  let createdRepo = false;
  if (!root) {
    await git(["-c", "init.defaultBranch=main", "init", "-q"], { cwd: dir });
    createdRepo = true;
    root = path.resolve(dir);
    const exclude = path.join(root, ".git", "info", "exclude");
    await fsp.mkdir(path.dirname(exclude), { recursive: true });
    await fsp.appendFile(exclude, `\n# Added by Muse Dashboard: left out of snapshots\n${DEFAULT_EXCLUDES.join("\n")}\n`, "utf8");
  }
  const scope = scopeOf(root, dir);
  try {
    // Only files a commit does not already hold need saving: check their size first.
    const pending = splitZ(await git(["ls-files", "-z", "-o", "-m", "--exclude-standard", "--", scope], { cwd: root }));
    let bytes = 0;
    for (const rel of pending) {
      try { bytes += (await fsp.stat(path.join(root, rel))).size; } catch { /* deleted meanwhile */ }
      if (bytes > MAX_BYTES) break;
    }
    if (pending.length > MAX_FILES || bytes > MAX_BYTES) {
      throw new Error(`This folder is too large for a snapshot (${pending.length.toLocaleString()} files, ${(bytes / 1048576).toFixed(0)} MB to save; the limit is ${MAX_FILES.toLocaleString()} files or ${MAX_BYTES / 1073741824} GB).`);
    }
    const { commit, files } = await capture(root, scope, `${label}\n\nFolder: ${dir}`);
    const ref = `refs/muse-dashboard/snapshots/${stamp()}`;
    await git(["update-ref", ref, commit], { cwd: root });
    return { commit, ref, root, scope, dir: path.resolve(dir), at: new Date().toISOString(), files, createdRepo };
  } catch (e) {
    if (createdRepo) await fsp.rm(path.join(root, ".git"), { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

/**
 * Put the folder back the way it was at `snap`: files changed or deleted
 * since are restored, files added since are deleted. The state just before
 * the undo is saved first (refs/muse-dashboard/before-undo/...), so the undo
 * itself can be reversed by hand.
 */
export async function restoreSnapshot(snap) {
  const { root, scope, commit } = snap;
  if (!(await gitAvailable())) throw new Error("Git is not installed, so the snapshot cannot be restored.");
  if (!fs.existsSync(root)) throw new Error(`The folder ${root} no longer exists.`);
  try { await git(["cat-file", "-e", `${commit}^{commit}`], { cwd: root }); } catch { throw new Error("The snapshot is no longer in this folder's Git repository."); }
  const before = await capture(root, scope, "Before undo (Muse Dashboard)");
  const beforeRef = `refs/muse-dashboard/before-undo/${stamp()}`;
  await git(["update-ref", beforeRef, before.commit], { cwd: root });
  const fields = splitZ(await git(["diff-tree", "-r", "-z", "--no-renames", "--name-status", `${commit}^{tree}`, before.tree, "--", scope], { cwd: root }));
  const added = [];
  const restore = [];
  for (let i = 0; i + 1 < fields.length; i += 2) (fields[i] === "A" ? added : restore).push(fields[i + 1]);
  const scopeDir = path.resolve(root, scope);
  for (const rel of added) {
    const abs = path.join(root, rel);
    await fsp.rm(abs, { force: true });
    // Drop folders that the undo left empty, up to the chat's folder.
    for (let d = path.dirname(abs); d.length > scopeDir.length && d.startsWith(scopeDir); d = path.dirname(d)) {
      try { await fsp.rmdir(d); } catch { break; }
    }
  }
  if (restore.length) {
    const index = path.join(os.tmpdir(), `muse-restore-${crypto.randomUUID()}.idx`);
    try {
      await git(["read-tree", commit], { cwd: root, index });
      await git([...EXACT, "checkout-index", "-f", "-z", "--stdin"], { cwd: root, index, input: restore.join("\0") + "\0" });
    } finally {
      await fsp.rm(index, { force: true }).catch(() => undefined);
    }
  }
  return { restored: restore.length, removed: added.length, beforeRef };
}
