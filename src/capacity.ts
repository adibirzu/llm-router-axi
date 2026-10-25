import { measureMachine, type MachineGauges, type MemoryPressureLevel } from "./machine.js";
import type { Policy } from "./policy/types.js";
import type { MachineTelemetry, QuotaRead } from "./selector.js";

export interface CapacityVerdict {
  ok: boolean;
  measured: Record<string, unknown>;
  reasons: string[];
}

/**
 * What the verdict is admitting. A `spawn` (agent launch) is never refused
 * because a test suite is running: the suite slot is context, because the
 * one-suite rule serializes suite *starts*, not agent spawns. A `suite` start
 * gates on the slot, so `fm-test-run.sh` can call `capacity --for suite` before
 * it takes the flock. `local-llm` gates a local-Qwen agent launch on the
 * llama.cpp `--parallel` slot pool instead of the fleet-wide agent ceiling.
 */
export type CapacityPurpose = "spawn" | "suite" | "local-llm";

const PRESSURE_RANK: Record<"normal" | "warn" | "critical", number> = {
  normal: 0,
  warn: 1,
  critical: 2,
};

/**
 * Fold the machine gauges and the policy's capacity doctrine into one verdict.
 * Thresholds live in the policy; the measurements come from usage-axi's
 * `machine{}` first, then the local probes ported from `fm-capacity-lib.sh`.
 *
 * Unlike the fork's spawn guard, an unreadable gauge never refuses: a route is
 * not a spawn admission, and refusing on an absent probe would make routing
 * fragile. The binding floors (`agentCeiling`, `memoryFreeReservePercent`,
 * `maxLoadPerCore`, `maxConcurrentSuites`) still fail closed, and the new
 * `memoryPressureMax` / `maxSwapUsedPercent` gates refuse when measured.
 * The suite cap refuses only for the `suite` purpose; a `spawn` keeps the
 * running count visible in `measured` but never refuses on it.
 */
export function capacityVerdict(
  policy: Policy,
  quota: QuotaRead,
  purpose: CapacityPurpose = "spawn",
): CapacityVerdict {
  return evaluateGauges(policy, mergeGauges(quota), purpose);
}

/** Merge telemetry machine fields over the local/fixture measurement. */
export function mergeGauges(
  quota: QuotaRead,
  probe: MachineGauges = measureMachine(),
): MachineGauges {
  const machine: MachineTelemetry | undefined = quota.available
    ? quota.data.machine
    : undefined;
  return {
    agents: machine?.agents ?? probe.agents,
    loadPerCore: machine?.loadPerCore ?? probe.loadPerCore,
    memoryFreePct: machine?.memoryFreePct ?? probe.memoryFreePct,
    memoryPressure: (machine?.memoryPressure as MemoryPressureLevel) ?? probe.memoryPressure,
    swapUsedPct: machine?.swapUsedPct ?? probe.swapUsedPct,
    swapouts: machine?.swapouts ?? probe.swapouts,
    suiteSlotFree: machine?.suiteSlotFree ?? probe.suiteSlotFree,
    suiteCount: machine?.suiteCount ?? probe.suiteCount ?? null,
    llamaParallel: machine?.llamaParallel ?? probe.llamaParallel,
    llamaSlotsTotal: machine?.llamaSlotsTotal ?? probe.llamaSlotsTotal,
    llamaSlotsBusy: machine?.llamaSlotsBusy ?? probe.llamaSlotsBusy,
    llamaSlotFree: machine?.llamaSlotFree ?? probe.llamaSlotFree,
    roots: probe.roots,
  };
}

/**
 * How many test suites may run at once: `maxConcurrentSuites` when set, else
 * the legacy `oneSuiteAtATime` alias (true is a cap of 1, false is no cap).
 * `null` means uncapped.
 */
export function suiteLimit(settings: Policy["capacity"]): number | null {
  if (typeof settings.maxConcurrentSuites === "number") return settings.maxConcurrentSuites;
  return settings.oneSuiteAtATime ? 1 : null;
}

/**
 * Running suites as the gauges report them. A measured `suiteCount` wins, but
 * an occupied legacy `suiteSlotFree: false` (usage-axi, older fixtures) is at
 * least one suite, so the larger of the two readings is used. Null when
 * neither is readable.
 */
export function runningSuites(gauges: MachineGauges): number | null {
  const counted = typeof gauges.suiteCount === "number" ? gauges.suiteCount : null;
  const implied = gauges.suiteSlotFree === false ? 1 : gauges.suiteSlotFree === true ? 0 : null;
  if (counted === null) return implied;
  return implied === null ? counted : Math.max(counted, implied);
}

/** Evaluate a fixed set of gauges against the policy; pure and testable. */
export function evaluateGauges(
  policy: Policy,
  gauges: MachineGauges,
  purpose: CapacityPurpose = "spawn",
): CapacityVerdict {
  const settings = policy.capacity;
  const reasons: string[] = [];
  const memoryPressureMax = settings.memoryPressureMax ?? "warn";
  const maxSwapUsedPercent = settings.maxSwapUsedPercent ?? null;

  const {
    agents,
    loadPerCore,
    memoryFreePct,
    memoryPressure,
    swapUsedPct,
    suiteSlotFree,
    llamaParallel,
    llamaSlotsTotal,
    llamaSlotsBusy,
    llamaSlotFree,
  } = gauges;
  const suiteMax = suiteLimit(settings);
  const suites = runningSuites(gauges);

  if (typeof agents === "number" && agents >= settings.agentCeiling) {
    reasons.push(`fleet is at or above the ${settings.agentCeiling}-agent ceiling (agents=${agents})`);
  }
  if (typeof loadPerCore === "number" && loadPerCore > settings.maxLoadPerCore) {
    reasons.push(`load per core ${loadPerCore} exceeds the ${settings.maxLoadPerCore} ceiling`);
  }
  if (typeof memoryFreePct === "number" && memoryFreePct < settings.memoryFreeReservePercent) {
    reasons.push(
      `memory free ${memoryFreePct}% is under the ${settings.memoryFreeReservePercent}% reserve`,
    );
  }
  if (
    memoryPressureMax !== "ignore" &&
    memoryPressure !== null &&
    PRESSURE_RANK[memoryPressure] > PRESSURE_RANK[memoryPressureMax]
  ) {
    reasons.push(
      `memory pressure is ${memoryPressure} (the kernel is reclaiming memory); policy admits up to ${memoryPressureMax}`,
    );
  }
  if (
    maxSwapUsedPercent !== null &&
    typeof swapUsedPct === "number" &&
    swapUsedPct > maxSwapUsedPercent
  ) {
    reasons.push(
      `swap in use ${swapUsedPct}% exceeds the ${maxSwapUsedPercent}% ceiling`,
    );
  }
  if (purpose === "suite" && suiteMax !== null && suites !== null && suites >= suiteMax) {
    reasons.push(`the test-suite slots are full (${suites} running, limit ${suiteMax})`);
  }
  // local-llm purpose: refuse when every llama.cpp parallel slot is busy.
  // Unreadable probes never refuse (same doctrine as other gauges).
  if (purpose === "local-llm" && llamaSlotFree === false) {
    const total = llamaSlotsTotal ?? llamaParallel ?? settings.llamaParallel ?? 2;
    const busy = llamaSlotsBusy ?? total;
    reasons.push(
      `local llama slots are full (${busy}/${total}); wait for a free slot before raising another local-qwen agent`,
    );
  }

  return {
    ok: reasons.length === 0,
    measured: {
      agents,
      agentCeiling: settings.agentCeiling,
      loadPerCore,
      maxLoadPerCore: settings.maxLoadPerCore,
      memoryFreePct,
      memoryFreeReservePercent: settings.memoryFreeReservePercent,
      memoryPressure,
      memoryPressureMax,
      swapUsedPct,
      swapouts: gauges.swapouts,
      maxSwapUsedPercent,
      suiteSlotFree,
      suiteCount: suites,
      maxConcurrentSuites: suiteMax,
      oneSuiteAtATime: settings.oneSuiteAtATime,
      llamaParallel: llamaParallel ?? settings.llamaParallel ?? 2,
      llamaSlotsTotal,
      llamaSlotsBusy,
      llamaSlotFree,
      purpose,
      suiteSlotEnforced: purpose === "suite" && suiteMax !== null,
      llamaSlotEnforced: purpose === "local-llm",
    },
    reasons,
  };
}
