// Muse Dashboard · test/e2e-mock.mjs
// Author: Adam S. Barnett
//
// End-to-end check of the dashboard against mock/mock-muse.mjs. Starts its own
// temporary dashboard (data, Projects and mock state in a temp folder), runs
// the checks, and stops it again.
// Usage: node test/e2e-mock.mjs   (npm run test:mock)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "mde2e-"));
const dataDir = path.join(T, "data"), proj = path.join(T, "proj"), updDir = path.join(T, "upd");
process.env.MD_TEST_CHATS = path.join(T, "Projects");
process.env.MOCK_MUSE_STATE = path.join(T, "mock-state.json");
for (const d of [dataDir, proj, updDir, process.env.MD_TEST_CHATS]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(updDir, ".muse-version"), "9.0.0-R1.1");
const cfg = path.join(T, "config.json");
const binDir = path.join(T, "recycle-bin"); // stands in for the Recycle Bin (config testRecycleBin)
fs.mkdirSync(binDir);
fs.writeFileSync(cfg, JSON.stringify({
  projectsDir: process.env.MD_TEST_CHATS, idleShutdownSeconds: 0, open: false, sandbox: true, approvalMode: "onRequest", testRecycleBin: { dir: binDir },
  autoUpdate: true, updateCommand: [process.execPath, path.join(APP, "test", "fake-update.mjs"), updDir, "9.1.0-R2.1"], updateStateDir: updDir,
  museBin: process.execPath, museArgs: [path.join(APP, "mock", "mock-muse.mjs")],
  historyTurns: 2, turnStepWarn: 2, turnStepLimit: 3, cronRunWarn: 2, agentTokenWarn: 150000, agentTokenLimit: 600000, agentStallMinutes: 0.05,
}));
// Muse's trust store for this run: only the project folder is trusted (the Projects chats are not).
const cfgHome = path.join(T, "cfghome");
fs.mkdirSync(path.join(cfgHome, "muse"), { recursive: true });
fs.writeFileSync(path.join(cfgHome, "muse", "trust.json"), JSON.stringify({ schema_version: 1, projects: { [proj]: { decision: "trusted" } } }));
// A session started in the terminal: listed by the dashboard, never loaded just to be read.
const termId = "11111111-2222-4333-8444-555555555555";
const now = new Date().toISOString();
fs.writeFileSync(process.env.MOCK_MUSE_STATE, JSON.stringify({ [termId]: { sessionId: termId, workspaceRoot: proj, createdAt: now, updatedAt: now, events: [], turnCount: 0, firstUserPrompt: "started in the terminal" } }));
const server = spawn(process.execPath, [path.join(APP, "server.js"), "--no-open", "--data-dir", dataDir, "--config", cfg], {
  cwd: APP, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MOCK_MUSE_VERSION: "9.1.0-R2.1", MUSE_DASHBOARD_SUPERVISED: "", XDG_CONFIG_HOME: cfgHome, META_API_KEY: "mock-env-key" }, // env key: the dashboard starts in API-key (env) mode, so folder spend counts as billable
});
let serverLog = "";
server.stdout.on("data", (c) => (serverLog += c));
server.stderr.on("data", (c) => (serverLog += c));
process.on("exit", () => {
  if (process.platform === "win32") { try { execFileSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ } }
  else server.kill("SIGTERM");
});
let rt = null;
for (let i = 0; i < 150 && !rt; i++) { try { rt = JSON.parse(fs.readFileSync(path.join(dataDir, "runtime.json"), "utf8")); } catch { await new Promise((res) => setTimeout(res, 100)); } }
if (!rt) { console.log(`FAIL dashboard did not start\n${serverLog}`); process.exit(1); }
const base = rt.url;
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { failN++; console.log("FAIL", m); } };

// security
let r = await fetch(base + "api/state");
ok(r.status === 403, "API without cookie is refused (403)");
r = await fetch(base + "?t=wrong", { redirect: "manual" });
ok(r.status === 403, "wrong token refused");
r = await fetch(rt.launchUrl, { redirect: "manual" });
const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
ok(r.status === 302 && cookie.startsWith("md_token="), "token link sets cookie + redirects");
ok(/SameSite=Strict/.test(r.headers.get("set-cookie")) && /HttpOnly/.test(r.headers.get("set-cookie")), "cookie is HttpOnly SameSite=Strict");
const H = { Cookie: cookie, "X-Muse-Dashboard": "1", "Content-Type": "application/json" };
r = await fetch(base, { headers: { Cookie: cookie } });
ok(r.status === 200 && (await r.text()).includes("Muse Dashboard"), "index loads with cookie");
ok(/default-src 'self'/.test(r.headers.get("content-security-policy")), "CSP header present");
for (const v of ["/vendor/marked.js", "/vendor/purify.js", "/vendor/highlight.js", "/vendor/hljs.css", "/app.js", "/style.css"]) {
  const x = await fetch(base + v.slice(1), { headers: { Cookie: cookie } });
  ok(x.status === 200 && (await x.text()).length > 100, `asset ${v} served locally`);
}
r = await fetch(base + "api/chats", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
ok(r.status === 403, "POST without dashboard header refused");
r = await fetch(base + "api/chats", { method: "POST", headers: { ...H, Origin: "http://evil.example" }, body: "{}" });
ok(r.status === 403, "cross-origin POST refused");
const http = await import("node:http");
const hostStatus = await new Promise((res) => http.get({ host: "127.0.0.1", port: rt.port, path: "/api/state", headers: { Cookie: cookie, Host: "evil.example" } }, (x) => { x.resume(); res(x.statusCode); }));
ok(hostStatus === 421, "foreign Host header refused (DNS rebinding guard)");

// SSE
const events = [];
const ctl = new AbortController();
(async () => {
  const s = await fetch(base + "api/events", { headers: { Cookie: cookie }, signal: ctl.signal });
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of s.body) {
    buf += dec.decode(chunk);
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = (block.match(/^event: (.*)$/m) || [])[1];
      const data = (block.match(/^data: (.*)$/m) || [])[1];
      if (ev) events.push({ ev, data: data ? JSON.parse(data) : null });
    }
  }
})().catch(() => {});
const waitFor = async (pred, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const e = events.find(pred); if (e) return e; await new Promise((r) => setTimeout(r, 50)); } return null; };

const st = await (await fetch(base + "api/state", { headers: H })).json();
ok(st.approvalMode === "onRequest" && st.sandbox === true, "defaults: onRequest approvals, sandbox on");
ok(!!st.projectsDir && path.resolve(st.projectsDir) === path.resolve(process.env.MD_TEST_CHATS), "state exposes the Projects folder for new chats");
const fsl = await (await fetch(base + "api/fs/list?path=" + encodeURIComponent(path.dirname(proj)), { headers: H })).json();
ok(fsl.entries.some((e) => e.path === proj), "folder browser lists project dir");
r = await fetch(base + "api/chats", { method: "POST", headers: H, body: JSON.stringify({ workspace: "relative/path" }) });
ok(r.status === 400, "relative workspace rejected");

const mockState = () => {
  // the mock rewrites this file as it goes; retry a torn read
  for (let i = 0; ; i++) {
    try { return JSON.parse(fs.readFileSync(process.env.MOCK_MUSE_STATE, "utf8")); } catch (e) { if (i > 20) throw e; }
  }
};

// ---- Muse version / update status ----
const upd = await waitFor((e) => e.ev === "muse-status" && e.data.update && e.data.update.state !== "checking", 10000);
let ms = await (await fetch(base + "api/muse/status", { headers: H })).json();
ok(ms.update.state === "updated" && ms.update.from === "9.0.0-R1.1" && ms.update.to === "9.1.0-R2.1", `startup update ran through the launcher hook: ${JSON.stringify(ms.update)}`);
ok(!!upd || ms.update.state === "updated", "update result pushed to the page (muse-status)");

// ---- new chat: naming it creates its Projects/<name> folder, but no Muse session yet ----
const sessionsBefore = Object.keys(mockState()).length;
const draft = await (await fetch(base + "api/chats", { method: "POST", headers: H, body: JSON.stringify({ title: "Snake Game" }) })).json();
ok(!!draft.id && !!draft.workspace && path.basename(draft.workspace) === "snake-game" && path.dirname(draft.workspace) === process.env.MD_TEST_CHATS, "named new chat creates Projects/<chat name> right away: " + draft.workspace);
ok(["AGENTS.md", "MASTER.md", "LOG.md"].every((n) => fs.existsSync(path.join(draft.workspace, n))), "the project folder gets the starter files");
let g = await (await fetch(base + `api/chats/${draft.id}`, { headers: H })).json();
ok(g.draft === true && g.items.length === 0 && g.workspace === draft.workspace, "draft chat opens empty in its project folder");
ok(Object.keys(mockState()).length === sessionsBefore, "no Muse session is created before the first message");

// ---- attachments: uploaded into the chat's own folder ----
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const UP = { Cookie: cookie, "X-Muse-Dashboard": "1" };
const upload = async (id, name, body) => { const x = await fetch(base + `api/chats/${id}/upload?name=${encodeURIComponent(name)}`, { method: "POST", headers: UP, body }); return { status: x.status, ...(await x.json()) }; };
const a1 = await upload(draft.id, "design notes.md", "notes about the design");
ok(a1.status === 200 && a1.relPath === "attachments/design_notes.md" && path.basename(path.dirname(path.dirname(a1.path))) === "snake-game", "upload goes to <chat folder>/attachments: " + a1.relPath);
const a1b = await upload(draft.id, "design notes.md", "notes about the design");
ok(a1b.reused && a1b.path === a1.path, "same name + same content is not saved twice");
const a1c = await upload(draft.id, "design notes.md", "DIFFERENT content");
ok(!a1c.reused && a1c.relPath === "attachments/design_notes-2.md", "name clash with different content gets a suffix: " + a1c.relPath);
const a1d = await upload(draft.id, "design notes.md", "DIFFERENT content");
ok(a1d.reused && a1d.path === a1c.path, "...and that one is also deduped");
const aImg = await upload(draft.id, "shot.png", Buffer.from(png, "base64"));
const evil = await upload(draft.id, "../../evil.txt", "x");
ok(evil.status === 200 && evil.relPath.startsWith("attachments/") && !evil.relPath.includes(".."), "path traversal in upload name neutralised");
ok(Object.keys(mockState()).length === sessionsBefore, "uploading still creates no Muse session");
r = await fetch(base + "api/chats/" + draft.id + "/messages", { method: "POST", headers: H, body: JSON.stringify({ text: "x", paths: ["/etc/hosts"] }) });
ok(r.status === 400, "paths outside the chat are refused");

// ---- first message: folder keeps the name from the popup + lazy session + rekey ----
r = await fetch(base + `api/chats/${draft.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ text: "Build a tiny snake game", paths: [a1.path, aImg.path] }) });
const first = await r.json();
ok(r.status === 200 && first.chatId && first.chatId !== draft.id && first.turnId, "first message starts the Muse session: " + (first.chatId || first.error));
const rk = await waitFor((e) => e.ev === "chat-rekeyed" && e.data.from === draft.id);
ok(rk && rk.data.to === first.chatId, "page told the draft became session " + first.chatId);
const chat = { id: first.chatId };
await waitFor((e) => e.ev === "muse" && e.data.method === "turn/completed" && e.data.sessionId === chat.id);
const ses = mockState()[chat.id];
const projectsDir = process.env.MD_TEST_CHATS;
ok(ses && path.dirname(ses.workspaceRoot) === projectsDir && path.basename(ses.workspaceRoot) === "snake-game", "chat runs in the named project folder from the popup: " + (ses && ses.workspaceRoot));
ok(fs.existsSync(path.join(ses.workspaceRoot, "attachments", "design_notes.md")), "attachments are in the project folder");
const txt = ses.lastTurn.input.find((x) => x.type === "text").text;
ok(txt.startsWith("Build a tiny snake game") && txt.includes("- @attachments/design_notes.md") && txt.includes("- @attachments/shot.png"), "model gets @attachments/... mentions");
ok(ses.lastTurn.input.filter((x) => x.type === "image").length === 1 && ses.lastTurn.input.find((x) => x.type === "image").bytes === Buffer.from(png, "base64").length, "image also sent as a native image part");
ok(/📎 design_notes\.md, shot\.png/.test(ses.lastTurn.displayText), "chat bubble shows the attached names");
g = await (await fetch(base + `api/chats/${chat.id}`, { headers: H })).json();
ok(!g.draft && g.model === "mock-model" && g.workspace === ses.workspaceRoot, "chat reloads with folder + model");
ok(g.items.some((i) => i.kind === "turnSummary" && i.steps === 1 && i.output === 5), "reloaded history has a per-reply step/token summary");
ok(!!events.find((e) => e.ev === "turn-stats" && e.data.sessionId === chat.id && e.data.steps >= 1), "live step/token meter event (turn-stats)");
ok(!!(await waitFor((e) => e.ev === "chat-usage" && e.data.id === chat.id && e.data.tokenUsage?.totalTokens >= 15)), "sidebar gets the chat's new token total (chat-usage)");
ok(!!events.find((e) => e.ev === "usage" && e.data.window?.usedPercent === 12), "subscription usage pushed to the page (usage)");
const usage = await (await fetch(base + "api/usage", { headers: H })).json();
ok(usage.usage?.window?.usedPercent === 12 && usage.usage?.weekly?.usedPercent === 3, "GET /api/usage returns the 5-hour and weekly usage");
const later = await upload(chat.id, "level1.json", "{}");
ok(later.relPath === "attachments/level1.json" && path.dirname(later.path) === path.join(ses.workspaceRoot, "attachments"), "later uploads go to the same chat folder");
r = await fetch(base + `api/chats/${chat.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ workspace: proj }) });
ok(r.status === 409, "folder can't be swapped after the first message");
let lst = await (await fetch(base + "api/chats", { headers: H })).json();
ok(lst.chats[0].id === chat.id && lst.chats[0].autoFolder === true && !lst.chats.some((c) => c.id === draft.id), "new chat is at the top of the list; draft id gone");
ms = await (await fetch(base + "api/muse/status", { headers: H })).json();
ok(ms.host.state === "ready" && ms.host.serverVersion === "9.1.0-R2.1" && ms.host.model === "mock-model", `header info: Muse ${ms.host.serverVersion} · ${ms.host.model}`);

// ---- optional project folder ----
const d2 = await (await fetch(base + "api/chats", { method: "POST", headers: H, body: JSON.stringify({ title: "Project Folder Chat" }) })).json();
r = await fetch(base + `api/chats/${d2.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ workspace: proj }) });
ok(r.status === 200, "draft can point at an existing project folder");
const pu = await upload(d2.id, "spec.txt", "spec");
ok(pu.relPath === `.muse-uploads/${d2.id}/spec.txt` && pu.path === path.join(proj, ".muse-uploads", d2.id, "spec.txt"), "project-folder chat saves into <project>/.muse-uploads/<chat-id>/");
r = await fetch(base + `api/chats/${d2.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ text: "Hello project", paths: [pu.path] }) });
const sp = await r.json();
ok(r.status === 200 && mockState()[sp.chatId].workspaceRoot === proj, "project-folder chat runs in that folder");
await waitFor((e) => e.ev === "muse" && e.data.method === "turn/completed" && e.data.sessionId === sp.chatId);
ok(mockState()[sp.chatId].lastTurn.input[0].text.includes(`- @.muse-uploads/${d2.id}/spec.txt`), "sent as an @mention relative to the project");

// ---- subagents and workflows ----
const P = sp.chatId;
const sendP = async (text) => { const x = await (await fetch(base + `api/chats/${P}/messages`, { method: "POST", headers: H, body: JSON.stringify({ text }) })).json(); await waitFor((e) => e.ev === "muse" && e.data.method === "turn/completed" && e.data.params.turnId === x.turnId); return x; };
let gp = await (await fetch(base + `api/chats/${P}`, { headers: H })).json();
ok(gp.agentMode === "solo" && gp.trust?.trusted === true && gp.trust.via === "folder", "chat reports Agents mode (solo by default) and that its folder is trusted in Muse");
ok(mockState()[P].lastTurn.input[0].text.includes("[Agents: solo]"), "a chat that never picked a mode runs Solo (no subagents)");
const gU = await (await fetch(base + `api/chats/${chat.id}`, { headers: H })).json();
ok(gU.trust?.trusted === false, "a folder Muse does not trust is reported untrusted (no project rules or subagents there)");
r = await fetch(base + `api/chats/${P}`, { method: "PATCH", headers: H, body: JSON.stringify({ agentMode: "swarm" }) });
ok(r.status === 400, "unknown Agents mode rejected");
r = await fetch(base + `api/chats/${P}`, { method: "PATCH", headers: H, body: JSON.stringify({ agentMode: "parallel" }) });
ok(r.status === 200, "Agents mode PATCH accepted");
await sendP("Split this up");
let lt = mockState()[P].lastTurn;
ok(lt.input[0].text.startsWith("Split this up") && lt.input[0].text.includes("[Agents: parallel]") && lt.input[0].text.includes('model "muse-spark-1.3"') && /do not request worktree isolation/i.test(lt.input[0].text), "Parallel adds the split-work instruction for the model (Spark helpers; no isolation outside its own Git repo)");
ok(lt.displayText === "Split this up", "...and the transcript shows only what the user typed");
await fetch(base + `api/chats/${P}`, { method: "PATCH", headers: H, body: JSON.stringify({ agentMode: "solo" }) });
await sendP("Alone please");
ok(mockState()[P].lastTurn.input[0].text.includes("[Agents: solo]"), "Solo tells Muse not to use subagents");
await fetch(base + `api/chats/${P}`, { method: "PATCH", headers: H, body: JSON.stringify({ agentMode: "auto" }) });
await sendP("Your call");
lt = mockState()[P].lastTurn;
ok(lt.input[0].text === "Your call" && lt.displayText === "Your call", "Auto adds nothing: " + JSON.stringify(lt));
let idx = null;
for (let i = 0; i < 30 && idx?.chats?.[P]?.agentMode !== "auto"; i++) { try { idx = JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8")); } catch { /* save in flight */ } await new Promise((res) => setTimeout(res, 50)); }
ok(idx.chats[P].agentMode === "auto", "Agents mode is stored per chat");

// Children that finish: their usage is counted (it is never in the session's own totals).
const tf = await sendP("use agents finish");
const agDone = await waitFor((e) => e.ev === "agent-stats" && e.data.sessionId === P && e.data.turnId === tf.turnId && e.data.count === 3 && e.data.active === 0);
ok(!!agDone && agDone.data.input === 90000 && agDone.data.cached === 54000 && agDone.data.output === 1500, "agent-stats totals one reply's subagents (workflow children counted once): " + JSON.stringify(agDone && agDone.data));
ok(!!(await waitFor((e) => e.ev === "chat-usage" && e.data.id === P && e.data.agentUsage?.input === 90000)), "sidebar total gets the subagents' usage (chat-usage)");
gp = await (await fetch(base + `api/chats/${P}`, { headers: H })).json();
const sumF = gp.items.find((i) => i.kind === "turnSummary" && i.turnId === tf.turnId);
ok(sumF?.agents?.count === 3 && sumF.agents.input === 90000, "reloaded reply summary includes its subagents");
ok(gp.items.some((i) => i.kind === "workflow" && i.status === "completed") && gp.items.filter((i) => i.kind === "subagent").length === 3, "history carries the workflow and its subagent items");

// ---- scheduled jobs (Muse's cron tools): the mock answers like Muse 1.4.13 (no receipts) and runs the job three times ----
const waitAfter = async (from, pred, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const e = events.slice(from).find(pred); if (e) return e; await new Promise((r) => setTimeout(r, 50)); } return null; };
let mark = events.length;
await sendP("schedule check please");
let cronEv = await waitAfter(mark, (e) => e.ev === "cron" && e.data.sessionId === P && e.data.summary && e.data.summary.count === 1);
const job0 = cronEv && cronEv.data.jobs[0];
ok(!!job0 && job0.cron === "* * * * *" && job0.schedule === "every minute" && job0.prompt === "Reply with the single word PING." && job0.approx === true && job0.nextFireAtMs > Date.now() - 60000, "cron_create (Muse 1.4.13 output, no receipt) becomes a job with its schedule, prompt and an estimated next run: " + JSON.stringify(job0));
let gc = await (await fetch(base + `api/chats/${P}`, { headers: H })).json();
ok(gc.cronJobs.length === 1 && gc.cronJobs[0].jobId === job0.jobId, "opening the chat lists its scheduled jobs");
const lc = await (await fetch(base + "api/chats", { headers: H })).json();
ok(lc.chats.find((c) => c.id === P).cron?.count === 1 && lc.chats.find((c) => c.id === P).cron.schedule === "every minute", "the chat list carries the schedule summary for the sidebar");
const woke = await waitAfter(mark, (e) => e.ev === "muse" && e.data.sessionId === P && e.data.params?.item?.kind === "scheduledFire");
ok(!!woke && woke.data.params.item.deliveryNumber === 1 && woke.data.params.item.turnId, "a scheduled run arrives as a scheduledFire item in a turn of its own");
cronEv = await waitAfter(mark, (e) => e.ev === "cron" && e.data.sessionId === P && e.data.jobs[0]?.fires === 1 && e.data.jobs[0].approx === false);
ok(!!cronEv, "the run replaces the estimate with Muse's exact next time and counts the delivery");
cronEv = await waitAfter(mark, (e) => e.ev === "cron" && e.data.sessionId === P && e.data.summary === null, 12000);
ok(!!cronEv && cronEv.data.jobs.length === 0, "a final delivery (no next time) clears the job");
const runNotices = events.slice(mark).filter((e) => e.ev === "app-notice" && e.data.sessionId === P && /scheduled job in this chat has run 2 times \(every minute\)/.test(e.data.message));
ok(runNotices.length === 1, `one notice when a job reaches cronRunWarn runs (${runNotices.length})`);
gc = await (await fetch(base + `api/chats/${P}`, { headers: H })).json();
const runs = gc.items.filter((i) => i.kind === "scheduledFire").map((i) => i.deliveryNumber);
ok(runs.join() === "2,3" && gc.cronJobs.length === 0, `history (newest ${2} turns) shows runs 2 and 3; nothing is scheduled any more (runs ${runs.join()}, jobs ${JSON.stringify(gc.cronJobs)})`);
mark = events.length;
await sendP("schedule check again");
ok(!!(await waitAfter(mark, (e) => e.ev === "cron" && e.data.sessionId === P && e.data.summary?.count === 1)), "a new job can be scheduled after the last one ended");
mark = events.length;
await sendP("cancel job");
cronEv = await waitAfter(mark, (e) => e.ev === "cron" && e.data.sessionId === P && e.data.summary === null);
ok(!!cronEv, "cron_delete (args { id }, output \"Removed scheduled job <id>.\") clears the job");
ok((await (await fetch(base + "api/chats", { headers: H })).json()).chats.find((c) => c.id === P).cron === null, "the chat list no longer shows a schedule");
let lstP = await (await fetch(base + "api/chats", { headers: H })).json();
ok(lstP.chats.find((c) => c.id === P)?.agentUsage?.input === 90000, "chat list row carries the agent totals");
const kid = gp.items.find((i) => i.kind === "subagent" && i.childSessionId);
const tr = await (await fetch(base + `api/chats/${P}/children/${kid.childSessionId}`, { headers: H })).json();
ok(tr.items?.some((i) => i.kind === "agentMessage" && i.text.startsWith("Done:")), "a subagent's own transcript can be read");
r = await fetch(base + `api/chats/${P}/children/${termId}`, { headers: H });
ok(r.status === 404, "only this chat's own subagents can be read");
await new Promise((res) => setTimeout(res, 2100)); // past the session-list cache
lstP = await (await fetch(base + "api/chats?hidden=1", { headers: H })).json();
ok(!lstP.chats.some((c) => c.id === kid.childSessionId), "subagent sessions never show up as chats");

// Children that keep running after the reply: Stop stops them.
const tl = await sendP("use agents linger");
const agLive = await waitFor((e) => e.ev === "agent-stats" && e.data.sessionId === P && e.data.turnId === tl.turnId && e.data.active === 4 && e.data.input > 0);
ok(!!agLive, "children still working after the reply ended are reported (subagent + workflow + its 2 children)");
gp = await (await fetch(base + `api/chats/${P}`, { headers: H })).json();
ok(gp.activeTurnId === null && gp.agentsActive === 4, "reopening the chat shows the working children although no reply runs");
r = await fetch(base + `api/chats/${P}`, { method: "DELETE", headers: H });
ok(r.status === 409, "a chat with working subagents cannot be deleted");
ok(!!(await waitFor((e) => e.ev === "app-notice" && e.data.sessionId === P && /no progress/.test(e.data.message), 10000)), "a working subagent with no progress gets a may-be-stuck notice (agentStallMinutes)");
r = await fetch(base + `api/chats/${P}/interrupt`, { method: "POST", headers: H, body: "{}" });
const stopRes = await r.json();
ok(r.status === 200 && stopRes.agentsStopped >= 2, "Stop stops the children: " + JSON.stringify(stopRes));
const stops = mockState()[P].agentStops || [];
ok(stops.some((x) => x.startsWith("workflow:")) && stops.includes("subagent:subagent-1"), "workflow cancelled and subagent stopped in Muse: " + stops.join(", "));
ok(!!(await waitFor((e) => e.ev === "agent-stats" && e.data.sessionId === P && e.data.active === 0 && e.data.turnId === tl.turnId)), "no children working after Stop");

// Children that keep spending: warned, then stopped at agentTokenLimit.
await sendP("use agents burn");
ok(!!(await waitFor((e) => e.ev === "app-notice" && e.data.sessionId === P && /subagents have read/.test(e.data.message))), "warned at agentTokenWarn");
ok(!!(await waitFor((e) => e.ev === "app-error" && e.data.sessionId === P && /agentTokenLimit/.test(e.data.message), 10000)), "subagents stopped at agentTokenLimit");
const agBurn = await waitFor((e) => e.ev === "agent-stats" && e.data.sessionId === P && e.data.active === 0 && e.data.input >= 600000);
ok(!!agBurn && agBurn.data.input < 1500000, "spending stopped soon after the limit: " + (agBurn && agBurn.data.input));

// ---- model / effort / approval-mode ----
const ml = await (await fetch(base + `api/models?sessionId=${chat.id}`, { headers: H })).json();
ok(ml.models.some((m) => m.modelId === "mock-big") && ml.models.find((m) => m.modelId === "mock-model")?.isActive, "model/list flags the active model");
// A model the connection does not offer (like a subscription-only model on an API key) is refused up front.
r = await fetch(base + `api/chats/${chat.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ modelId: "mock-gone" }) });
ok(r.status === 409 && /mock-gone is not available .*mock-model, mock-big/.test((await r.json()).error), "picking a model the connection does not offer is refused, naming the ones it does");
const goneDraft = await (await fetch(base + "api/chats", { method: "POST", headers: H, body: JSON.stringify({ title: "Gone model", modelId: "mock-gone" }) })).json();
r = await fetch(base + `api/chats/${goneDraft.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ text: "hi" }) });
ok(r.status === 409 && /not available/.test((await r.json()).error), "a chat whose saved model is no longer offered gets a clear error instead of a failed reply");
await fetch(base + `api/chats/${goneDraft.id}?folder=recycle`, { method: "DELETE", headers: H });
r = await fetch(base + `api/chats/${chat.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ modelId: "mock-big", reasoningEffort: "low", approvalMode: "allowAll" }) });
ok(r.status === 200, "model/effort/approval PATCH accepted");
const afterSet = mockState()[chat.id];
ok(afterSet.modelId === "mock-big" && afterSet.reasoningEffort === "low" && afterSet.approvalMode === "allowAll", "host applied model + effort + approval mode");
r = await fetch(base + `api/chats/${chat.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ reasoningEffort: "bogus" }) });
ok(r.status === 400, "unknown effort tier rejected");
const g2 = await (await fetch(base + `api/chats/${chat.id}`, { headers: H })).json();
ok(g2.model === "mock-big" && g2.tokenUsage?.totalTokens >= 15, "chat reload shows new model + token usage");

// ---- per-chat settings: two chats keep different model/effort, persisted on disk ----
r = await fetch(base + `api/chats/${sp.chatId}`, { method: "PATCH", headers: H, body: JSON.stringify({ modelId: "mock-model", reasoningEffort: "high" }) });
ok(r.status === 200, "second chat accepts its own model/effort");
const gA = await (await fetch(base + `api/chats/${chat.id}`, { headers: H })).json();
const gB = await (await fetch(base + `api/chats/${sp.chatId}`, { headers: H })).json();
ok(gA.model === "mock-big" && gA.reasoningEffort === "low", "chat A still shows its own model + effort after chat B changed");
ok(gB.model === "mock-model" && gB.reasoningEffort === "high", "chat B shows its own different model + effort");
let index = null;
for (let i = 0; i < 30 && !index?.chats?.[sp.chatId]?.reasoningEffort; i++) {
  try { index = JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8")); } catch { /* save still in flight */ }
  if (!index?.chats?.[sp.chatId]?.reasoningEffort) await new Promise((res) => setTimeout(res, 50));
}
ok(index.chats[chat.id].modelId === "mock-big" && index.chats[chat.id].reasoningEffort === "low" && index.chats[sp.chatId].modelId === "mock-model" && index.chats[sp.chatId].reasoningEffort === "high", "each chat's model + effort is persisted separately in data/index.json (survives a dashboard restart)");
await fetch(base + `api/chats/${chat.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ approvalMode: "onRequest" }) });

// approval flow
r = await fetch(base + `api/chats/${chat.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ text: "please approve something" }) });
const t2 = await r.json();
const ar = await waitFor((e) => e.ev === "approval-request");
ok(!!ar, "approval card event received");
r = await fetch(base + `api/approvals/${encodeURIComponent(ar.data.key)}`, { method: "POST", headers: H, body: JSON.stringify({ choiceId: "made-up" }) });
ok(r.status === 400, "unoffered choice rejected");
r = await fetch(base + `api/approvals/${encodeURIComponent(ar.data.key)}`, { method: "POST", headers: H, body: JSON.stringify({ choiceId: "allow-once" }) });
ok(r.status === 200, "approve accepted");
ok(!!(await waitFor((e) => e.ev === "muse" && e.data.method === "approval/resolved")), "approval resolved by host");
ok(!!(await waitFor((e) => e.ev === "muse" && e.data.method === "turn/completed" && e.data.params.turnId === t2.turnId)), "turn after approval completed");

// ---- while a reply runs: queue (default), nudge (steer), push (replace), recall (unqueue) ----
// A turn blocked on an approval is a reliably busy reply.
const since = (from, pred, ms = 8000) => { const t = Date.now(); return (async () => { while (Date.now() - t < ms) { const e = events.slice(from).find(pred); if (e) return e; await new Promise((r) => setTimeout(r, 50)); } return null; })(); };
const post = async (text, extra = {}) => (await fetch(base + `api/chats/${chat.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ text, ...extra }) })).json();
let qm = events.length;
const busy1 = await post("please approve something");
const arq = await since(qm, (e) => e.ev === "approval-request");
ok(!!arq && busy1.disposition === "started", "a fresh message starts a turn (disposition started)");
const q1 = await post("queued note");
ok(q1.disposition === "queued" && q1.turnId && q1.turnId !== busy1.turnId, "a message sent while the reply runs is queued by default (disposition queued)");
let qe = await since(qm, (e) => e.ev === "queue-changed" && e.data.sessionId === chat.id && e.data.queued.length === 1);
ok(!!qe && qe.data.queued[0].turnId === q1.turnId && qe.data.queued[0].text === "queued note", "the page is told what is waiting (queue-changed)");
let gq = await (await fetch(base + `api/chats/${chat.id}`, { headers: H })).json();
ok(gq.queued.length === 1 && gq.queued[0].turnId === q1.turnId, "opening the chat lists the waiting message");
ok((await (await fetch(base + "api/chats", { headers: H })).json()).chats.find((c) => c.id === chat.id).queued === 1, "the chat list counts waiting messages");
const n1 = await post("nudge: also mention cats", { ifBusy: "steer" });
ok(n1.disposition === "steered" && n1.turnId === busy1.turnId, "ifBusy steer hands the message to the running turn (disposition steered, same turn)");
const steered = await since(qm, (e) => e.ev === "muse" && e.data.params?.item?.kind === "userMessage" && e.data.params.item.steered === true);
ok(!!steered && steered.data.params.item.text.includes("mention cats"), "the nudge shows as a steered user message in the running turn");
r = await fetch(base + `api/chats/${chat.id}/unqueue`, { method: "POST", headers: H, body: JSON.stringify({ turnId: q1.turnId }) });
ok(r.status === 200 && (await r.json()).queued.length === 0, "unqueue takes a waiting message back");
ok(!!(await since(qm, (e) => e.ev === "muse" && e.data.method === "turn/unqueued" && e.data.params.turnId === q1.turnId)), "Muse reports the reclaimed turn (turn/unqueued)");
r = await fetch(base + `api/chats/${chat.id}/unqueue`, { method: "POST", headers: H, body: JSON.stringify({ turnId: q1.turnId }) });
ok(r.status === 404, "unqueuing it again is refused");
const q2 = await post("second queued");
ok(q2.disposition === "queued", "a second message queues too");
await fetch(base + `api/approvals/${encodeURIComponent(arq.data.key)}`, { method: "POST", headers: H, body: JSON.stringify({ choiceId: "allow-once" }) });
const done1 = await since(qm, (e) => e.ev === "muse" && e.data.method === "turn/completed" && e.data.params.turnId === busy1.turnId);
ok(!!done1, "the busy turn completes after the approval");
ok(!!(await since(qm, (e) => e.ev === "muse" && e.data.method === "turn/started" && e.data.params.turnId === q2.turnId)), "the queued message launches as the next turn");
ok(!!(await since(qm, (e) => e.ev === "queue-changed" && e.data.sessionId === chat.id && e.data.queued.length === 0 && events.indexOf(e) > events.indexOf(done1))), "once launched it is no longer listed as waiting");
ok(!!(await since(qm, (e) => e.ev === "muse" && e.data.method === "turn/completed" && e.data.params.turnId === q2.turnId)), "the queued turn completes");
gq = await (await fetch(base + `api/chats/${chat.id}`, { headers: H })).json();
ok(gq.items.some((i) => i.kind === "userMessage" && i.steered && i.text.includes("mention cats")) && gq.items.some((i) => i.kind === "agentMessage" && i.text.includes("Noted: nudge")), "history keeps the nudge and the reply that took it in");
qm = events.length;
const busy2 = await post("please approve something");
ok(!!(await since(qm, (e) => e.ev === "approval-request")), "another blocked turn");
const push = await post("push this instead", { ifBusy: "replace" });
ok(push.disposition === "started" && push.turnId !== busy2.turnId, "ifBusy replace starts a new turn (disposition started)");
const cut = await since(qm, (e) => e.ev === "muse" && e.data.method === "turn/completed" && e.data.params.turnId === busy2.turnId);
ok(!!cut && cut.data.params.terminal === "cancelled", "the replaced turn ends cancelled");
ok(!!(await since(qm, (e) => e.ev === "muse" && e.data.method === "turn/completed" && e.data.params.turnId === push.turnId)), "the pushed message's turn completes");
// A chat list fetched while a reply ran (its row says "running") must not make Delete refuse once the reply has ended.
{
  const d = await (await fetch(base + "api/chats", { method: "POST", headers: H, body: JSON.stringify({ title: "Busy then gone" }) })).json();
  const from = events.length;
  const sent = await (await fetch(base + `api/chats/${d.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ text: "please approve something" }) })).json();
  const ar2 = await since(from, (e) => e.ev === "approval-request");
  const busyRow = (await (await fetch(base + "api/chats", { headers: H })).json()).chats.find((c) => c.id === sent.chatId);
  ok(!!ar2 && busyRow && busyRow.status === "running", "a list fetched mid-reply says the chat is running");
  await fetch(base + `api/approvals/${encodeURIComponent(ar2.data.key)}`, { method: "POST", headers: H, body: JSON.stringify({ choiceId: "allow-once" }) });
  ok(!!(await since(from, (e) => e.ev === "muse" && e.data.method === "turn/completed" && e.data.params.turnId === sent.turnId)), "its reply ends");
  r = await fetch(base + `api/chats/${sent.chatId}`, { method: "DELETE", headers: H });
  ok(r.status === 200, `Delete right after the reply ends is accepted; the stale list row is not trusted (${r.status})`);
}

// Approve all: the tool runs with no approval card
await fetch(base + `api/chats/${chat.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ approvalMode: "allowAll" }) });
const cardsBefore = events.filter((e) => e.ev === "approval-request").length;
r = await fetch(base + `api/chats/${chat.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ text: "approve again" }) });
const t3 = await r.json();
ok(!!(await waitFor((e) => e.ev === "muse" && e.data.method === "turn/completed" && e.data.params.turnId === t3.turnId)), "Approve-all turn completed");
ok(events.filter((e) => e.ev === "approval-request").length === cardsBefore, "Approve-all turn raised no approval card");
await fetch(base + `api/chats/${chat.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ approvalMode: "onRequest" }) });

// interrupt
r = await fetch(base + `api/chats/${chat.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ text: "long one ".repeat(30) }) });
const t4 = await r.json();
await waitFor((e) => e.ev === "muse" && e.data.method === "turn/started" && e.data.params.turnId === t4.turnId);
r = await fetch(base + `api/chats/${chat.id}/interrupt`, { method: "POST", headers: H, body: "{}" });
ok(r.status === 200, "interrupt accepted");
const c4 = await waitFor((e) => e.ev === "muse" && e.data.method === "turn/completed" && e.data.params.turnId === t4.turnId);
ok(c4 && c4.data.params.terminal === "cancelled", "turn ended cancelled after Stop");

// manual compact
r = await fetch(base + `api/chats/${chat.id}/compact`, { method: "POST", headers: H, body: "{}" });
const comp = await r.json();
ok(r.status === 200 && comp.status === "accepted", "manual compact accepted: " + JSON.stringify(comp));
const compEv = await waitFor((e) => e.ev === "chat-compacted" && e.data.id === chat.id);
ok(!!compEv, "chat-compacted event broadcast");

// step budget: warn at turnStepWarn, stop at turnStepLimit (2 and 3 in this config)
r = await fetch(base + `api/chats/${chat.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ text: "take many steps please" }) });
const t5 = await r.json();
ok(!!(await waitFor((e) => e.ev === "app-notice" && e.data.sessionId === chat.id && /2 model steps/.test(e.data.message))), "warned at turnStepWarn steps");
const c5 = await waitFor((e) => e.ev === "muse" && e.data.method === "turn/completed" && e.data.params.turnId === t5.turnId);
ok(c5 && c5.data.params.terminal === "cancelled" && !!events.find((e) => e.ev === "app-error" && /turnStepLimit/.test(e.data.message)), "reply stopped at turnStepLimit steps");

// history + list + rename + hide
const hist = await (await fetch(base + `api/chats/${chat.id}`, { headers: H })).json();
ok(hist.items.filter((i) => i.kind === "userMessage").length === 2 && !!hist.earlierCursor && hist.items.some((i) => i.kind === "agentMessage" && i.text.includes("Mock Muse")), "chat opens with its newest historyTurns turns and a Load-earlier cursor");
ok(hist.items.some((i) => i.kind === "compaction"), "compacted session shows a compaction item");
let older = [], cur = hist.earlierCursor, emptyPages = 0;
for (let page = 0; cur && page < 10; page++) {
  const e = await (await fetch(base + `api/chats/${chat.id}?before=${encodeURIComponent(cur)}`, { headers: H })).json();
  if (!e.items.length) emptyPages++;
  older = [...e.items, ...older];
  cur = e.earlierCursor;
}
const allUsers = [...older, ...hist.items].filter((i) => i.kind === "userMessage");
// 10 user messages so far: 5 from the earlier sections plus the busy-reply section's two blocked turns, the nudge, the queued one and the push.
ok(allUsers.length === 10 && allUsers[0].text.startsWith("Build a tiny snake game") && new Set(allUsers.map((i) => i.itemId)).size === 10 && emptyPages === 0, `Load earlier pages back to the first message without gaps, repeats or empty pages (${allUsers.length} user messages, ${emptyPages} empty pages)`);

// reading never loads a session: a terminal chat stays unloaded until the user types
const termRow = () => fetch(base + "api/chats?other=1", { headers: H }).then((x) => x.json()).then((l) => l.chats.find((c) => c.id === termId));
const termOpen = await (await fetch(base + `api/chats/${termId}`, { headers: H })).json();
await fetch(base + `api/models?sessionId=${termId}`, { headers: H });
await new Promise((res) => setTimeout(res, 2100)); // past the session-list cache
ok(Array.isArray(termOpen.items) && (await termRow())?.status === "notLoaded", "opening a chat (and its model list) reads history without loading the session");
r = await fetch(base + `api/chats/${termId}/warm`, { method: "POST", headers: H, body: JSON.stringify({ load: true }) });
await new Promise((res) => setTimeout(res, 2500));
const loaded = await termRow();
ok(r.status === 202 && loaded?.status === "idle", "typing (warm with load) loads the session ahead of the send");
r = await fetch(base + "api/restart", { method: "POST", headers: H, body: "{}" });
ok(r.status === 409, "restart refuses when the dashboard was not started by start-dashboard.bat");
await fetch(base + `api/chats/${chat.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ title: "Renamed chat" }) });
let list = await (await fetch(base + "api/chats", { headers: H })).json();
ok(list.chats.some((c) => c.id === chat.id && c.title === "Renamed chat"), "rename shows in list");
await fetch(base + `api/chats/${chat.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ hidden: true }) });
list = await (await fetch(base + "api/chats", { headers: H })).json();
ok(!list.chats.some((c) => c.id === chat.id), "hidden chat removed from list");
list = await (await fetch(base + "api/chats?hidden=1", { headers: H })).json();
ok(list.chats.some((c) => c.id === chat.id && c.hidden), "hidden chat visible with show-hidden");
ok(!list.chats.some((c) => c.id === termId), "a session from outside this dashboard (terminal, another copy) is not in the chat list");
list = await (await fetch(base + "api/chats?other=1", { headers: H })).json();
ok(list.chats.some((c) => c.id === termId && c.other && c.fromTerminal), "with show-other it is listed, marked as from outside");

// ---- Remove (folder kept) vs Delete (Projects folder to the Recycle Bin) ----
const inBin = (dir) => fs.readdirSync(binDir).some((n) => n.startsWith(`${path.basename(dir)}-`));
const remDraft = await (await fetch(base + "api/chats", { method: "POST", headers: H, body: JSON.stringify({ title: "Remove Me" }) })).json();
r = await fetch(base + `api/chats/${remDraft.id}`, { method: "DELETE", headers: H });
const remRes = await r.json();
ok(r.status === 200 && remRes.keptFolder === remDraft.workspace && !remRes.deletedFolder && fs.existsSync(path.join(remDraft.workspace, "MASTER.md")), "Remove takes the chat off the dashboard and keeps its folder and files");
const delDraft = await (await fetch(base + "api/chats", { method: "POST", headers: H, body: JSON.stringify({ title: "Delete Me" }) })).json();
ok(fs.existsSync(delDraft.workspace), "delete-test draft folder exists before delete");
const check = await (await fetch(base + `api/chats/${delDraft.id}/delete-check`, { headers: H })).json();
ok(check.folder === delDraft.workspace && check.bin === "fits" && check.files === 3 && check.bytes > 0, "delete-check reports the Projects folder's size and that the Recycle Bin can keep it: " + JSON.stringify(check));
r = await fetch(base + `api/chats/${delDraft.id}?folder=delete`, { method: "DELETE", headers: H });
ok(r.status === 400 && fs.existsSync(delDraft.workspace), "the old permanent ?folder=delete is gone");
r = await fetch(base + `api/chats/${delDraft.id}?folder=recycle`, { method: "DELETE", headers: H });
const delDraftRes = await r.json();
ok(r.status === 200 && delDraftRes.deletedFolder === delDraft.workspace && delDraftRes.inBin === true && !fs.existsSync(delDraft.workspace) && inBin(delDraft.workspace), "Delete moves a named draft's Projects folder to the Recycle Bin");
r = await fetch(base + `api/chats/${chat.id}?folder=recycle`, { method: "DELETE", headers: H });
const delRes = await r.json();
ok(r.status === 200 && delRes.deletedFolder === ses.workspaceRoot && delRes.inBin && !fs.existsSync(ses.workspaceRoot) && inBin(ses.workspaceRoot), "Delete moves a chat's Projects folder to the Recycle Bin: " + JSON.stringify(delRes));
list = await (await fetch(base + "api/chats?hidden=1", { headers: H })).json();
ok(![chat.id, delDraft.id, remDraft.id].some((id) => list.chats.some((c) => c.id === id)), "removed and deleted chats do not reappear, even with show-hidden on");

// ---- Open folder: an existing folder, optional starter files, Delete safety ----
const picked = path.join(T, "picked-project");
fs.mkdirSync(path.join(picked, ".git", "objects"), { recursive: true });
fs.writeFileSync(path.join(picked, "game.js"), "console.log('hi')");
fs.writeFileSync(path.join(picked, ".git", "objects", "pack"), "x");
fs.chmodSync(path.join(picked, ".git", "objects", "pack"), 0o444); // Git's objects are read-only on Windows
let info = await (await fetch(base + `api/fs/info?path=${encodeURIComponent(picked)}`, { headers: H })).json();
ok(info.name === "picked-project" && info.hasAgents === false && info.missingStarterFiles.join() === "AGENTS.md,MASTER.md,LOG.md" && info.usedBy.length === 0, "folder info reports the name and the missing starter files: " + JSON.stringify(info));
// Folders named in a first message ("the game located here: C:\... The ...") are found even with spaces in the path.
const spaced = path.join(T, "My Game Folder");
fs.mkdirSync(path.join(spaced, "src"), { recursive: true });
fs.writeFileSync(path.join(spaced, "src", "main.js"), "//");
const mentioned = async (text) => (await (await fetch(base + "api/fs/mentioned", { method: "POST", headers: H, body: JSON.stringify({ text }) })).json()).folders.map((f) => f.path);
let found = await mentioned(`Ok, for this game located here: ${spaced}. The graphics look bad, overhaul it.`);
ok(found.length === 1 && found[0] === fs.realpathSync(spaced), "a folder with spaces named mid-sentence is found: " + JSON.stringify(found));
found = await mentioned(`Fix ${path.join(spaced, "src", "main.js")} please`);
ok(found.length === 1 && found[0] === fs.realpathSync(path.join(spaced, "src")), "a named file resolves to its folder: " + JSON.stringify(found));
found = await mentioned(`See ${path.join(T, "no-such-dir", "x")} and ${os.homedir()} and ${path.parse(T).root}`);
ok(found.length === 0, "missing paths, the home folder and drive roots are not offered: " + JSON.stringify(found));
found = await mentioned(`Add ${path.join(spaced, "src", "new-level.js")} for the boss fight.`);
ok(found.length === 1 && found[0] === fs.realpathSync(path.join(spaced, "src")), "a file not created yet resolves to its existing folder: " + JSON.stringify(found));
const hostArgs = fs.readFileSync(`${process.env.MOCK_MUSE_STATE}.hosts`, "utf8");
ok(/run\.developer_prompt=.*Quality and accuracy come first/.test(hostArgs), "muse serve gets EXECUTION-POLICY.md as run.developer_prompt");
const open1 = await (await fetch(base + "api/chats", { method: "POST", headers: H, body: JSON.stringify({ title: "Picked", workspace: picked, seedProjectFiles: true }) })).json();
ok(open1.workspace === fs.realpathSync(picked) && !open1.autoFolder, "a chat can open an existing folder");
ok(["AGENTS.md", "MASTER.md", "LOG.md"].every((n) => fs.existsSync(path.join(picked, n))) && fs.readFileSync(path.join(picked, "game.js"), "utf8") === "console.log('hi')", "seedProjectFiles adds the starter files and leaves the user's files alone");
const open2 = await (await fetch(base + "api/chats", { method: "POST", headers: H, body: JSON.stringify({ title: "Picked again", workspace: picked }) })).json();
info = await (await fetch(base + `api/fs/info?path=${encodeURIComponent(picked)}`, { headers: H })).json();
ok(info.hasAgents === true && info.usedBy.includes("Picked") && info.usedBy.includes("Picked again"), "folder info lists the chats that already use the folder");
// Folders opened from outside Projects are never deleted: the menu has no Delete, and the server refuses it.
let rows = (await (await fetch(base + "api/chats", { headers: H })).json()).chats;
ok(rows.find((c) => c.id === open1.id)?.inProjects === false, "a picked folder outside Projects is marked as not deletable");
const pickedCheck = await (await fetch(base + `api/chats/${open1.id}/delete-check`, { headers: H })).json();
ok(/not inside the dashboard's Projects folder/.test(pickedCheck.block || ""), "delete-check refuses a folder outside Projects");
r = await fetch(base + `api/chats/${open2.id}`, { method: "DELETE", headers: H });
ok(r.status === 200 && fs.existsSync(path.join(picked, "game.js")), "Remove of a picked-folder chat keeps the folder");
r = await fetch(base + `api/chats/${open1.id}?folder=recycle`, { method: "DELETE", headers: H });
ok(r.status === 409 && /never deletes folders opened from elsewhere/.test((await r.json()).error) && fs.existsSync(path.join(picked, "game.js")), "Delete refuses the picked folder even as its last chat; the folder and chat stay");
r = await fetch(base + `api/chats/${open1.id}`, { method: "DELETE", headers: H });
ok(r.status === 200 && fs.existsSync(path.join(picked, "game.js")), "Remove takes that chat off and keeps the folder");
const wide = await (await fetch(base + "api/chats", { method: "POST", headers: H, body: JSON.stringify({ title: "Too wide", workspace: T }) })).json();
r = await fetch(base + `api/chats/${wide.id}?folder=recycle`, { method: "DELETE", headers: H });
ok(r.status === 409 && fs.existsSync(dataDir), "Delete refuses a folder that contains the Projects or data folder");
await fetch(base + `api/chats/${wide.id}`, { method: "DELETE", headers: H });
// Inside Projects, a folder another chat still uses is kept.
const shared1 = await (await fetch(base + "api/chats", { method: "POST", headers: H, body: JSON.stringify({ title: "Shared One" }) })).json();
const shared2 = await (await fetch(base + "api/chats", { method: "POST", headers: H, body: JSON.stringify({ title: "Shared Two", workspace: shared1.workspace }) })).json();
rows = (await (await fetch(base + "api/chats", { headers: H })).json()).chats;
ok(rows.find((c) => c.id === shared2.id)?.inProjects === true, "a chat working in a Projects folder is marked deletable");
r = await fetch(base + `api/chats/${shared1.id}?folder=recycle`, { method: "DELETE", headers: H });
ok(r.status === 409 && /also uses it/.test((await r.json()).error) && fs.existsSync(shared1.workspace), "Delete refuses a Projects folder another chat still uses");
await fetch(base + `api/chats/${shared2.id}`, { method: "DELETE", headers: H });
r = await fetch(base + `api/chats/${shared1.id}?folder=recycle`, { method: "DELETE", headers: H });
ok(r.status === 200 && !fs.existsSync(shared1.workspace) && inBin(shared1.workspace), "once no other chat uses it, Delete moves it to the Recycle Bin");
// Switching a fresh draft to an existing folder drops its unused Projects folder.
const sw = await (await fetch(base + "api/chats", { method: "POST", headers: H, body: JSON.stringify({ title: "Switch Me" }) })).json();
r = await fetch(base + `api/chats/${sw.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ workspace: proj }) });
ok(r.status === 200 && !fs.existsSync(sw.workspace) && fs.existsSync(proj), "a draft switched to an existing folder leaves no empty Projects folder behind");
await fetch(base + `api/chats/${sw.id}`, { method: "DELETE", headers: H });

// ---- Trust this folder ----
const trustDir = path.join(T, "trust-me");
fs.mkdirSync(trustDir);
const tChat = await (await fetch(base + "api/chats", { method: "POST", headers: H, body: JSON.stringify({ title: "Trust", workspace: trustDir }) })).json();
let tg = await (await fetch(base + `api/chats/${tChat.id}`, { headers: H })).json();
ok(tg.trust && tg.trust.trusted === false, "a picked folder outside the trusted ones starts untrusted");
r = await fetch(base + `api/chats/${tChat.id}/trust`, { method: "POST", headers: H, body: "{}" });
const tRes = await r.json();
const trustJson = JSON.parse(fs.readFileSync(path.join(cfgHome, "muse", "trust.json"), "utf8"));
const trustKeys = Object.keys(trustJson.projects);
ok(r.status === 200 && tRes.trust.trusted === true && tRes.appliesToThisChat === true, "Trust marks the draft's folder trusted, in time for its first message");
ok(trustKeys.includes(proj) && trustKeys.some((k) => k.endsWith(fs.realpathSync(trustDir)) && (process.platform !== "win32" || k.startsWith("\\\\?\\"))) && trustJson.schema_version === 1, "trust.json keeps its other entries and gets Muse's own key format: " + JSON.stringify(trustKeys));
tg = await (await fetch(base + `api/chats/${tChat.id}`, { headers: H })).json();
ok(tg.trust.trusted === true, "the chat reports the folder as trusted afterwards");
await fetch(base + `api/chats/${tChat.id}`, { method: "DELETE", headers: H });

// ---- Snapshot before Muse, and Undo ----
let hasGit = true;
try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { hasGit = false; }
if (hasGit) {
  const snapDir = path.join(T, "snap-me");
  fs.mkdirSync(snapDir);
  fs.writeFileSync(path.join(snapDir, "keep.txt"), "original\r\n");
  info = await (await fetch(base + `api/fs/info?path=${encodeURIComponent(snapDir)}`, { headers: H })).json();
  ok(info.git?.available === true && info.git.repo === false, "folder info says the folder is not tracked by Git (snapshot is offered)");
  const sChat = await (await fetch(base + "api/chats", { method: "POST", headers: H, body: JSON.stringify({ title: "Snap", workspace: snapDir, snapshot: true }) })).json();
  ok(sChat.snapshot?.files === 1 && sChat.snapshot.createdRepo === true && !sChat.snapshotError, "Open folder with snapshot saves one: " + JSON.stringify(sChat.snapshot || sChat.snapshotError));
  list = await (await fetch(base + "api/chats", { headers: H })).json();
  ok(!!list.chats.find((c) => c.id === sChat.id)?.snapshotAt, "the chat list says the chat has a snapshot (for the Undo menu item)");
  fs.writeFileSync(path.join(snapDir, "keep.txt"), "muse changed this");
  fs.writeFileSync(path.join(snapDir, "added.txt"), "muse added this");
  r = await fetch(base + `api/chats/${sChat.id}/undo-snapshot`, { method: "POST", headers: H, body: "{}" });
  const undo = await r.json();
  ok(r.status === 200 && undo.restored === 1 && undo.removed === 1 && fs.readFileSync(path.join(snapDir, "keep.txt"), "utf8") === "original\r\n" && !fs.existsSync(path.join(snapDir, "added.txt")), "Undo puts the folder back to the snapshot: " + JSON.stringify(undo));
  r = await fetch(base + `api/chats/${tChat.id}/undo-snapshot`, { method: "POST", headers: H, body: "{}" });
  ok(r.status === 409 || r.status === 410, "Undo without a snapshot is refused");
  await fetch(base + `api/chats/${sChat.id}`, { method: "DELETE", headers: H });
} else console.log("SKIP snapshot checks: git is not installed");
r = await fetch(base + `api/chats/${chat.id}`, { headers: H });
ok(r.status === 410, "opening a deleted chat is refused (410)");

// ---- cost estimates (API plans): token spend per folder, priced from Meta's catalog and the user's table; only API-key use is money ----
{
  const rowP = async () => (await (await fetch(base + "api/chats", { headers: H })).json()).chats.find((c) => c.id === P);
  const conn = await (await fetch(base + "api/connection", { headers: H })).json();
  ok(conn.via === "env" && conn.envKey === true, "the test dashboard runs on the environment API key (billable mode)");
  let pr = await (await fetch(base + "api/prices", { headers: H })).json();
  ok(pr.enabled === true && Array.isArray(pr.catalog) && pr.catalog.includes("mock-model"), "estimates start on (Muse's catalog supplies prices) and the table lists the models the connection offers: " + JSON.stringify(pr.catalog));
  r = await fetch(base + "api/prices", { method: "POST", headers: H, body: JSON.stringify({ enabled: false, models: {} }) });
  ok(r.status === 200 && (await (await fetch(base + "api/spend", { headers: H })).json()).totals === null, "switched off: no totals");
  ok(pr.catalogPrices && pr.catalogPrices["mock-model"].output === 2 && pr.catalogPrices["mock-model"].cached === 0.1 && !pr.catalogPrices["mock-big"] && !!pr.catalogAt, "the prices Muse reports from the catalog are remembered (cost blocks only): " + JSON.stringify(pr.catalogPrices));
  ok((await rowP()).folderCost === null, "no estimate while the table is off");
  r = await fetch(base + "api/prices", { method: "POST", headers: H, body: JSON.stringify({ enabled: true, models: { "mock-model": { input: "abc" } } }) });
  ok(r.status === 400 && /mock-model: input price/.test((await r.json()).error || ""), "a bad price is refused with the model and field named");
  r = await fetch(base + "api/prices", { method: "POST", headers: H, body: JSON.stringify({ enabled: true, models: { "mock-model": { input: 1, cached: 0.1, output: 2 } } }) });
  pr = await r.json();
  ok(r.status === 200 && pr.enabled && pr.models["mock-model"].output === 2 && !!pr.updatedAt, "prices save with a date stamp");
  let row = await rowP();
  // The agents section's helper usage was recorded under the configured helper model, which has no price here: partial, with mock-model itself priced.
  ok(row.folderCost && row.folderCost.usd > 0 && row.folderCost.tokens.api[0] >= 10 && row.folderKey && !row.folderCost.missing.includes("mock-model") && row.folderCost.models["mock-model"].usd > 0, "once on, the chat's folder shows an estimate from the steps recorded so far: " + JSON.stringify(row.folderCost && { usd: row.folderCost.usd, missing: row.folderCost.missing, tokens: row.folderCost.tokens }));
  const before = row.folderCost;
  let mark = events.length;
  await sendP("spend a little");
  const sp = await waitAfter(mark, (e) => e.ev === "spend" && e.data.key === row.folderKey);
  ok(!!sp && sp.data.cost.usd > before.usd && Math.abs(sp.data.cost.usd - before.usd - (10 / 1e6) * 1 - (5 / 1e6) * 2) < 1e-12, "each step adds its tokens (10 fresh in, 5 out) at the table's prices and the page is told (spend)");
  const tot = (await (await fetch(base + "api/spend", { headers: H })).json()).totals;
  ok(sp.data.totals && sp.data.totals.usd >= sp.data.cost.usd && tot && tot.usd === sp.data.totals.usd && tot.tokens.api[0] >= sp.data.cost.tokens.api[0], "the sidebar Total sums every project folder and is never below one folder's estimate: " + JSON.stringify({ total: tot && tot.usd, folder: sp.data.cost.usd }));
  const gP = await (await fetch(base + `api/chats/${P}`, { headers: H })).json();
  ok(gP.folderKey === row.folderKey && gP.folderCost.usd === sp.data.cost.usd && gP.folderCost.models["mock-model"], "opening the chat carries the folder estimate with a per-model breakdown");
  // Subscription: tokens are still counted, but no dollar figure is shown anywhere (a flat fee)
  const apiBefore = sp.data.cost;
  mark = events.length;
  r = await fetch(base + "api/connection/mode", { method: "POST", headers: H, body: JSON.stringify({ mode: "subscription" }) });
  ok(r.status === 200, "switched to the subscription");
  ok((await rowP()).folderCost === null && (await (await fetch(base + "api/spend", { headers: H })).json()).totals === null && !!(await waitAfter(mark, (e) => e.ev === "prices-changed")), "on the subscription no folder shows a dollar figure, the box has no total, and the page is told to redraw");
  mark = events.length;
  await sendP("spend on the subscription");
  const sp2 = await waitAfter(mark, (e) => e.ev === "spend" && e.data.key === row.folderKey);
  ok(!!sp2 && sp2.data.cost === null && sp2.data.totals === null, "a subscription step is recorded but priced at nothing");
  r = await fetch(base + "api/connection/mode", { method: "POST", headers: H, body: JSON.stringify({ mode: "env" }) });
  ok(r.status === 200, "back on the environment key");
  row = await rowP();
  ok(row.folderCost && row.folderCost.usd === apiBefore.usd && row.folderCost.tokens.sub[0] >= 10 && row.folderCost.tokens.sub[0] > apiBefore.tokens.sub[0], "back on the key the folder shows the same dollars, with the subscription tokens counted apart");
  mark = events.length;
  // Nothing typed: Muse's catalog prices are used; a typed number overrides field by field
  r = await fetch(base + "api/prices", { method: "POST", headers: H, body: JSON.stringify({ enabled: true, models: {} }) });
  row = await rowP();
  const catUsd = row.folderCost && row.folderCost.models["mock-model"].usd;
  ok(row.folderCost && catUsd > 0 && !row.folderCost.missing.includes("mock-model"), "with nothing typed, mock-model is priced from the catalog prices Muse reported");
  r = await fetch(base + "api/prices", { method: "POST", headers: H, body: JSON.stringify({ enabled: true, models: { "mock-model": { input: 10 } } }) });
  row = await rowP();
  const mm = row.folderCost.models["mock-model"];
  ok(mm.usd > catUsd && Math.abs(mm.usd - catUsd - (mm.tokens[0] / 1e6) * 9) < 1e-9, "a typed input price overrides the catalog's; cached and output still follow the catalog");
  r = await fetch(base + "api/prices", { method: "POST", headers: H, body: JSON.stringify({ enabled: false, models: { "mock-model": { input: 1, cached: 0.1, output: 2 } } }) });
  ok((await rowP()).folderCost === null && !!(await waitAfter(mark, (e) => e.ev === "prices-changed")), "unticking the box hides the estimates (prices kept) and tells the page");
}

// ---- Muse preset switch: miniswe on by default, off = Muse's default preset, applied at the next host start ----
{
  const hosts = () => fs.readFileSync(`${process.env.MOCK_MUSE_STATE}.hosts`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  ok(hosts()[0].slice(0, 3).join(" ") === "serve --preset miniswe" && hosts()[0].includes('tools.web_search.mode="off"'), "the host starts with `serve --preset miniswe` by default, with web search off (the preset has no web tools): " + JSON.stringify(hosts()[0].slice(0, 5)));
  ok((await (await fetch(base + "api/state", { headers: H })).json()).musePreset === "miniswe", "state reports the preset");
  const mark = events.length;
  r = await fetch(base + "api/settings/preset", { method: "POST", headers: H, body: JSON.stringify({ miniswe: false }) });
  const pr = await r.json();
  ok(r.status === 200 && pr.musePreset === null, "switching miniswe off is accepted");
  ok(!!(await waitAfter(mark, (e) => e.ev === "muse-restarted" && e.data.reason === "preset")), "the idle host is restarted for the preset change");
  await sendP("hello default preset");
  const last = hosts()[hosts().length - 1];
  ok(hosts().length >= 2 && !last.includes("--preset"), "the next host starts without --preset: " + JSON.stringify(last.slice(0, 3)));
  ok(JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8")).settings.musePreset === null, "the choice is saved for the next dashboard start");
  r = await fetch(base + "api/settings/preset", { method: "POST", headers: H, body: JSON.stringify({ miniswe: true }) });
  ok((await r.json()).musePreset === "miniswe", "and can be switched back on");
}

ctl.abort();
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
