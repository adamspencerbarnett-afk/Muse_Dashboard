// Muse Dashboard · lib/agents.js
// Author: Adam S. Barnett
//
// Subagents and workflows: the per-chat Agents mode (solo / auto / parallel),
// Muse's workspace-trust rule (read and written in Muse's own trust.json), and
// the usage and state facts read off `subagent` and `workflow` items. Muse
// decides when to delegate; the dashboard only steers it with a short
// instruction per message and keeps the cost of children visible.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AGENT_MODES = ["solo", "auto", "parallel"];

/**
 * The instruction added to each message for a chat's Agents mode ("" for
 * auto: Muse's own default, which is to work inline). `isolation` says
 * whether the folder is its own Git repository, so writing children can get
 * isolated worktrees; elsewhere they must keep to separate files.
 */
export function agentDirective(mode, { isolation = false, helperModel = "muse-spark-1.3", helperEffort = "medium", maxChildren = 4 } = {}) {
  if (mode === "solo") return "[Agents: solo] Do not use subagents or workflows for this request; do the work yourself.";
  if (mode !== "parallel") return "";
  const writers = isolation
    ? "Give every child that writes files worktree isolation; read-only children stay in the shared folder."
    : "Do not request worktree isolation (this folder is not its own Git repository): give each writing child its own files and never let two children write the same file.";
  return [
    "[Agents: parallel] Split this request into its genuinely independent parts and run them as children:",
    `use the workflow tool with model "${helperModel}" and effort "${helperEffort}" for each child unless a part needs deeper reasoning.`,
    writers,
    `At most ${maxChildren} children at once.`,
    "Keep simple lookups and one-file fixes inline.",
    "Keep working while children run and never repeat a wait that timed out.",
    "Run any command expected to take over about a minute in the background and continue.",
    "After small fixes re-run only the affected tests, not the full slow suite.",
  ].join(" ");
}

// ---------- workspace trust (Muse's own rule, measured on Muse 1.4.13) ----------
// A session's folder is trusted when the folder itself, or the root of the Git
// repository it is in, has decision "trusted" in Muse's trust.json. A trusted
// parent folder alone does not count. Untrusted folders silently skip their
// AGENTS.md project rules and hide the subagent tools.

const canon = (p) => {
  let s = path.resolve(String(p).replace(/^\\\\\?\\/, ""));
  if (process.platform === "win32") s = s.toLowerCase();
  return s.replace(/[\\/]+$/, "");
};

/** The nearest folder at or above `dir` that holds `.git` (a folder, or a file for worktrees), else null. */
export function gitRootOf(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

function trustFile(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "muse", "trust.json");
}

/**
 * { trusted, via, gitRoot, isolation } for a chat folder. `via` is "flag"
 * (dashboard runs Muse with --trust-workspace), "folder", "gitRoot" or null.
 * `isolation` is true when the folder is its own Git repository root.
 */
export function workspaceTrust(workspace, { trustAll = false, file = trustFile() } = {}) {
  const gitRoot = workspace ? gitRootOf(workspace) : null;
  const isolation = !!gitRoot && canon(gitRoot) === canon(workspace);
  if (!workspace) return { trusted: false, via: null, gitRoot, isolation };
  if (trustAll) return { trusted: true, via: "flag", gitRoot, isolation };
  let projects = {};
  try { projects = JSON.parse(fs.readFileSync(file, "utf8")).projects || {}; } catch { /* no trust.json: nothing trusted */ }
  const trusted = new Set(Object.entries(projects).filter(([, v]) => v && v.decision === "trusted").map(([k]) => canon(k)));
  if (trusted.has(canon(workspace))) return { trusted: true, via: "folder", gitRoot, isolation };
  if (gitRoot && trusted.has(canon(gitRoot))) return { trusted: true, via: "gitRoot", gitRoot, isolation };
  return { trusted: false, via: null, gitRoot, isolation };
}

/**
 * Mark a folder trusted in Muse's trust.json, in the key format Muse writes
 * itself (`\\?\C:\...` on Windows), keeping every other entry. The file is
 * Muse's: an unreadable one is left alone rather than replaced, and the new
 * version goes in with one rename so Muse never reads half a file. Measured
 * on Muse 1.4.13: sessions started afterwards are trusted at once (no host
 * restart); a session that already exists keeps the trust it started with.
 */
export function trustFolder(dir, { file = trustFile() } = {}) {
  let data = { schema_version: 1, projects: {} };
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`Muse's trust file ${file} could not be read (${e.message}); it was not changed.`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`Muse's trust file ${file} has an unexpected format; it was not changed.`);
  if (data.schema_version === undefined) data.schema_version = 1;
  if (!data.projects || typeof data.projects !== "object" || Array.isArray(data.projects)) data.projects = {};
  const resolved = path.resolve(dir);
  const key = Object.keys(data.projects).find((k) => canon(k) === canon(resolved)) || (process.platform === "win32" ? `\\\\?\\${resolved}` : resolved);
  data.projects[key] = { ...data.projects[key], decision: "trusted" };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return key;
}

// ---------- subagent / workflow items ----------

const RUNNING_CONTROL = new Set(["accepted", "starting", "running"]);

/**
 * Is this item still doing work? A subagent's item `status` stays
 * "inProgress" after it has handed in its result, so its `controlStatus`
 * decides; a workflow is open while it is inProgress and stoppable.
 */
export function agentActive(item) {
  if (!item || item.status !== "inProgress") return false;
  if (item.kind === "workflow") return item.stopAvailable !== false;
  if (item.kind === "subagent") return item.controlStatus === undefined || RUNNING_CONTROL.has(item.controlStatus);
  return false;
}

/** A subagent item's transitive usage as { input, cached, output } (input includes the cached part, like the parent's). */
export function agentUsage(item) {
  const u = item && item.usage;
  if (!u) return null;
  return { input: Number(u.inputTokens) || 0, cached: Number(u.cacheReadTokens ?? u.cachedTokens) || 0, output: Number(u.outputTokens) || 0 };
}

/**
 * Per-turn totals over subagent items. Workflow children are subagent items
 * too (with a workflowRunId), so workflows' own children[].usage is not added.
 */
export function sumAgents(items) {
  const t = { count: 0, input: 0, cached: 0, output: 0 };
  for (const it of items) {
    if (it.kind !== "subagent") continue;
    t.count += 1;
    const u = agentUsage(it);
    if (u) { t.input += u.input; t.cached += u.cached; t.output += u.output; }
  }
  return t;
}

/** A chat's persisted agent totals from its { itemId: [input, cached, output] } record. */
export function agentTotals(agentItems) {
  const t = { count: 0, input: 0, cached: 0, output: 0 };
  for (const v of Object.values(agentItems || {})) {
    if (!Array.isArray(v)) continue;
    t.count += 1; t.input += Number(v[0]) || 0; t.cached += Number(v[1]) || 0; t.output += Number(v[2]) || 0;
  }
  return t;
}
