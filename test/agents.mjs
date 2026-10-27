// Muse Dashboard · test/agents.mjs
// Author: Adam S. Barnett
//
// Unit checks for lib/agents.js: Muse's workspace-trust rule (as measured on
// Muse 1.4.13), the Agents-mode instruction, and subagent/workflow item facts.
// Usage: node test/agents.mjs   (npm run test:agents)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentDirective, workspaceTrust, gitRootOf, agentActive, agentUsage, sumAgents, agentTotals } from "../lib/agents.js";

let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { failN++; console.log("FAIL", m); } };

const T = fs.mkdtempSync(path.join(os.tmpdir(), "mdagents-"));
const mk = (...p) => { const d = path.join(T, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const trusted = mk("trusted");              // listed in trust.json, no Git
const sub = mk("trusted", "sub");           // under a trusted folder, no Git
const repo = mk("repo");                    // a Git repository whose root is listed
fs.mkdirSync(path.join(repo, ".git"));
const inRepo = mk("repo", "Projects", "chat"); // like Projects/<chat> inside the dashboard repo
const ownRepo = mk("own");                  // its own Git root, listed itself
fs.mkdirSync(path.join(ownRepo, ".git"));
const stranger = mk("stranger");            // listed nowhere
const file = path.join(T, "trust.json");
const key = (p) => (process.platform === "win32" ? `\\\\?\\${p.toUpperCase()}` : p); // Muse writes \\?\ paths; case must not matter on Windows
fs.writeFileSync(file, JSON.stringify({ schema_version: 1, projects: { [key(trusted)]: { decision: "trusted" }, [key(repo)]: { decision: "trusted" }, [key(ownRepo)]: { decision: "trusted" }, [key(stranger)]: { decision: "untrusted" } } }));

let t = workspaceTrust(trusted, { file });
ok(t.trusted && t.via === "folder" && !t.isolation, "a listed folder is trusted");
t = workspaceTrust(sub, { file });
ok(!t.trusted, "a subfolder of a trusted folder is NOT trusted without a trusted Git root (Muse skips its rules and subagents)");
t = workspaceTrust(inRepo, { file });
ok(t.trusted && t.via === "gitRoot" && !t.isolation && t.gitRoot === repo, "a folder inside a trusted Git repository is trusted through the repository root, and has no worktree isolation of its own");
t = workspaceTrust(ownRepo, { file });
ok(t.trusted && t.isolation, "a folder that is its own Git root can isolate writing children");
ok(!workspaceTrust(stranger, { file }).trusted, "an \"untrusted\" decision does not trust the folder");
ok(workspaceTrust(stranger, { file, trustAll: true }).via === "flag", "trustWorkspace (Muse --trust-workspace) trusts every folder");
ok(!workspaceTrust(trusted, { file: path.join(T, "missing.json") }).trusted, "no trust.json: nothing is trusted");
ok(gitRootOf(inRepo) === repo && gitRootOf(stranger) === null, "Git root lookup walks up to the nearest .git");

// Agents mode instruction
ok(agentDirective("auto") === "", "auto adds nothing (Muse decides)");
ok(/do not use subagents/i.test(agentDirective("solo")), "solo forbids subagents");
const par = agentDirective("parallel", { isolation: false, helperModel: "muse-spark-1.3", helperEffort: "medium", maxChildren: 4 });
ok(par.includes('model "muse-spark-1.3"') && par.includes('effort "medium"') && par.includes("At most 4"), "parallel names the helper model, effort and child cap");
ok(/do not request worktree isolation/i.test(par) && /never repeat a wait/i.test(par) && /background/i.test(par), "parallel without isolation keeps writers on separate files; no wait loops; long commands in the background");
ok(/worktree isolation;/i.test(agentDirective("parallel", { isolation: true })), "parallel in its own Git repository asks for isolated writers");

// Subagent / workflow items
ok(agentActive({ kind: "subagent", status: "inProgress", controlStatus: "running" }), "a running subagent is active");
ok(agentActive({ kind: "subagent", status: "inProgress", controlStatus: "accepted" }), "a queued subagent is active");
ok(!agentActive({ kind: "subagent", status: "inProgress", controlStatus: "resultReady" }), "a subagent that handed in its result is not active (its status stays inProgress)");
ok(agentActive({ kind: "workflow", status: "inProgress", stopAvailable: true }) && !agentActive({ kind: "workflow", status: "completed", stopAvailable: false }), "a workflow is active while open");
ok(!agentActive({ kind: "toolCall", status: "inProgress" }), "other items are never agents");
const u = agentUsage({ usage: { inputTokens: 1000, cachedTokens: 600, outputTokens: 20 } });
ok(u.input === 1000 && u.cached === 600 && u.output === 20, "usage: input includes cached, like the parent's");
const s = sumAgents([
  { kind: "subagent", usage: { inputTokens: 100, cachedTokens: 50, outputTokens: 5 } },
  { kind: "subagent", workflowRunId: "w", usage: { inputTokens: 200, cacheReadTokens: 100, outputTokens: 7 } },
  { kind: "workflow", children: [{ usage: { inputTokens: 200, outputTokens: 7 } }] },
]);
ok(s.count === 2 && s.input === 300 && s.cached === 150 && s.output === 12, "turn totals add subagent items only (workflow children are subagent items; no double count)");
const tot = agentTotals({ a: [10, 5, 1], b: [20, 10, 2], junk: "x" });
ok(tot.count === 2 && tot.input === 30 && tot.cached === 15 && tot.output === 3, "persisted per-item usage sums per chat");

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
