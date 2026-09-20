import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Machine-capacity probes, ported from firstmate's `bin/fm-capacity-lib.sh`
 * (and matching usage-axi's `machine.ts`), so the router can judge capacity from
 * usage-axi plus local readings. Every probe returns a real reading or `null`;
 * a probe never fabricates a neutral value, and an unreadable signal never
 * refuses by itself (the route simply reports what it could not measure).
 *
 * Cross-platform rules:
 *  - free memory: macOS `memory_pressure -Q` free percent (falling back to
 *    vm_stat free+speculative); Linux MemAvailable as a share of MemTotal.
 *  - memory pressure: macOS `kern.memorystatus_vm_pressure_level` (1 normal, 2
 *    warn, 4 critical); Linux PSI `/proc/pressure/memory` some avg10 (<5 normal,
 *    <20 warn, else critical). Unreadable means `unknown`.
 *  - swap: macOS `vm.swapusage` + `vm_stat` Swapouts; Linux /proc/meminfo
 *    SwapTotal/SwapFree + /proc/vmstat pswpout.
 *  - worker-root agents: usage-axi's invocation-root rule (`readFleet` in its
 *    `src/sources/machine.ts`) over two `ps` snapshots, excluding this
 *    process's own probe tree. A matching descendant of a matching ancestor
 *    collapses into that ancestor's root, and Cursor private-worker /
 *    worker-start daemons are excluded, so `agents` counts harness
 *    invocations, not matching processes.
 *  - suite slot: a running test runner in `ps args`.
 *
 * Test/diagnostic seams (a MEASUREMENT, never a disable): the `LLM_ROUTER_*`
 * environment variables below, or a whole gauge fixture via
 * `LLM_ROUTER_MACHINE_JSON=<file>` shaped like `MachineGauges`.
 */

export type MemoryPressureLevel = "normal" | "warn" | "critical" | null;

export interface MachineGauges {
  agents: number | null;
  loadPerCore: number | null;
  memoryFreePct: number | null;
  memoryPressure: MemoryPressureLevel;
  swapUsedPct: number | null;
  swapouts: number | null;
  suiteSlotFree: boolean | null;
  /** Additive: the counted invocation roots behind `agents`, audit trail only. */
  roots?: AgentRoot[];
  /** Configured llama.cpp --parallel ceiling (adi1 qwen38fn). Default 2. */
  llamaParallel: number | null;
  llamaSlotsTotal: number | null;
  llamaSlotsBusy: number | null;
  /** True when at least one llama slot is free; null when unreadable. */
  llamaSlotFree: boolean | null;
}

/** One counted invocation root: identity only, never the argv body. */
export interface AgentRoot {
  pid: number;
  comm: string;
  match: string;
  via: "comm" | "argv";
}

const WORKER_NAMES = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "pi-signed",
  "grok",
  "kimi",
  "cline",
  "cursor-agent",
  "copilot",
  "muse",
  "agy",
];

const TEST_RUNNER_RE =
  /(?:^|[\s/])(vitest|jest|mocha|ava|tap|pytest|phpunit|rspec|go test|cargo test|npm (?:run )?test|pnpm (?:run )?test|yarn (?:run )?test|bun (?:run )?test|deno test|gradle (?:run )?test|mvn (?:run )?test)(?:$|[\s])/;

function runText(file: string, args: string[], timeoutMs = 2000): string | null {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) return null;
  const text = (result.stdout ?? "").trim();
  return text.length ? text : null;
}

function readProc(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function envNumber(name: string): number | null | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  if (raw === "unknown") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function envBool(name: string): boolean | null | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  if (raw === "1" || raw === "true" || raw === "busy") return false;
  if (raw === "0" || raw === "false" || raw === "free") return true;
  return null;
}

function roundPct(value: number): number {
  return Math.round(value * 10) / 10;
}

/** macOS pressure level codes: 1 normal, 2 warn, 4 critical. */
export function pressureFromLevel(value: string | null): MemoryPressureLevel {
  switch (value) {
    case "1":
      return "normal";
    case "2":
      return "warn";
    case "4":
      return "critical";
    default:
      return null;
  }
}

/** Linux PSI avg10 -> level, matching fm-capacity-lib's conservative marks. */
export function pressureFromPsiAvg10(value: number | null): MemoryPressureLevel {
  if (value === null || !Number.isFinite(value)) return null;
  if (value < 5) return "normal";
  if (value < 20) return "warn";
  return "critical";
}

export function pressureFromText(text: string | null): MemoryPressureLevel {
  const match = text?.match(/^some\s+.*?avg10=([0-9.]+)/m);
  return match ? pressureFromPsiAvg10(Number(match[1])) : null;
}

export function swapPercent(totalMb: number | null, usedMb: number | null): number | null {
  if (totalMb === null || usedMb === null || totalMb <= 0) return null;
  return roundPct((usedMb / totalMb) * 100);
}

function parsePs(line: string): { pid: number; ppid: number; rss: number; comm: string } | null {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
  if (!match) return null;
  return { pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]), comm: match[4] };
}

function argvFrom(line: string): { pid: number; args: string } | null {
  const match = line.match(/^\s*(\d+)\s+(.*)$/);
  if (!match) return null;
  return { pid: Number(match[1]), args: match[2] };
}

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

/**
 * The adapter a command basename names, if any: an exact adapter name, or an
 * adapter followed by `-`, `_`, or `.` (e.g. `codex.js`, `muse-bin-1`). Exact
 * equality is checked across the whole list first so `pi-signed` resolves to
 * itself rather than to the `pi` prefix. Deliberately not a bare substring:
 * `pip` must never read as `pi`.
 */
function namesWorkerMatch(value: string): string | null {
  if (WORKER_NAMES.includes(value)) return value;
  for (const name of WORKER_NAMES) {
    if (value.startsWith(`${name}-`) || value.startsWith(`${name}_`) || value.startsWith(`${name}.`)) {
      return name;
    }
  }
  return null;
}

/**
 * The adapter named as a whole path or word component of an interpreter's argv,
 * anchored on both sides for the same reason (`python -m pi` matches; the `pi`
 * inside `pip` does not).
 */
function argvNamesWorkerMatch(value: string): string | null {
  for (const name of WORKER_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|/|\\s)${escaped}([-_./]|\\s|$)`).test(value)) return name;
  }
  return null;
}

/**
 * Cursor private-worker / worker-start processes are long-lived service
 * daemons, not coding-agent task sessions. Token match on argv only, so a
 * standalone `cursor-agent` task still counts. `private-worker` and
 * `worker-start` are the flag forms; `worker … start` is the documented
 * `agent worker start` subcommand (flags may sit between the two words).
 */
const CURSOR_DAEMON_TOKEN_RE = /\b(?:private[-_]worker|worker-start)\b/i;
const CURSOR_WORKER_START_RE = /\bworker\b(?:\s+\S+)*\s+\bstart\b/i;

function isCursorBackgroundDaemon(match: string, args: string): boolean {
  if (match !== "cursor-agent") return false;
  return CURSOR_DAEMON_TOKEN_RE.test(args) || CURSOR_WORKER_START_RE.test(args);
}

/** True when `pid` has an ancestor (not itself) in `targets`. Depth-capped. */
function hasAncestorIn(
  pid: number,
  parent: ReadonlyMap<number, number>,
  targets: ReadonlySet<number>,
): boolean {
  let current = parent.get(pid);
  for (let depth = 0; depth < 64; depth += 1) {
    if (current === undefined) return false;
    if (targets.has(current)) return true;
    current = parent.get(current);
  }
  return false;
}

/** Every pid in the process tree rooted at `rootPid`, from a comm snapshot. */
export function processTreePids(commSnapshot: string | null, rootPid: number): Set<number> {
  const tree = new Set<number>([rootPid]);
  if (!commSnapshot) return tree;
  const children = new Map<number, number[]>();
  for (const line of commSnapshot.split("\n")) {
    const parsed = parsePs(line);
    if (!parsed) continue;
    const siblings = children.get(parsed.ppid);
    if (siblings) siblings.push(parsed.pid);
    else children.set(parsed.ppid, [parsed.pid]);
  }
  const stack = [rootPid];
  while (stack.length) {
    const parent = stack.pop() as number;
    for (const child of children.get(parent) ?? []) {
      if (tree.has(child)) continue;
      tree.add(child);
      stack.push(child);
    }
  }
  return tree;
}

/** The result of one fleet reading over two ps snapshots. */
export type FleetReading = {
  agents: number | null;
  procs: number | null;
  residentMb: number | null;
  roots: AgentRoot[];
};

/**
 * Invocation-root fleet reading, ported from usage-axi's `readFleet` (its
 * `src/sources/machine.ts`) so the router's count matches usage-axi's exactly:
 * a matching pid whose ancestor also matches collapses into that ancestor
 * (one harness invocation is one root, however many of its own child
 * processes independently match), and Cursor private-worker / worker-start
 * daemons are excluded as service daemons, not task sessions. `procs` and
 * `residentMb` sum the whole tree under each remaining root. `roots` lists
 * every counted invocation so `agents` is auditable.
 *
 * `excludePids` drops this process's own transient probe tree only (see
 * `processTreePids`); it must never exclude an unrelated agent.
 */
export function readFleet(
  commSnapshot: string | null,
  argvSnapshot: string | null,
  excludePids: ReadonlySet<number> = new Set(),
): FleetReading {
  if (!commSnapshot) return { agents: null, procs: null, residentMb: null, roots: [] };
  const argv = new Map<number, string>();
  for (const line of (argvSnapshot ?? "").split("\n")) {
    const parsed = argvFrom(line);
    if (parsed) argv.set(parsed.pid, parsed.args);
  }
  const parent = new Map<number, number>();
  const size = new Map<number, number>();
  const known: number[] = [];
  const daemons = new Set<number>();
  const matches: AgentRoot[] = [];
  for (const line of commSnapshot.split("\n")) {
    const parsed = parsePs(line);
    if (!parsed || excludePids.has(parsed.pid)) continue;
    parent.set(parsed.pid, parsed.ppid);
    size.set(parsed.pid, parsed.rss);
    known.push(parsed.pid);
    const base = baseName(parsed.comm);
    let match = namesWorkerMatch(base);
    let via: AgentRoot["via"] = "comm";
    if (!match && (base.startsWith("node") || base.startsWith("python"))) {
      match = argvNamesWorkerMatch(argv.get(parsed.pid) ?? "");
      via = "argv";
    }
    if (!match) continue;
    if (isCursorBackgroundDaemon(match, argv.get(parsed.pid) ?? "")) {
      daemons.add(parsed.pid);
      continue;
    }
    matches.push({ pid: parsed.pid, comm: base, match, via });
  }
  const matching = new Set(matches.map((entry) => entry.pid));
  const roots = matches.filter(
    (entry) => !hasAncestorIn(entry.pid, parent, matching) && !hasAncestorIn(entry.pid, parent, daemons),
  );
  const root = new Set(roots.map((entry) => entry.pid));
  let residentKb = 0;
  let procs = 0;
  for (const pid of known) {
    // Walk to an invocation root. The depth cap keeps a corrupt or cyclic
    // snapshot from spinning.
    let current = pid;
    for (let depth = 0; depth < 64; depth += 1) {
      if (root.has(current)) {
        residentKb += size.get(pid) ?? 0;
        procs += 1;
        break;
      }
      const next = parent.get(current);
      if (next === undefined) break;
      current = next;
    }
  }
  return { agents: roots.length, procs, residentMb: Math.floor(residentKb / 1024), roots };
}

/**
 * Count live worker roots, matching usage-axi's invocation-root rule. Kept as
 * the narrow, exported entry point existing callers use; `readFleet` carries
 * the same rule plus the auditable roots and the tree sums.
 */
export function countWorkerRoots(
  commSnapshot: string | null,
  argvSnapshot: string | null,
  excludePids: ReadonlySet<number> = new Set(),
): number | null {
  return readFleet(commSnapshot, argvSnapshot, excludePids).agents;
}

/** True when a test runner is live in the argv snapshot. Pure. */
export function suiteSlotFromArgv(
  argvSnapshot: string | null,
  excludePids: ReadonlySet<number> = new Set(),
): boolean | null {
  if (!argvSnapshot) return null;
  for (const line of argvSnapshot.split("\n")) {
    const parsed = argvFrom(line);
    if (!parsed || excludePids.has(parsed.pid)) continue;
    if (TEST_RUNNER_RE.test(parsed.args)) return false;
  }
  return true;
}

function probeMemoryPressure(): MemoryPressureLevel {
  const override = process.env["LLM_ROUTER_MEM_PRESSURE"];
  if (override !== undefined) {
    return override === "normal" || override === "warn" || override === "critical"
      ? override
      : null;
  }
  return pressureFromLevel(runText("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])) ??
    pressureFromText(readProc("/proc/pressure/memory"));
}

function probeSwap(): { usedPct: number | null; swapouts: number | null } {
  const total = envNumber("LLM_ROUTER_SWAP_TOTAL_MB");
  const used = envNumber("LLM_ROUTER_SWAP_USED_MB");
  const swapouts = envNumber("LLM_ROUTER_SWAPOUTS");
  if (total !== undefined || used !== undefined || swapouts !== undefined) {
    return {
      usedPct: swapPercent(total ?? null, used ?? null),
      swapouts: swapouts ?? null,
    };
  }
  const swapusage = runText("sysctl", ["-n", "vm.swapusage"]);
  if (swapusage) {
    const totalMb = parseMb(swapusage, /total = ([0-9.]+)M/);
    const usedMb = parseMb(swapusage, /used = ([0-9.]+)M/);
    const vmStat = runText("vm_stat", []);
    const swapoutsMatch = vmStat?.match(/^Swapouts:\s+([\d.]+)/m);
    const out = swapoutsMatch ? Number(swapoutsMatch[1].replace(/\./g, "")) : null;
    return { usedPct: swapPercent(totalMb, usedMb), swapouts: Number.isFinite(out) ? out : null };
  }
  const meminfo = readProc("/proc/meminfo");
  if (meminfo) {
    const totalKb = matchKb(meminfo, "SwapTotal");
    const freeKb = matchKb(meminfo, "SwapFree");
    const totalMb = totalKb === null ? null : Math.round(totalKb / 1024);
    const usedMb = totalKb === null || freeKb === null ? null : Math.round((totalKb - freeKb) / 1024);
    const vmstat = readProc("/proc/vmstat");
    const pswpout = vmstat?.match(/^pswpout (\d+)/m);
    return {
      usedPct: swapPercent(totalMb, usedMb),
      swapouts: pswpout ? Number(pswpout[1]) : null,
    };
  }
  return { usedPct: null, swapouts: null };
}

function parseMb(text: string, re: RegExp): number | null {
  const match = text.match(re);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.round(value) : null;
}

function matchKb(text: string, key: string): number | null {
  const match = text.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
  return match ? Number(match[1]) : null;
}

function probeMemoryFreePct(): number | null {
  const override = envNumber("LLM_ROUTER_MEM_FREE_PCT");
  if (override !== undefined) return override;
  if (process.platform === "darwin") {
    const report = runText("memory_pressure", ["-Q"]);
    const match = report?.match(/System-wide memory free percentage:\s*(\d+)%/i);
    if (match) return Number(match[1]);
    const vmStat = runText("vm_stat", []);
    const memsize = runText("sysctl", ["-n", "hw.memsize"]);
    if (vmStat && memsize) {
      const page = vmStat.match(/page size of (\d+)/);
      const free = vmStat.match(/^Pages free:\s+(\d+)/m);
      const spec = vmStat.match(/^Pages speculative:\s+(\d+)/m);
      if (page && free && Number(memsize) > 0) {
        const pages = Number(free[1]) + (spec ? Number(spec[1]) : 0);
        const freeMb = (pages * Number(page[1])) / 1024 / 1024;
        return roundPct((freeMb / (Number(memsize) / 1024 / 1024)) * 100);
      }
    }
    return null;
  }
  const meminfo = readProc("/proc/meminfo");
  if (!meminfo) return null;
  const totalKb = matchKb(meminfo, "MemTotal");
  const availableKb = matchKb(meminfo, "MemAvailable");
  if (totalKb === null || availableKb === null || totalKb <= 0) return null;
  return roundPct((availableKb / totalKb) * 100);
}

function probeLoadPerCore(): number | null {
  const override = envNumber("LLM_ROUTER_LOAD_PER_CORE");
  if (override !== undefined) return override;
  let cores: number | null = null;
  const coresOverride = envNumber("LLM_ROUTER_CORES");
  if (coresOverride !== undefined) cores = coresOverride;
  if (cores === null || cores === undefined) {
    const sysctl = runText("sysctl", ["-n", "hw.logicalcpu"]);
    const nproc = sysctl ?? runText("nproc", []);
    cores = nproc && /^\d+$/.test(nproc) && Number(nproc) > 0 ? Number(nproc) : null;
  }
  const loadOverride = envNumber("LLM_ROUTER_LOAD1");
  let load: number | null = loadOverride ?? null;
  if (loadOverride === undefined) {
    const sysctl = runText("sysctl", ["-n", "vm.loadavg"]);
    const match = sysctl?.match(/\{?\s*([0-9.]+)/);
    if (match) load = Number(match[1]);
    if (load === null) {
      const proc = readProc("/proc/loadavg");
      if (proc) load = Number(proc.split(/\s+/)[0]);
    }
  }
  if (load === null || !Number.isFinite(load) || cores === null || cores <= 0) return null;
  return Math.round((load / cores) * 1000) / 1000;
}

/** Read a complete gauge fixture from `LLM_ROUTER_MACHINE_JSON`, when set. */
export function readMachineFixture(): Partial<MachineGauges> | null {
  const path = process.env["LLM_ROUTER_MACHINE_JSON"];
  if (!path) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const num = (key: string): number | null => (typeof raw[key] === "number" ? (raw[key] as number) : null);
  const pressure = raw["memoryPressure"];
  return {
    agents: num("agents"),
    loadPerCore: num("loadPerCore"),
    memoryFreePct: num("memoryFreePct"),
    memoryPressure:
      pressure === "normal" || pressure === "warn" || pressure === "critical" ? pressure : null,
    swapUsedPct: num("swapUsedPct"),
    swapouts: num("swapouts"),
    suiteSlotFree: typeof raw["suiteSlotFree"] === "boolean" ? (raw["suiteSlotFree"] as boolean) : null,
    llamaParallel: num("llamaParallel"),
    llamaSlotsTotal: num("llamaSlotsTotal"),
    llamaSlotsBusy: num("llamaSlotsBusy"),
    llamaSlotFree: typeof raw["llamaSlotFree"] === "boolean" ? (raw["llamaSlotFree"] as boolean) : null,
  };
}

/** Configured --parallel ceiling for the local llama.cpp fleet. */
export function llamaParallelCeiling(): number {
  const override = envNumber("LLM_ROUTER_LLAMA_PARALLEL");
  if (override !== undefined && override !== null && override > 0) return override;
  return 2;
}

function llamaSlotsUrl(): string | null {
  const raw = process.env["LLM_ROUTER_LLAMA_SLOTS_URL"];
  if (raw === "off" || raw === "0") return null;
  if (raw && raw.length > 0) return raw;
  return "http://100.85.233.75:30000/slots";
}

/** Fold a llama.cpp /slots JSON array into busy/free gauges. Pure. */
export function foldLlamaSlots(
  parallel: number,
  payload: unknown,
): { llamaSlotsTotal: number | null; llamaSlotsBusy: number | null; llamaSlotFree: boolean | null } {
  if (!Array.isArray(payload) || payload.length === 0) {
    return { llamaSlotsTotal: null, llamaSlotsBusy: null, llamaSlotFree: null };
  }
  let busy = 0;
  for (const slot of payload) {
    if (!slot || typeof slot !== "object") continue;
    if ((slot as { is_processing?: unknown }).is_processing === true) busy += 1;
  }
  const total = payload.length;
  return {
    llamaSlotsTotal: total,
    llamaSlotsBusy: busy,
    llamaSlotFree: busy < total,
  };
}

function probeLlamaSlots(): {
  llamaParallel: number;
  llamaSlotsTotal: number | null;
  llamaSlotsBusy: number | null;
  llamaSlotFree: boolean | null;
} {
  const parallel = llamaParallelCeiling();
  const override = process.env["LLM_ROUTER_LLAMA_SLOTS_BUSY"];
  if (override !== undefined) {
    if (override === "unknown") {
      return {
        llamaParallel: parallel,
        llamaSlotsTotal: null,
        llamaSlotsBusy: null,
        llamaSlotFree: null,
      };
    }
    if (/^\d+$/.test(override)) {
      const busy = Number(override);
      return {
        llamaParallel: parallel,
        llamaSlotsTotal: parallel,
        llamaSlotsBusy: busy,
        llamaSlotFree: busy < parallel,
      };
    }
  }
  const url = llamaSlotsUrl();
  if (!url) {
    return {
      llamaParallel: parallel,
      llamaSlotsTotal: null,
      llamaSlotsBusy: null,
      llamaSlotFree: null,
    };
  }
  // Synchronous probe via curl so measureMachine stays sync like the other gauges.
  const body = runText("curl", ["-sf", "--connect-timeout", "1", "--max-time", "2", url], 2500);
  if (!body) {
    return {
      llamaParallel: parallel,
      llamaSlotsTotal: null,
      llamaSlotsBusy: null,
      llamaSlotFree: null,
    };
  }
  try {
    return { llamaParallel: parallel, ...foldLlamaSlots(parallel, JSON.parse(body)) };
  } catch {
    return {
      llamaParallel: parallel,
      llamaSlotsTotal: null,
      llamaSlotsBusy: null,
      llamaSlotFree: null,
    };
  }
}

/**
 * The two `ps` snapshots the worker-root rule reads. `LLM_ROUTER_MACHINE_PS_COMM`
 * / `LLM_ROUTER_MACHINE_PS_ARGV` (both required together, matching usage-axi's
 * `USAGE_AXI_MACHINE_PS_COMM`/`_ARGV`) replay a captured pair instead of
 * spawning `ps`, so a test or an operator can drive `readFleet` from a fixed
 * snapshot, including one captured on another host.
 */
function psSnapshots(): { comm: string | null; argv: string | null; live: boolean } {
  const commFile = process.env["LLM_ROUTER_MACHINE_PS_COMM"];
  const argvFile = process.env["LLM_ROUTER_MACHINE_PS_ARGV"];
  if (commFile && argvFile) {
    return { comm: readProc(commFile), argv: readProc(argvFile), live: false };
  }
  return {
    comm: runText("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="]),
    argv: runText("ps", ["-A", "-o", "pid=,args="]),
    live: true,
  };
}

/**
 * Measure the live machine. When `LLM_ROUTER_MACHINE_JSON` is set, its fields
 * replace the corresponding probes, so a test or diagnostic can drive the
 * decision from fixed numbers.
 */
export function measureMachine(): MachineGauges {
  const fixture = readMachineFixture();
  const llama = probeLlamaSlots();
  const measured: MachineGauges = {
    agents: envNumber("LLM_ROUTER_FLEET_AGENTS") ?? null,
    loadPerCore: probeLoadPerCore(),
    memoryFreePct: probeMemoryFreePct(),
    memoryPressure: probeMemoryPressure(),
    ...probeSwapValues(),
    suiteSlotFree: envBool("LLM_ROUTER_SUITE_SLOT") ?? null,
    llamaParallel: llama.llamaParallel,
    llamaSlotsTotal: llama.llamaSlotsTotal,
    llamaSlotsBusy: llama.llamaSlotsBusy,
    llamaSlotFree: llama.llamaSlotFree,
  };
  if (measured.agents === null) {
    const { comm, argv, live } = psSnapshots();
    // A replayed snapshot is from another moment (possibly another host), so
    // its own pids must be counted exactly as captured; only a live reading
    // excludes this process's own transient probe tree.
    const exclude = live ? processTreePids(comm, process.pid) : new Set<number>();
    const fleet = readFleet(comm, argv, exclude);
    measured.agents = fleet.agents;
    measured.roots = fleet.roots;
    if (measured.suiteSlotFree === null) measured.suiteSlotFree = suiteSlotFromArgv(argv, exclude);
  }
  return fixture ? { ...measured, ...stripNulls(fixture) } : measured;
}

function probeSwapValues(): { swapUsedPct: number | null; swapouts: number | null } {
  const { usedPct, swapouts } = probeSwap();
  return { swapUsedPct: usedPct, swapouts };
}

function stripNulls(partial: Partial<MachineGauges>): Partial<MachineGauges> {
  const out: Partial<MachineGauges> = {};
  for (const [key, value] of Object.entries(partial)) {
    if (value !== null && value !== undefined) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}
