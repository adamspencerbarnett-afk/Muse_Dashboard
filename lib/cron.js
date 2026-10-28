// Muse Dashboard · lib/cron.js
// Author: Adam S. Barnett
//
// Scheduled jobs: Muse's own cron_create / cron_list / cron_delete tools and
// the scheduledFire items a job's runs arrive as. The dashboard never
// schedules anything itself; it folds what the session reports into one
// record per job so the page can show when Muse will wake up next.
//
// Facts come from the tool's receipt when the host sends one (toolReceipt,
// ADR 42728: create → { jobId, nextFireAtMs }, list → { jobs }, delete →
// { jobId }), else from the tool's output as Muse 1.4.13 writes it (measured
// 2026-10-27): create → "Scheduled <id> (Every minute, …)", list → JSON
// { jobs: [{ id, cron, schedule, prompt, recurring, permanent,
// next_fire_at_ms, last_fired_at_ms, fire_count }] }, delete (args { id })
// → "Removed scheduled job <id>.". The create output has
// no time, so the first run is estimated from the cron expression (approx)
// until the first run or a listing gives the exact one.

const CRON_TOOLS = new Set(["cron_create", "cron_list", "cron_delete"]);

/** Is this item one the job records must be updated from? */
export function isCronItem(item) {
  if (!item || typeof item !== "object") return false;
  if (item.kind === "scheduledFire") return true;
  return item.kind === "toolCall" && (item.toolReceipt?.family === "cron" || CRON_TOOLS.has(item.tool));
}

function parseJson(s) {
  if (typeof s !== "string" || !s) return null;
  try { const v = JSON.parse(s); return v && typeof v === "object" ? v : null; } catch { return null; }
}

/** When the item happened (ms), for "newest fact wins". Live items carry no recordedAt: now. */
function itemTime(item, now) {
  const t = item.recordedAt ? Date.parse(item.recordedAt) : NaN;
  return Number.isFinite(t) ? t : now;
}

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);

/** The rows of a listing: the receipt's, else the output JSON's (which also carries each job's schedule and prompt). */
function listedJobs(item) {
  const d = item.toolReceipt?.details;
  if (Array.isArray(d?.jobs)) return d.jobs.map((r) => ({ jobId: r?.jobId, nextFireAtMs: num(r?.nextFireAtMs) }));
  const out = parseJson(item.visibleOutput || item.text);
  if (!Array.isArray(out?.jobs)) return null;
  return out.jobs.map((r) => ({
    jobId: r?.id, nextFireAtMs: num(r?.next_fire_at_ms), lastFiredAtMs: num(r?.last_fired_at_ms), fires: num(r?.fire_count),
    cron: typeof r?.cron === "string" ? r.cron : undefined, prompt: typeof r?.prompt === "string" ? r.prompt : undefined,
    recurring: typeof r?.recurring === "boolean" ? r.recurring : undefined, permanent: typeof r?.permanent === "boolean" ? r.permanent : undefined,
  }));
}

/**
 * Fold one item into the jobs map ({ jobId -> job }). Returns the new map, or
 * null when the item changes nothing (not a cron item, still running, failed,
 * or older than what is already known). Never mutates `jobs`.
 */
export function foldCronItem(jobs, item, now = Date.now()) {
  if (!isCronItem(item)) return null;
  const cur = jobs && typeof jobs === "object" ? jobs : {};
  const at = itemTime(item, now);
  const stale = (id) => cur[id] && cur[id].updatedAtMs > at;
  if (item.kind === "scheduledFire") {
    const id = item.jobId;
    if (!id || stale(id)) return null;
    if (item.nextFireAtMs == null) { // a final delivery: the job is finished
      if (!cur[id]) return null;
      const { [id]: _gone, ...rest } = cur;
      return rest;
    }
    const prev = cur[id] || { jobId: id, createdAtMs: at };
    return { ...cur, [id]: { ...prev, nextFireAtMs: item.nextFireAtMs, approx: false, lastFiredAtMs: item.scheduledFireAtMs ?? at, fires: item.deliveryNumber ?? (prev.fires || 0) + 1, updatedAtMs: at } };
  }
  if (item.status !== "completed") return null;
  const r = item.toolReceipt;
  const d = r?.details || {};
  const args = parseJson(item.args) || {};
  const output = item.visibleOutput || item.text || "";
  const op = r?.operation || item.tool?.slice(5);
  if (op === "create") {
    if (r && !(r.outcome === "created" || r.outcome === "duplicate")) return null;
    const id = d.jobId || (output.match(/^\s*Scheduled\s+(\S+)/) || [])[1];
    if (!id || stale(id)) return null;
    const prev = cur[id] || { createdAtMs: at, fires: 0 };
    const job = { ...prev, jobId: id, updatedAtMs: at };
    if (typeof args.cron === "string") job.cron = args.cron;
    if (typeof args.prompt === "string") job.prompt = args.prompt;
    if ("recurring" in args) job.recurring = args.recurring !== false;
    if ("permanent" in args) job.permanent = !!args.permanent;
    if (num(d.nextFireAtMs) !== null) { job.nextFireAtMs = num(d.nextFireAtMs); job.approx = false; }
    else if (prev.nextFireAtMs == null) { const est = job.cron ? nextCronMatch(job.cron, at) : null; job.nextFireAtMs = est; job.approx = est !== null; }
    return { ...cur, [id]: job };
  }
  if (op === "delete") {
    if (r && !(r.outcome === "deleted" || r.outcome === "missing")) return null;
    const id = d.jobId || args.id || args.job_id || args.jobId || (output.match(/^\s*(?:Deleted|Cancelled|Removed)\s+(?:scheduled\s+)?(?:job\s+)?([\w-]+)/i) || [])[1];
    if (!id || !cur[id] || stale(id)) return null;
    const { [id]: _gone, ...rest } = cur;
    return rest;
  }
  if (op === "list") {
    const rows = listedJobs(item);
    if (!rows) return null;
    const next = {};
    for (const row of rows) {
      if (typeof row.jobId !== "string" || !row.jobId) continue;
      const prev = cur[row.jobId];
      if (prev && prev.updatedAtMs > at) { next[row.jobId] = prev; continue; }
      const job = { ...(prev || { jobId: row.jobId, createdAtMs: at, fires: 0 }), updatedAtMs: at };
      for (const k of ["cron", "prompt", "recurring", "permanent", "lastFiredAtMs"]) if (row[k] !== undefined && row[k] !== null) job[k] = row[k];
      if (row.fires !== undefined && row.fires !== null) job.fires = row.fires;
      if (row.nextFireAtMs !== null) { job.nextFireAtMs = row.nextFireAtMs; job.approx = false; }
      next[row.jobId] = job;
    }
    for (const [id, prev] of Object.entries(cur)) if (!next[id] && prev.updatedAtMs > at) next[id] = prev; // a job made after this listing
    return sameJobs(cur, next) ? null : next;
  }
  return null;
}

function sameJobs(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => b[k] && b[k].nextFireAtMs === a[k].nextFireAtMs && b[k].updatedAtMs === a[k].updatedAtMs && b[k].fires === a[k].fires);
}

/** The jobs as the page wants them: soonest first, each with its schedule in words. */
export function cronRows(jobs) {
  return Object.values(jobs || {})
    .map((j) => ({ ...j, schedule: j.cron ? describeCron(j.cron) : null }))
    .sort((a, b) => (a.nextFireAtMs ?? Infinity) - (b.nextFireAtMs ?? Infinity));
}

/** { count, nextFireAtMs, approx, schedule, prompt } for the chat list; null when nothing is scheduled. */
export function cronSummary(jobs) {
  const rows = cronRows(jobs);
  if (!rows.length) return null;
  const next = rows[0];
  return { count: rows.length, nextFireAtMs: next.nextFireAtMs ?? null, approx: !!next.approx, schedule: next.schedule, prompt: next.prompt || null };
}

/** Plain words for a 5-field cron expression ("every 5 min", "daily 09:57"); the expression itself when it is anything fancier. */
export function describeCron(expr) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length !== 5) return expr || "";
  const [min, hour, dom, mon, dow] = f;
  const n = (s) => (/^\d+$/.test(s) ? Number(s) : null);
  const hm = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (dom === "*" && mon === "*") {
    const stepM = min.match(/^\*\/(\d+)$/);
    if (hour === "*" && dow === "*") {
      if (min === "*") return "every minute";
      if (stepM) return `every ${stepM[1]} min`;
      if (n(min) !== null) return `hourly at :${String(n(min)).padStart(2, "0")}`;
    }
    const stepH = hour.match(/^\*\/(\d+)$/);
    if (stepH && n(min) !== null && dow === "*") return `every ${stepH[1]} h`;
    if (n(hour) !== null && n(min) !== null) {
      const t = hm(n(hour), n(min));
      if (dow === "*") return `daily ${t}`;
      if (dow === "1-5") return `weekdays ${t}`;
      if (dow === "0,6" || dow === "6,0") return `weekends ${t}`;
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      if (n(dow) !== null && days[n(dow)]) return `${days[n(dow)]} ${t}`;
    }
  }
  if (n(min) !== null && n(hour) !== null && n(dom) !== null && n(mon) !== null && dow === "*") {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    if (months[n(mon) - 1]) return `${months[n(mon) - 1]} ${n(dom)} ${hm(n(hour), n(min))}`;
  }
  return expr;
}

/** One cron field ("*", "5", "1-5", "*​/10", "1,15", "1-5/2") as a Set of matching values in [lo, hi]; null when malformed. */
function fieldSet(field, lo, hi) {
  const out = new Set();
  for (const part of String(field).split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    if (!(step >= 1)) return null;
    let a = lo, b = hi;
    if (m[1] !== "*") { const [x, y] = m[1].split("-").map(Number); a = x; b = y === undefined ? (m[2] ? hi : x) : y; }
    if (a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/**
 * The first minute after `fromMs` (local time) the 5-field expression
 * matches, as epoch ms; null when the expression is malformed or matches
 * nothing within a year. Muse adds its own per-job offset to this, so it is
 * an estimate (shown as "about").
 */
export function nextCronMatch(expr, fromMs = Date.now()) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = [fieldSet(f[0], 0, 59), fieldSet(f[1], 0, 23), fieldSet(f[2], 1, 31), fieldSet(f[3], 1, 12), fieldSet(f[4], 0, 7)];
  if (!min || !hour || !dom || !mon || !dow) return null;
  if (dow.has(7)) dow.add(0); // both 0 and 7 are Sunday
  const anyDom = f[2] === "*", anyDow = f[4] === "*";
  const dayOk = (d) => { // Vixie cron: when both day fields are restricted, either one matching is enough
    const okDom = dom.has(d.getDate()), okDow = dow.has(d.getDay());
    return anyDom ? okDow : anyDow ? okDom : okDom || okDow;
  };
  const d = new Date(fromMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const end = fromMs + 366 * 86400000;
  while (d.getTime() <= end) {
    if (!mon.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!dayOk(d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1); continue; }
    return d.getTime();
  }
  return null;
}
