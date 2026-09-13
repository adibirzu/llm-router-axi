import { AxiError } from "axi-sdk-js";

import { parseArgs, requireEnum, requireInteger } from "../args.js";
import {
  DESCRIPTOR_FLAGS,
  DIFFICULTY_VALUES,
  KIND_VALUES,
  SURFACE_VALUES,
} from "./descriptor.js";
import { evaluateDescriptor } from "./evaluate.js";
import { candidateRows } from "./route.js";
import { helpBlock, toon } from "../render.js";

export const EXPLAIN_HELP = `usage: llm-router-axi explain --kind <kind> --difficulty <level> [--surface <surface>] [flags]
description: Show why each policy candidate was accepted or rejected.
inputs:
  --kind <ship|scout|review|architecture|admin>
  --difficulty <easy|medium|hard>
  --surface <backend|frontend|docs|infra|mixed>
  --size <changed-lines>   optional size hint
  --needs <a,b,c>          optional capability needs
  --project <name>         optional project scope
  --usage-json <path>      usage telemetry fixture instead of usage-axi
  --now <epoch>            fix the current epoch second (test seam)
  --json                   emit the same table as JSON
outputs:
  TOON candidates[]: harness, provider, pool, model, decision (eligible|refused), reason
  rejection reasons reuse the frozen selector strings, e.g.
    "provider telemetry not fresh", "quota headroom N% is at or below R% reserve",
    "declared quota window <id> is absent from provider telemetry"
flags[${DESCRIPTOR_FLAGS.length + 1}]:
${DESCRIPTOR_FLAGS.map((flag) => `  ${flag.name}${flag.value ? ` <${flag.value}>` : ""}`).join(", ")}, --help
examples:
  llm-router-axi explain --kind review --difficulty hard --surface docs
  llm-router-axi explain --kind ship --difficulty medium --surface backend --usage-json usage.json
`;

export async function explainCommand(args: string[]): Promise<string> {
  const { values, booleans } = parseArgs("explain", args, DESCRIPTOR_FLAGS);

  const kind = requireEnum(values.get("--kind"), "--kind", KIND_VALUES);
  const difficulty = requireEnum(
    values.get("--difficulty"),
    "--difficulty",
    DIFFICULTY_VALUES,
  );
  requireEnum(values.get("--surface"), "--surface", SURFACE_VALUES);
  const now = requireInteger(values.get("--now"), "--now");

  const missing = [
    kind === undefined ? "--kind" : undefined,
    difficulty === undefined ? "--difficulty" : undefined,
  ].filter((value): value is string => value !== undefined);
  if (missing.length > 0) {
    throw new AxiError(
      `explain is missing required flag${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
      "VALIDATION_ERROR",
      ["Usage: llm-router-axi explain --kind <kind> --difficulty <level>"],
    );
  }

  const usageJson = values.get("--usage-json");
  const evaluation = evaluateDescriptor({
    kind: kind as (typeof KIND_VALUES)[number],
    difficulty: difficulty as (typeof DIFFICULTY_VALUES)[number],
    ...(usageJson ? { usageJson } : {}),
    ...(now !== undefined ? { now } : {}),
  });
  const { result } = evaluation;

  const selected = result.decision
    ? {
        harness: result.decision.harness,
        model: result.decision.model ?? "harness-default",
        effort: result.decision.effort ?? null,
        provider: result.decision.provider,
        pool: result.decision.pool ?? null,
      }
    : null;

  const payload = {
    descriptor: {
      kind,
      difficulty,
      now: evaluation.now,
    },
    selected,
    reason: result.decision?.reason ?? result.report.reason ?? null,
    capacity: result.capacity,
    candidates: candidateRows(result),
  };

  if (booleans.has("--json")) {
    return JSON.stringify(payload, null, 2);
  }
  return toon(payload, helpBlock([
    "Run `llm-router-axi route ... --flags` to dispatch the chosen candidate",
    "Rejection reasons are the frozen firstmate selector strings (docs/design.md §5)",
  ]));
}
