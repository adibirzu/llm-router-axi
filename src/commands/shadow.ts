/**
 * `shadow report`: read-only summary of the slice 3 shadow ledger.
 *
 * Prints descriptor agreement (Jev-derived vs supplied, per field), route
 * agreement (same harness/model/effort preview), and rate_limit outcome
 * counts over the recorded window, plus the proposed go criteria as data.
 * Read-only: no network, no writes, no state changes. It never turns
 * shadow into live routing — the go criteria need a human verdict.
 *
 * Nothing routes real traffic through Jev until the lab's
 * `docs/when-to-route.md` verdict exists and the captain says go.
 */

import { AxiError } from "axi-sdk-js";

import { parseArgs, type FlagSpec } from "../args.js";
import { buildShadowReport, JEV_FREEZE, readLedgerRows } from "../jev/shadow.js";
import { helpBlock, toon } from "../render.js";

const REPORT_FLAGS: FlagSpec[] = [
  { name: "--json", description: "Emit the report as JSON instead of TOON" },
];

export const SHADOW_HELP = `usage: llm-router-axi shadow <report> [flags]
description: Inspect the Jev shadow-mode ledger (slice 3).
  ${JEV_FREEZE}
subcommands[1]:
  report      descriptor agreement, route agreement, and rate_limit outcomes
              over the recorded window, plus the proposed go criteria as data
flags[1]:
  --help
examples:
  llm-router-axi shadow report
  llm-router-axi shadow report --json
ledger:
  ~/.local/state/llm-router-axi/shadow-ledger.jsonl   (LLM_ROUTER_SHADOW_FILE overrides)
`;

const REPORT_HELP = `usage: llm-router-axi shadow report [--json]
description:
  Summarise the shadow ledger: descriptor agreement per field
  (Jev-derived vs supplied), route agreement (same harness/model/effort
  preview), and rate_limit outcome counts, plus the proposed go criteria
  (descriptor agreement >= 85%, route agreement >= 90%, no rise in
  rate_limit outcomes over 100+ tasks) as data, not as a decision.
  Read-only: no network, no writes. It never turns shadow into live routing.
  ${JEV_FREEZE}
outputs:
  TOON report: window, descriptorAgreement, routeAgreement, outcomes, goCriteria
  --json  the same report as JSON
  An empty window reports zeros with every criterion undecided (exit 0).
flags[${REPORT_FLAGS.length + 1}]:
${REPORT_FLAGS.map((flag) => `  ${flag.name}${flag.value ? ` <${flag.value}>` : ""}`).join(", ")}, --help
examples:
  llm-router-axi shadow report
  llm-router-axi shadow report --json
`;

export async function shadowCommand(args: string[]): Promise<string> {
  const sub = args[0];
  if (sub === undefined || sub === "--help" || sub === "-h") {
    return SHADOW_HELP;
  }
  if (sub !== "report") {
    throw new AxiError(`unknown shadow subcommand: ${sub}`, "VALIDATION_ERROR", [
      "Valid subcommands: report",
      "Run `llm-router-axi shadow --help`",
    ]);
  }
  return shadowReport(args.slice(1));
}

function shadowReport(args: string[]): string {
  if (args.includes("--help") || args.includes("-h")) {
    return REPORT_HELP;
  }
  const { booleans } = parseArgs("shadow report", args, REPORT_FLAGS);
  const report = buildShadowReport(readLedgerRows());

  if (booleans.has("--json")) {
    return JSON.stringify(report, null, 2);
  }
  return toon(
    { shadow: report },
    helpBlock([
      "Shadow is data only: Jev output never changes a routing decision",
      "Run `llm-router-axi shadow report --json` for the machine-readable report",
    ]),
  );
}
