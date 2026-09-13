import { readFileSync } from "node:fs";

import { AxiError } from "axi-sdk-js";

import { parseArgs, type FlagSpec } from "../args.js";
import { classifyEvidence } from "../selector.js";

const CLASSIFY_FLAGS: FlagSpec[] = [
  { name: "--file", value: "path", description: "Read evidence text from this file instead of stdin" },
];

export const CLASSIFY_HELP = `usage: llm-router-axi classify-evidence [--file <path>]
description:
  The pure depletion detector shared by record and fm-model-fallback: read
  evidence text from --file or stdin and print exactly one classification.
  Subscription vocabulary only - a framed 429, rate limit, RESOURCE_EXHAUSTED,
  or a named quota/credit/allowance limit being exhausted. Working ceilings are
  not depletion.
outputs:
  classification=none
  classification=depleted
  signature="<matched substring>"
flags[${CLASSIFY_FLAGS.length + 1}]:
${CLASSIFY_FLAGS.map((flag) => `  ${flag.name}${flag.value ? ` <${flag.value}>` : ""}`).join(", ")}, --help
examples:
  llm-router-axi classify-evidence --file task.status
  printf 'failed: request failed with status code 429' | llm-router-axi classify-evidence
`;

export async function classifyCommand(args: string[]): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) {
    return CLASSIFY_HELP;
  }
  const { values } = parseArgs("classify-evidence", args, CLASSIFY_FLAGS);
  const file = values.get("--file");
  let text: string;
  try {
    text = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
  } catch {
    throw new AxiError(
      "classify-evidence requires a readable --file or stdin text",
      "VALIDATION_ERROR",
      ["Pass `--file <path>` or pipe the evidence text on stdin"],
    );
  }
  const match = classifyEvidence(text);
  if (!match) return "classification=none\n";
  return `classification=depleted\nsignature=${JSON.stringify(match)}\n`;
}
