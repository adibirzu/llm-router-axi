import { AxiError } from "axi-sdk-js";

import { parseArgs, requireEnum, requireInteger, type FlagSpec } from "../args.js";
import { appendLedgerRow, JEV_FREEZE } from "../jev/shadow.js";
import { loadEffectivePolicy } from "../policy/index.js";
import { collapseHome, helpBlock, toon } from "../render.js";
import { cooldownKeys, setCooldown } from "../selector.js";
import { dispatchStatePath, loadState, saveState, withStateLock } from "../state.js";

const OUTCOME_VALUES = ["rate_limit", "ok"] as const;

const RECORD_FLAGS: FlagSpec[] = [
  { name: "--provider", value: "name", description: "Provider the outcome belongs to" },
  {
    name: "--outcome",
    value: "rate_limit|ok",
    description: "Verified rate-limit/quota failure, or a clean success",
  },
  { name: "--task", value: "id", description: "Task the outcome belongs to" },
  { name: "--now", value: "epoch", description: "Fixed epoch second (test seam)" },
  { name: "--json", description: "Emit JSON instead of TOON" },
];

export const RECORD_HELP = `usage: llm-router-axi record --provider <name> --outcome <rate_limit|ok> --task <id> [flags]
description: Record a provider outcome so the router applies a cooldown.
  The outcome is also appended to the Jev shadow ledger for later
  agreement analysis. ${JEV_FREEZE}
inputs:
  --provider <name>          provider id from usage-axi (claude, cursor, opencode-go, ...)
  --outcome <rate_limit|ok>  a verified rate-limit/quota failure, or a clean success
  --task <id>                task id for the receipt
  --now <epoch>              fix the current epoch second (test seam)
outputs:
  TOON receipt: provider, outcome, task, cooldownUntil (rate_limit only), statePath
  --json  the same receipt as JSON
state:
  ~/.local/state/llm-router-axi   cooldown + least-recent-use ledger
flags[${RECORD_FLAGS.length + 1}]:
${RECORD_FLAGS.map((flag) => `  ${flag.name}${flag.value ? ` <${flag.value}>` : ""}`).join(", ")}, --help
examples:
  llm-router-axi record --provider cursor --outcome rate_limit --task t-42
  llm-router-axi record --provider claude --outcome ok --task t-42 --json
`;

export async function recordCommand(args: string[]): Promise<string> {
  const { values, booleans } = parseArgs("record", args, RECORD_FLAGS);

  const provider = requireNonEmpty(values.get("--provider"), "--provider");
  const task = requireNonEmpty(values.get("--task"), "--task");
  const outcome = requireEnum(values.get("--outcome"), "--outcome", OUTCOME_VALUES);
  const now = requireInteger(values.get("--now"), "--now");

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

  const policy = loadEffectivePolicy();
  if (!policy.ok) {
    throw new AxiError(policy.message, "VALIDATION_ERROR", [
      ...policy.issues.map((issue) => `${issue.path}: ${issue.message}`),
      "Run `llm-router-axi policy validate` for the full issue list",
    ]);
  }
  const cooldownSeconds = policy.policy.routing.cooldownSeconds;
  const recordedAt = now ?? Math.floor(Date.now() / 1000);

  // Slice 3: store the outcome in the shadow ledger alongside the recorded
  // shadow descriptors, so agreement and outcome can later be analysed by
  // `shadow report`. Best-effort and additive: the cooldown receipt above is
  // the contract, and old ledger entries still parse.
  appendLedgerRow({
    v: 1,
    kind: "outcome",
    at: recordedAt,
    task: task as string,
    provider: provider as string,
    outcome: outcome as "rate_limit" | "ok",
  });

  const statePath = dispatchStatePath();
  const receipt = withStateLock(() => {
    const state = loadState();
    if (outcome === "rate_limit") {
      setCooldown(state, provider as string, "recorded-rate-limit-or-quota-failure", recordedAt, cooldownSeconds);
      saveState(state);
      return {
        provider,
        outcome,
        task,
        cooldownUntil: state.cooldowns[provider as string]?.until ?? null,
        statePath: collapseHome(statePath),
      };
    }
    for (const key of cooldownKeys(provider as string)) delete state.cooldowns[key];
    saveState(state);
    return {
      provider,
      outcome,
      task,
      cooldownUntil: null,
      statePath: collapseHome(statePath),
    };
  }, statePath);

  if (booleans.has("--json")) {
    return JSON.stringify(receipt, null, 2);
  }
  return toon({ receipt }, helpBlock([
    "Run `llm-router-axi route ...` to see the cooldown applied",
    "Run `llm-router-axi explain ...` for per-provider reasons",
  ]));
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
