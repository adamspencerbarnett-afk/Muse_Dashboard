// Muse Dashboard · test/cron.mjs
// Author: Adam S. Barnett
//
// Unit checks for lib/cron.js: folding Muse's cron tool calls (receipt or
// Muse 1.4.13 output) and scheduledFire items into one job record each, the
// words for a schedule, and the next-run estimate from a cron expression.
// Usage: node test/cron.mjs   (npm run test:cron)
import { isCronItem, foldCronItem, cronRows, cronSummary, describeCron, nextCronMatch } from "../lib/cron.js";

let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { failN++; console.log("FAIL", m); } };

const T0 = Date.parse("2026-10-27T10:00:00Z");
const at = (s) => new Date(T0 + s * 1000).toISOString();
const receipt = (operation, outcome, details) => ({ family: "cron", operation, outcome, details });
const ARGS = JSON.stringify({ cron: "*/5 * * * *", prompt: "check the build", recurring: true, fire_when_active_run: false });
const create = (jobId, nextFireAtMs, extra = {}) => ({ itemId: `c-${jobId}`, kind: "toolCall", status: "completed", tool: "cron_create", recordedAt: at(0), args: ARGS, toolReceipt: receipt("create", "created", { jobId, nextFireAtMs }), ...extra });

ok(isCronItem(create("j1", 1)) && isCronItem({ kind: "scheduledFire", jobId: "j1" }) && !isCronItem({ kind: "toolCall", tool: "shell" }) && !isCronItem(null), "cron items: the three cron tools and scheduledFire, nothing else");

// create, with a receipt
let jobs = foldCronItem({}, create("j1", T0 + 300000));
ok(jobs && jobs.j1 && jobs.j1.cron === "*/5 * * * *" && jobs.j1.prompt === "check the build" && jobs.j1.recurring === true && jobs.j1.nextFireAtMs === T0 + 300000 && jobs.j1.approx === false && jobs.j1.fires === 0, "cron_create (receipt) adds the job with its schedule, prompt and exact next run");
ok(foldCronItem({}, create("j1", 1, { status: "inProgress" })) === null && foldCronItem({}, create("j1", 1, { status: "failed" })) === null, "a running or failed create records nothing");
ok(foldCronItem({}, { ...create("j1", 1), toolReceipt: receipt("create", "rejected", {}) }) === null, "a rejected create records nothing");

// create, as Muse 1.4.13 reports it (no receipt: the id is in the output, the time is estimated)
const raw = foldCronItem({}, { itemId: "c-raw", kind: "toolCall", status: "completed", tool: "cron_create", recordedAt: at(0), args: ARGS, visibleOutput: "Scheduled a7047f26 (Every 5 minutes, skips while a run is active)" });
ok(raw && raw.a7047f26 && raw.a7047f26.prompt === "check the build" && raw.a7047f26.approx === true && raw.a7047f26.nextFireAtMs === nextCronMatch("*/5 * * * *", T0), "cron_create (output only) takes the id from \"Scheduled <id>\" and estimates the first run from the cron expression");
ok(foldCronItem({}, { itemId: "c-x", kind: "toolCall", status: "completed", tool: "cron_create", args: ARGS, visibleOutput: "cron fields: invalid" }) === null, "a create whose output names no job records nothing");

// fire
const fire = (n, next, when = n * 300 + 1) => ({ itemId: `f${n}`, kind: "scheduledFire", status: "completed", jobId: "j1", deliveryNumber: n, scheduledFireAtMs: T0 + n * 300000, nextFireAtMs: next, recordedAt: at(when) });
let j2 = foldCronItem(jobs, fire(1, T0 + 600000));
ok(j2.j1.fires === 1 && j2.j1.lastFiredAtMs === T0 + 300000 && j2.j1.nextFireAtMs === T0 + 600000 && j2.j1.approx === false && j2.j1.prompt === "check the build", "a run moves the next time forward and counts the delivery, keeping the prompt");
ok(jobs.j1.fires === 0, "folding never mutates the previous map");
ok(foldCronItem(j2, fire(1, T0 + 600000, 0)) === null, "an older fact than the one recorded is ignored");
const fin = foldCronItem(j2, { ...fire(2, undefined), nextFireAtMs: undefined });
ok(fin && !fin.j1, "a final delivery (no next time) removes the job");
ok(foldCronItem({}, fire(3, T0)).j1.fires === 3, "a run of a job never seen (scheduled from a terminal) still creates its record");
const est = foldCronItem(raw, { ...fire(1, T0 + 600000), jobId: "a7047f26" });
ok(est.a7047f26.approx === false && est.a7047f26.nextFireAtMs === T0 + 600000, "the first run replaces the estimate with Muse's exact next time");

// delete
const del = (id, outcome = "deleted", when = 400) => ({ itemId: `d-${id}`, kind: "toolCall", status: "completed", tool: "cron_delete", args: JSON.stringify({ id }), toolReceipt: receipt("delete", outcome, { jobId: id }), recordedAt: at(when) });
ok(!foldCronItem(j2, del("j1")).j1, "cron_delete removes the job");
ok(foldCronItem(j2, del("other")) === null, "deleting an unknown job changes nothing");
ok(!foldCronItem(j2, del("j1", "missing")).j1, "a job Muse no longer has (missing) is dropped too");
ok(!foldCronItem(j2, { ...del("j1"), toolReceipt: undefined }).j1 && !foldCronItem(j2, { ...del("j1"), toolReceipt: undefined, args: "{}", visibleOutput: "Removed scheduled job j1." }).j1, "without a receipt the id comes from the arguments, else from Muse's \"Removed scheduled job <id>.\"");

// list
const list = (rows, when = 3) => ({ itemId: `l${when}`, kind: "toolCall", status: "completed", tool: "cron_list", args: "{}", toolReceipt: receipt("list", "listed", { jobs: rows }), recordedAt: at(when) });
let three = foldCronItem(foldCronItem(jobs, { ...create("j2", T0 + 60000), itemId: "c-j2" }), { ...create("j3", T0 + 120000), itemId: "c-j3" });
const listed = foldCronItem(three, list([{ jobId: "j1", nextFireAtMs: T0 + 900000 }, { jobId: "j9", nextFireAtMs: T0 + 5000 }]));
ok(listed && Object.keys(listed).sort().join() === "j1,j9" && listed.j1.nextFireAtMs === T0 + 900000 && listed.j1.prompt === "check the build" && listed.j9.prompt === undefined, "cron_list is authoritative: unlisted jobs go, listed ones are updated or added");
ok(foldCronItem(listed, list([{ jobId: "j1", nextFireAtMs: T0 + 900000 }, { jobId: "j9", nextFireAtMs: T0 + 5000 }], 3)) === null, "the same listing again changes nothing");
const newer = foldCronItem(listed, { ...create("j7", T0 + 1000), itemId: "c-j7", recordedAt: at(10) });
ok(foldCronItem(newer, list([{ jobId: "j1", nextFireAtMs: T0 + 900000 }], 4)).j7, "a job created after a listing survives that (older) listing");
ok(Object.keys(foldCronItem(listed, list([], 5))).length === 0, "an empty listing clears every job");
const rawList = foldCronItem(raw, { itemId: "l-raw", kind: "toolCall", status: "completed", tool: "cron_list", args: "{}", recordedAt: at(2), visibleOutput: JSON.stringify({ jobs: [{ id: "a7047f26", cron: "*/5 * * * *", schedule: "Every 5 minutes", prompt: "check the build", recurring: true, fire_when_active_run: false, permanent: false, next_fire_at_ms: T0 + 299572, last_fired_at_ms: null, fire_count: 0 }] }) });
ok(rawList && rawList.a7047f26.nextFireAtMs === T0 + 299572 && rawList.a7047f26.approx === false && rawList.a7047f26.permanent === false, "cron_list (output JSON) gives the exact next time, replacing the estimate");

// rows and summary
const rows = cronRows(listed);
ok(rows.map((j) => j.jobId).join() === "j9,j1" && rows[1].schedule === "every 5 min" && cronSummary(listed).count === 2 && cronSummary(listed).nextFireAtMs === T0 + 5000 && cronSummary({}) === null && cronSummary(undefined) === null, "rows are soonest first with the schedule in words; the summary names the next run");

// words for a schedule
const words = [["* * * * *", "every minute"], ["*/5 * * * *", "every 5 min"], ["7 * * * *", "hourly at :07"], ["0 */2 * * *", "every 2 h"], ["57 8 * * *", "daily 08:57"], ["0 9 * * 1-5", "weekdays 09:00"], ["30 14 28 2 *", "Feb 28 14:30"], ["0 9 * * 1", "Mon 09:00"], ["5 4 * * 0,6", "weekends 04:05"], ["1 2 3 * *", "1 2 3 * *"], ["nonsense", "nonsense"]];
for (const [expr, want] of words) ok(describeCron(expr) === want, `describeCron(${JSON.stringify(expr)}) = ${JSON.stringify(describeCron(expr))}`);

// next run (local time)
const from = new Date(2026, 9, 27, 10, 3, 20).getTime(); // Tue 27 Oct 2026 10:03:20
const local = (...a) => new Date(...a).getTime();
ok(nextCronMatch("* * * * *", from) === local(2026, 9, 27, 10, 4), "every minute: the next whole minute");
ok(nextCronMatch("*/5 * * * *", from) === local(2026, 9, 27, 10, 5), "*/5: the next multiple of 5");
ok(nextCronMatch("0 9 * * *", from) === local(2026, 9, 28, 9, 0), "daily 09:00: tomorrow");
ok(nextCronMatch("0 9 * * 1-5", local(2026, 9, 30, 12, 0)) === local(2026, 10, 2, 9, 0), "weekdays 09:00 from a Friday noon: Monday");
ok(nextCronMatch("30 14 28 2 *", from) === local(2027, 1, 28, 14, 30), "a one-shot date next year");
ok(nextCronMatch("0 0 31 2 *", from) === null && nextCronMatch("x y", from) === null && nextCronMatch("60 * * * *", from) === null, "impossible or malformed expressions give null");

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
