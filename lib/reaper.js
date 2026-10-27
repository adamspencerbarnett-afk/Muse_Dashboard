// Muse Dashboard · lib/reaper.js
// Author: Adam S. Barnett
//
// Makes sure no `muse serve` process outlives the dashboard, in three layers:
//  1. Graceful: shutdown() closes each host over MSP (stdin EOF), with a time limit.
//  2. In-process: anything still tracked is force-killed with its whole process
//     tree (taskkill /T /F on Windows, the process group elsewhere), also from
//     process.on("exit").
//  3. Watchdog: a tiny detached helper (lib/watchdog.js) holds a pipe to this
//     process. If the dashboard dies without saying goodbye (window closed,
//     killed, crashed), the pipe breaks and the watchdog kills the trees.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Kill a process and everything it started. Synchronous so it also works in "exit" handlers. */
export function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
    } catch { /* already gone */ }
    return;
  }
  // The Muse SDK starts `muse serve` as the leader of its own process group.
  try { process.kill(-pid, "SIGKILL"); } catch { /* not a group leader / gone */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
}

/** The OS pid behind an SDK MuseServeChild (the SDK keeps its ChildProcess private). */
export function pidOfMuseChild(museChild) {
  try {
    for (let o = museChild; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      const sym = Object.getOwnPropertySymbols(o).find((s) => s.description === "MuseServeChild.transport");
      if (sym) return museChild[sym]()?.child?.pid ?? null;
    }
  } catch { /* SDK internals changed */ }
  return null;
}

export class Reaper {
  #pids = new Set();
  #groups = new Set(); // POSIX: process groups of hosts that already exited (leftover helpers)
  #dog = null;

  constructor({ watchdog = true } = {}) {
    if (watchdog) this.#startWatchdog();
    process.on("exit", () => this.killAll());
  }

  #startWatchdog() {
    try {
      const dog = spawn(process.execPath, [path.join(HERE, "watchdog.js"), String(process.pid)], {
        detached: true, // own process group / no console: survives our console window closing
        windowsHide: true,
        stdio: ["pipe", "ignore", "ignore"],
      });
      dog.on("error", () => { this.#dog = null; });
      dog.stdin.on("error", () => { /* watchdog gone */ });
      dog.unref();
      dog.stdin.unref?.();
      this.#dog = dog;
    } catch (e) {
      console.warn(`[reaper] could not start the watchdog: ${e.message}`);
    }
  }

  #tell(line) {
    try { this.#dog?.stdin.write(`${line}\n`); } catch { /* ignore */ }
  }

  get watchdogPid() { return this.#dog?.pid ?? null; }
  get pids() { return [...this.#pids]; }

  track(pid) {
    if (!pid) return;
    this.#pids.add(pid);
    this.#tell(`+${pid}`);
  }

  untrack(pid) {
    if (!pid || !this.#pids.delete(pid)) return;
    if (!IS_WIN) this.#groups.add(pid);
    this.#tell(`-${pid}`);
  }

  /** Force-kill everything still tracked (and its children). */
  killAll() {
    for (const pgid of this.#groups) { try { process.kill(-pgid, "SIGKILL"); } catch { /* group empty */ } }
    this.#groups.clear();
    for (const pid of this.#pids) killTree(pid);
    for (const pid of this.#pids) this.#tell(`-${pid}`);
    this.#pids.clear();
  }

  /** Clean exit: nothing left for the watchdog to do. */
  bye() {
    const dog = this.#dog;
    if (!dog) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, 500);
      try {
        dog.stdin.end("bye\n", () => { clearTimeout(t); resolve(); });
      } catch { clearTimeout(t); resolve(); }
    });
  }
}
