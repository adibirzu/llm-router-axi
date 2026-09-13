import { AxiError } from "axi-sdk-js";

import { parseArgs, requireEnum, type FlagSpec } from "../args.js";
import { notImplemented } from "./not-implemented.js";

const OUTCOME_VALUES = ["rate_limit", "ok"] as const;

const RECORD_FLAGS: FlagSpec[] = [
  { name: "--provider", value: "name", description: "Provider that hit the limit" },
  {
    name: "--outcome",
    value: "rate_limit|ok",
    description: "Observed outcome",
  },
  { name: "--task", value: "id", description: "Task the outcome belongs to" },
  { name: "--json", description: "Emit JSON instead of TOON" },
];

export const RECORD_HELP = `usage: llm-router-axi record --provider <name> --outcome <rate_limit|ok> --task <id> [flags]
description: Record a provider outcome so the router can apply cooldowns.
  NOT IMPLEMENTED YET - this is the P2 design contract; it writes no state.
inputs:
  --provider <name>          provider id from usage-axi (claude, cursor, opencode, ...)
  --outcome <rate_limit|ok>  a verified rate-limit/quota failure, or a clean success
  --task <id>                task id for the least-recent-use ledger
outputs (planned):
  TOON receipt: provider, outcome, task, cooldownUntil (rate_limit only), statePath
  --json  the same receipt as JSON
state (planned):
  ~/.local/state/llm-router-axi/   cooldown + least-recent-use ledger (P2 runtime)
flags[4]:
  ${RECORD_FLAGS.map((flag) => flag.name).join(", ")}, --help
examples:
  llm-router-axi record --provider cursor --outcome rate_limit --task t-42
  llm-router-axi record --provider claude --outcome ok --task t-42 --json
`;

export async function recordCommand(args: string[]): Promise<string> {
  const { values, booleans } = parseArgs("record", args, RECORD_FLAGS);

  const provider = requireNonEmpty(values.get("--provider"), "--provider");
  const task = requireNonEmpty(values.get("--task"), "--task");
  const outcome = requireEnum(values.get("--outcome"), "--outcome", OUTCOME_VALUES);

  const missing = [
    provider === undefined ? "--provider" : undefined,
    task === undefined ? "--task" : undefined,
    outcome === undefined ? "--outcome" : undefined,
  ].filter((value): value is string => value !== undefined);
  if (missing.length > 0) {
    throw new AxiError(
      `record is missing required flag${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
      "VALIDATION_ERROR",
      [
        "Usage: llm-router-axi record --provider <name> --outcome <rate_limit|ok> --task <id>",
        "Run `llm-router-axi record --help` for the contract",
      ],
    );
  }

  return notImplemented(
    "record",
    {
      provider: provider ?? null,
      outcome: outcome ?? null,
      task: task ?? null,
      json: booleans.has("--json"),
    },
    [
      "Run `llm-router-axi record --help` for the full contract",
      "Cooldown state is not persisted in the P2 design build",
    ],
  );
}

function requireNonEmpty(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim().length === 0) {
    throw new AxiError(`${flag} must not be empty`, "VALIDATION_ERROR", [
      `Pass a value: ${flag} <value>`,
    ]);
  }
  return value;
}
