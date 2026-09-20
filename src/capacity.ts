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
 * it takes the flock.
 */
export type CapacityPurpose = "spawn" | "suite";

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
 * `maxLoadPerCore`, `oneSuiteAtATime`) still fail closed, and the new
 * `memoryPressureMax` / `maxSwapUsedPercent` gates refuse when measured.
 * `oneSuiteAtATime` fails closed only for the `suite` purpose; a `spawn` keeps
 * the slot visible in `measured` but never refuses on it.
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
    roots: probe.roots,
  };
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

  const { agents, loadPerCore, memoryFreePct, memoryPressure, swapUsedPct, suiteSlotFree } = gauges;

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
  if (purpose === "suite" && settings.oneSuiteAtATime && suiteSlotFree === false) {
    reasons.push("the one-suite-at-a-time slot is occupied");
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
      oneSuiteAtATime: settings.oneSuiteAtATime,
      purpose,
      suiteSlotEnforced: purpose === "suite" && settings.oneSuiteAtATime,
    },
    reasons,
  };
}
