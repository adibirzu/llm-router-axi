import { parseArgs, requireEnum, requireInteger } from "../args.js";
import {
  DESCRIPTOR_FLAGS,
  DIFFICULTY_VALUES,
  KIND_VALUES,
  SURFACE_VALUES,
} from "./descriptor.js";
import { notImplemented } from "./not-implemented.js";
import { parseCsv } from "./route.js";

export const EXPLAIN_HELP = `usage: llm-router-axi explain --kind <kind> --difficulty <level> --surface <surface> [flags]
description: Show why each policy candidate was accepted or rejected.
  NOT IMPLEMENTED YET - this is the P2 design contract; it emits no ranking.
inputs:
  --kind <ship|scout|review|architecture|admin>
  --difficulty <easy|medium|hard>
  --surface <backend|frontend|docs|infra|mixed>
  --size <changed-lines>   optional size hint
  --needs <a,b,c>          optional capability needs
  --project <name>         optional project scope
  --usage-json <path>      usage telemetry fixture instead of usage-axi
outputs (planned):
  TOON candidates[]: harness, provider, pool, decision (eligible|refused), reason
  rejection reasons reuse the selector strings quoted in docs/design.md, e.g.
    "provider telemetry not fresh", "quota headroom N% is at or below R% reserve",
    "declared quota window <id> is absent from provider telemetry"
flags[8]:
  ${DESCRIPTOR_FLAGS.map((flag) => flag.name).join(", ")}, --help
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
  const surface = requireEnum(values.get("--surface"), "--surface", SURFACE_VALUES);
  const size = requireInteger(values.get("--size"), "--size");

  return notImplemented(
    "explain",
    {
      kind: kind ?? null,
      difficulty: difficulty ?? null,
      surface: surface ?? null,
      size: size ?? null,
      needs: parseCsv(values.get("--needs")),
      project: values.get("--project") ?? null,
      usageJson: values.get("--usage-json") ?? null,
      json: booleans.has("--json"),
    },
    [
      "Run `llm-router-axi explain --help` for the full contract",
      "Run `llm-router-axi policy show` to inspect the candidate lanes",
      "Rejection strings are frozen in docs/design.md for selector parity",
    ],
  );
}
