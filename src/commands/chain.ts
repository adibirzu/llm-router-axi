import { AxiError } from "axi-sdk-js";

import { parseArgs, type FlagSpec } from "../args.js";
import { planStepDown } from "../fallback.js";
import { loadEffectivePolicy } from "../policy/index.js";
import { helpBlock, toon } from "../render.js";

const CHAIN_FLAGS: FlagSpec[] = [
  {
    name: "--harness",
    value: "harness",
    description: "Harness whose in-run step-down chain to walk",
  },
  {
    name: "--model",
    value: "model",
    description: "The model the task is currently running on (optional)",
  },
  { name: "--json", description: "Emit the step-down as JSON" },
];

export const CHAIN_HELP = `usage: llm-router-axi route chain --harness <harness> [--model <model>] [--json]
description: Walk the policy's in-run model step-down chain and print the next move.
  Mirrors firstmate bin/fm-model-fallback.sh's chain walk: the entry after the
  current model; a model outside its chain steps to the chain head; a walked-out
  chain wraps when listed in modelFallbackCycles, else moves to the next
  fallbackLanes harness, else reports exhausted.
inputs:
  --harness <harness>   harness whose chain to walk (claude, opencode, cursor, agy, ...)
  --model <model>       the currently running model (omit for the chain head)
  --json                emit the raw step-down object
outputs:
  TOON step: action (harness-step|lane-move|exhausted), harness, from_model, to_model,
             to_harness, reason, chain[], fallback_lanes[]
flags[${CHAIN_FLAGS.length + 1}]:
${CHAIN_FLAGS.map((flag) => `  ${flag.name}${flag.value ? ` <${flag.value}>` : ""}`).join(", ")}, --help
examples:
  llm-router-axi route chain --harness opencode
  llm-router-axi route chain --harness opencode --model opencode-go/qwen3.8-flash
  llm-router-axi route chain --harness claude --model haiku
`;

export async function chainCommand(args: string[]): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) {
    return CHAIN_HELP;
  }
  const { values, booleans } = parseArgs("route chain", args, CHAIN_FLAGS);

  const harness = values.get("--harness");
  if (harness === undefined || harness.trim().length === 0) {
    throw new AxiError("route chain is missing required flag: --harness", "VALIDATION_ERROR", [
      "Usage: llm-router-axi route chain --harness <harness> [--model <model>]",
    ]);
  }
  const currentModel = values.get("--model");

  const read = loadEffectivePolicy();
  if (!read.ok) {
    throw new AxiError(read.message, "VALIDATION_ERROR", [
      ...read.issues.map((issue) => `${issue.path}: ${issue.message}`),
      "Run `llm-router-axi policy validate` for the full issue list",
    ]);
  }

  const step = planStepDown(read.policy, harness, currentModel);
  if (booleans.has("--json")) {
    return JSON.stringify(step, null, 2);
  }
  return toon({ step }, helpBlock([
    "Run `llm-router-axi route chain --harness <h> --model <m>` from fm-model-fallback.sh",
    "Run `llm-router-axi policy show --json` to inspect modelFallback and fallbackLanes",
  ]));
}
