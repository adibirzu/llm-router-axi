import { parseArgs, requireEnum, requireInteger, type FlagSpec } from "../args.js";
import {
  DECISION_FIELDS,
  DESCRIPTOR_FLAGS,
  DIFFICULTY_VALUES,
  FM_SPAWN_FLAGS,
  KIND_VALUES,
  SURFACE_VALUES,
} from "./descriptor.js";
import { notImplemented } from "./not-implemented.js";

const ROUTE_FLAGS: FlagSpec[] = [
  ...DESCRIPTOR_FLAGS,
  { name: "--flags", description: `Print ${FM_SPAWN_FLAGS} for fm-spawn` },
];

export const ROUTE_HELP = `usage: llm-router-axi route --kind <kind> --difficulty <level> --surface <surface> [flags]
description: Choose one harness/model/effort from the policy lanes plus live usage.
  NOT IMPLEMENTED YET - this is the P2 design contract; it emits no decision.
inputs:
  --kind <ship|scout|review|architecture|admin>
  --difficulty <easy|medium|hard>
  --surface <backend|frontend|docs|infra|mixed>
  --size <changed-lines>       optional size hint
  --needs <a,b,c>              optional capability needs (vision, long-context, tools)
  --project <name>             optional project scope
  --usage-json <path>          usage telemetry fixture instead of usage-axi
outputs (planned):
  TOON decision: ${DECISION_FIELDS.join(", ")}
  --json   the same decision as JSON
  --flags  fm-spawn flags: ${FM_SPAWN_FLAGS}
flags[${ROUTE_FLAGS.length + 1}]:
${ROUTE_FLAGS.map((flag) => `  ${flag.name}${flag.value ? ` <${flag.value}>` : ""}`).join(", ")}, --help
examples:
  llm-router-axi route --kind ship --difficulty medium --surface backend
  llm-router-axi route --kind review --difficulty hard --surface docs --json
  llm-router-axi route --kind scout --difficulty easy --surface mixed --flags
`;

export async function routeCommand(args: string[]): Promise<string> {
  const { values, booleans } = parseArgs("route", args, ROUTE_FLAGS);

  const kind = requireEnum(values.get("--kind"), "--kind", KIND_VALUES);
  const difficulty = requireEnum(
    values.get("--difficulty"),
    "--difficulty",
    DIFFICULTY_VALUES,
  );
  const surface = requireEnum(values.get("--surface"), "--surface", SURFACE_VALUES);
  const size = requireInteger(values.get("--size"), "--size");
  const needs = parseCsv(values.get("--needs"));

  return notImplemented(
    "route",
    {
      kind: kind ?? null,
      difficulty: difficulty ?? null,
      surface: surface ?? null,
      size: size ?? null,
      needs,
      project: values.get("--project") ?? null,
      usageJson: values.get("--usage-json") ?? null,
      json: booleans.has("--json"),
      flags: booleans.has("--flags"),
    },
    [
      "Run `llm-router-axi route --help` for the full contract",
      "Run `llm-router-axi policy show` to inspect the lanes this will draw from",
      "Track the usage-axi contract (P1); route selection lands with it",
    ],
  );
}

export function parseCsv(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
