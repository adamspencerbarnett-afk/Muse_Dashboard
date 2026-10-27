// Muse Dashboard · test/sessions.mjs
// Author: Adam S. Barnett
//
// MuseHosts session lifecycle against mock/mock-muse.mjs (no dashboard server):
// unloading and reloading a session must not duplicate approval requests, the
// idle trim must never unload a session a command is about to use, and history
// must not offer "Load earlier" when nothing older is left to show.
// Usage: node test/sessions.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MuseHosts } from "../lib/muse.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { failN++; console.log("FAIL", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 5000) => { for (let t = Date.now(); Date.now() - t < ms && !cond();) await sleep(50); return cond(); };

async function withHosts(extra, fn) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), "mdsessions-"));
  process.env.MOCK_MUSE_STATE = path.join(T, "state.json");
  const ws = path.join(T, "ws");
  fs.mkdirSync(ws);
  const events = [];
  const config = { museBin: process.execPath, museArgs: [path.join(APP, "mock", "mock-muse.mjs")], approvalMode: "onRequest", hostCwd: T, sharedHost: true, ...extra };
  const muse = new MuseHosts({ config, store: { chat: () => null }, emit: (type, payload) => events.push({ type, payload }) });
  try { await fn(muse, ws, events); } finally {
    await muse.closeAll(2000);
    fs.rmSync(T, { recursive: true, force: true });
  }
}
const completed = (events, id) => events.some((e) => e.type === "muse" && e.payload.sessionId === id && e.payload.method === "turn/completed");

try {
  await withHosts({}, async (muse, ws, events) => {
    const { sessionId } = await muse.startChat(ws);
    for (let i = 0; i < 2; i++) { await muse.unload(sessionId); await muse.ensureLoaded(sessionId, ws); }
    await muse.send(sessionId, ws, { input: [{ type: "text", text: "please approve" }] });
    await until(() => events.some((e) => e.type === "approval-request"));
    await sleep(300);
    const reqs = events.filter((e) => e.type === "approval-request");
    ok(reqs.length === 1, `an approval after two unload/reload cycles is asked once (asked ${reqs.length}x)`);
    if (reqs.length) muse.decide(reqs[0].payload.key, "allow-once");
    ok(await until(() => completed(events, sessionId)), "the turn completes after the approval");
  });

  await withHosts({ maxLoadedSessions: 1 }, async (muse, ws, events) => {
    const A = (await muse.startChat(ws)).sessionId;
    await muse.send(A, ws, { input: [{ type: "text", text: "please approve" }] });
    await until(() => muse.pendingApprovals(A).length > 0);
    const B = (await muse.startChat(ws)).sessionId;
    await muse.unload(B);
    await muse.send(B, ws, { input: [{ type: "text", text: "hello" }] });
    ok(await until(() => completed(events, B)), "over maxLoadedSessions, a session just loaded for a send is not unloaded (its turn streams to completion)");
    ok(muse.pendingApprovals(A).length === 1, "the session waiting on an approval stays loaded");
  });

  await withHosts({}, async (muse, ws, events) => {
    const { sessionId } = await muse.startChat(ws);
    await muse.setApprovalMode(sessionId, ws, "allowAll"); // session setup events before the first turn
    for (const text of ["one", "two"]) {
      const n = events.length;
      await muse.send(sessionId, ws, { input: [{ type: "text", text }] });
      await until(() => events.slice(n).some((e) => e.type === "muse" && e.payload.method === "turn/completed"));
    }
    const h = await muse.readHistory(sessionId, ws, { turns: 2 });
    ok(h.items.filter((i) => i.kind === "userMessage").length === 2 && h.earlierCursor === null, "a chat with exactly historyTurns turns offers no empty \"Load earlier\"");
    ok((await muse.readHistory(sessionId, ws, { turns: 2 })) === h, "re-reading an unchanged view is served from the cache");
    const h1 = await muse.readHistory(sessionId, ws, { turns: 1 });
    const e = h1.earlierCursor ? await muse.readHistory(sessionId, ws, { turns: 1, before: h1.earlierCursor }) : null;
    ok(!!e && e.items.some((i) => i.kind === "userMessage" && i.text === "one") && e.earlierCursor === null, "\"Load earlier\" returns the older turn, then nothing further");
  });
} catch (e) {
  failN++;
  console.log("FAIL exception", e);
}
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
