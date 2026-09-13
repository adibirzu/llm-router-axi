import type { Policy } from "./policy/types.js";
import type { MachineTelemetry, QuotaRead } from "./selector.js";

export interface CapacityVerdict {
  ok: boolean;
  measured: Record<string, unknown>;
  reasons: string[];
}

/**
 * Fold `usage-axi machine{}` and the policy's capacity doctrine into one
 * verdict. Thresholds live in the policy; the measurements come from telemetry.
 */
export function capacityVerdict(policy: Policy, quota: QuotaRead): CapacityVerdict {
  const machine: MachineTelemetry | undefined = quota.available
    ? quota.data.machine
    : undefined;
  const settings = policy.capacity;

  if (!machine) {
    return {
      ok: true,
      measured: { available: false },
      reasons: [],
    };
  }

  const reasons: string[] = [];
  const agents = machine.agents ?? null;
  const loadPerCore = machine.loadPerCore ?? null;
  const memoryFreePct = machine.memoryFreePct ?? null;
  const suiteSlotFree = machine.suiteSlotFree ?? null;

  if (typeof agents === "number" && agents >= settings.agentCeiling) {
    reasons.push(`fleet is at or above the ${settings.agentCeiling}-agent ceiling (agents=${agents})`);
  }
  if (typeof loadPerCore === "number" && loadPerCore > settings.maxLoadPerCore) {
    reasons.push(
      `load per core ${loadPerCore} exceeds the ${settings.maxLoadPerCore} ceiling`,
    );
  }
  if (typeof memoryFreePct === "number" && memoryFreePct < settings.memoryFreeReservePercent) {
    reasons.push(
      `memory free ${memoryFreePct}% is under the ${settings.memoryFreeReservePercent}% reserve`,
    );
  }
  if (settings.oneSuiteAtATime && suiteSlotFree === false) {
    reasons.push("the one-suite-at-a-time slot is occupied");
  }

  return {
    ok: reasons.length === 0,
    measured: {
      available: true,
      agents,
      agentCeiling: settings.agentCeiling,
      loadPerCore,
      maxLoadPerCore: settings.maxLoadPerCore,
      memoryFreePct,
      memoryFreeReservePercent: settings.memoryFreeReservePercent,
      suiteSlotFree,
      oneSuiteAtATime: settings.oneSuiteAtATime,
    },
    reasons,
  };
}
