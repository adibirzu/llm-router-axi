import { AxiError } from "axi-sdk-js";

import { evaluateGauges, type CapacityPurpose } from "../capacity.js";
import { measureMachine, type MachineGauges } from "../machine.js";
import { parseArgs, requireEnum, type FlagSpec } from "../args.js";
import { loadEffectivePolicy } from "../policy/index.js";
import type { Policy } from "../policy/types.js";
import { helpBlock, toon } from "../render.js";

const CAPACITY_FLAGS: FlagSpec[] = [
  { name: "--json", description: "Emit the gauges and verdict as JSON" },
  {
    name: "--for",
    value: "spawn|suite",
    description:
      "Admission purpose: spawn (default) never refuses on the suite slot; suite refuses when oneSuiteAtATime is true and it is occupied",
  },
];

export const CAPACITY_HELP = `usage: llm-router-axi capacity [check] [--for <spawn|suite>] [--json]
description:
  Report the machine gauges the router uses, measured from local probes (ported
  from firstmate bin/fm-capacity-lib.sh), against the policy capacity thresholds.
  Two admission purposes share one verdict:
    spawn (default)  gate an agent launch; the suite slot is context only.
    suite            gate a test-suite start; refuses when oneSuiteAtATime is
                     true and the slot is occupied. This is what fm-test-run.sh
                     calls before starting a suite.
  check exits 1 when the selected purpose has no headroom; a bare spawn report
  exits 0.
gauges: free memory percent, memory pressure level, swap in use, worker-root
        agent count, load per core, one-suite-at-a-time slot.
inputs:
  check                verify only; exit 1 when the selected purpose would refuse
  --for <spawn|suite>  admission purpose; spawn (default) ignores the suite slot
                       for refusal, suite enforces oneSuiteAtATime
  --json               emit {ok, measured, reasons, signals[]} as JSON
flags[${CAPACITY_FLAGS.length + 1}]:
${CAPACITY_FLAGS.map((flag) => `  ${flag.name}${flag.value ? ` <${flag.value}>` : ""}`).join(", ")}, --help
examples:
  llm-router-axi capacity
  llm-router-axi capacity check
  llm-router-axi capacity --for suite
  llm-router-axi capacity --json
`;

export async function capacityCommand(args: string[]): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) {
    return CAPACITY_HELP;
  }
  const verb = args[0] === "check" ? "check" : undefined;
  const rest = verb ? args.slice(1) : args;
  const { values, booleans } = parseArgs("capacity", rest, CAPACITY_FLAGS);
  const purpose: CapacityPurpose =
    requireEnum(values.get("--for"), "--for", ["spawn", "suite"] as const) ?? "spawn";

  const read = loadEffectivePolicy();
  if (!read.ok) {
    throw new AxiError(read.message, "VALIDATION_ERROR", [
      ...read.issues.map((issue) => `${issue.path}: ${issue.message}`),
      "Run `llm-router-axi policy validate` for the full issue list",
    ]);
  }

  const gauges = measureMachine();
  const verdict = evaluateGauges(read.policy, gauges, purpose);
  const signals = signalRows(read.policy, gauges, verdict, purpose);

  // A `suite` request is itself an admission check, so a bare `--for suite`
  // fails closed just like `check`; a bare spawn report stays a read-only view.
  if ((verb === "check" || purpose === "suite") && !verdict.ok) {
    process.exitCode = 1;
  }
  if (booleans.has("--json")) {
    return JSON.stringify({ ...verdict, signals }, null, 2);
  }
  return toon(
    {
      capacity: {
        ok: verdict.ok,
        purpose,
        summary: verdict.ok
          ? "headroom available"
          : `no headroom: ${verdict.reasons.join("; ")}`,
      },
    },
    { signals },
    helpBlock([
      "Run `llm-router-axi route --kind ship --difficulty medium --surface backend --flags` to dispatch",
      "Run `llm-router-axi capacity --for suite` before starting a test suite",
      "Raise or switch off a threshold in `llm-router-axi policy show --json`",
    ]),
  );
}

function signalRows(
  policy: Policy,
  gauges: MachineGauges,
  verdict: ReturnType<typeof evaluateGauges>,
  purpose: CapacityPurpose,
): Array<Record<string, unknown>> {
  const settings = policy.capacity;
  const status = (reasonNeedle: string): string =>
    verdict.reasons.some((reason) => reason.includes(reasonNeedle)) ? "OVER" : "ok";
  const slotMeasurement = (): string => {
    if (gauges.suiteSlotFree === null) return "unknown";
    return gauges.suiteSlotFree ? "free" : "occupied";
  };
  const suiteEnforced = settings.oneSuiteAtATime && purpose === "suite";
  return [
    {
      signal: "memory free",
      measured: gauges.memoryFreePct === null ? "unknown" : `${gauges.memoryFreePct}%`,
      wanted: `at least ${settings.memoryFreeReservePercent}% free`,
      verdict: status("memory free"),
    },
    {
      signal: "memory pressure",
      measured: gauges.memoryPressure ?? "unknown",
      wanted: `at most ${settings.memoryPressureMax ?? "warn"}`,
      verdict: status("memory pressure"),
    },
    {
      signal: "swap in use",
      measured: gauges.swapUsedPct === null ? "unknown" : `${gauges.swapUsedPct}%`,
      wanted:
        settings.maxSwapUsedPercent === null || settings.maxSwapUsedPercent === undefined
          ? "not checked"
          : `at most ${settings.maxSwapUsedPercent}%`,
      verdict:
        settings.maxSwapUsedPercent === null || settings.maxSwapUsedPercent === undefined
          ? "context"
          : status("swap in use"),
    },
    {
      signal: "worker-root agents",
      measured: gauges.agents ?? "unknown",
      wanted: `under ${settings.agentCeiling}`,
      verdict: status("-agent ceiling"),
    },
    {
      signal: "load per core",
      measured: gauges.loadPerCore ?? "unknown",
      wanted: `at most ${settings.maxLoadPerCore}`,
      verdict: status("load per core"),
    },
    {
      signal: "suite slot",
      measured: slotMeasurement(),
      wanted: !settings.oneSuiteAtATime
        ? "not checked"
        : purpose === "suite"
          ? "free"
          : "free (context for spawn)",
      verdict: suiteEnforced ? status("one-suite") : "context",
    },
  ];
}
