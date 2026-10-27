// Muse Dashboard · lib/watchdog.js
// Author: Adam S. Barnett
//
// Detached helper started by lib/reaper.js (never run on its own). It reads
// "+pid" / "-pid" / "bye" lines on stdin. If the dashboard goes away without
// "bye" (stdin closes, or its process is gone), it kills every tracked process
// tree, so no `muse serve` outlives the dashboard.
import { killTree } from "./reaper.js";

const parent = Number(process.argv[2]);
const pids = new Set();
let clean = false;
let buf = "";

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function finish() {
  if (!clean) for (const pid of pids) killTree(pid);
  process.exit(0);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === "bye") clean = true;
    else if (line[0] === "+") pids.add(Number(line.slice(1)));
    else if (line[0] === "-") pids.delete(Number(line.slice(1)));
  }
});
process.stdin.on("end", finish);
process.stdin.on("close", finish);
process.stdin.on("error", finish);
// Backup in case the pipe stays open somehow.
setInterval(() => { if (parent && !alive(parent)) finish(); }, 60000);
