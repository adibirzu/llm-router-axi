import { AxiError } from "axi-sdk-js";

import { parseArgs, requireEnum, requireInteger, type FlagSpec } from "../args.js";
import {
  DECISION_FIELDS,
  DESCRIPTOR_FLAGS,
  DIFFICULTY_VALUES,
  FM_SPAWN_FLAGS,
  KIND_VALUES,
  SURFACE_VALUES,
} from "./descriptor.js";
import { chainCommand } from "./chain.js";
import { evaluateDescriptor } from "./evaluate.js";
import { JEV_FREEZE, runRouteShadow, type ShadowDecision } from "../jev/shadow.js";
import type { FetchImpl } from "../jev/client.js";
import { helpBlock, toon } from "../render.js";
import type { RouterResult } from "../router.js";

const ROUTE_FLAGS: FlagSpec[] = [
  ...DESCRIPTOR_FLAGS,
  { name: "--task", value: "text|file|-", description: "Task text for the Jev shadow hook only; never affects the routing decision" },
  { name: "--flags", description: `Print ${FM_SPAWN_FLAGS} for fm-spawn` },
];

export const ROUTE_HELP = `usage: llm-router-axi route --kind <kind> --difficulty <level> [--surface <surface>] [flags]
description: Choose one harness/model/effort from the policy lanes plus live usage.
  Spawn admission never refuses because a test suite is running; gate a suite
  start with \`llm-router-axi capacity --for suite\`.
  ${JEV_FREEZE}
inputs:
  --kind <ship|scout|review|architecture|admin>
  --difficulty <easy|medium|hard>
  --surface <backend|frontend|docs|infra|mixed>
  --size <changed-lines>       optional size hint
  --needs <a,b,c>              optional capability needs (vision, long-context, tools)
  --project <name>             optional project scope
  --task <text|file|->         task text for the Jev shadow hook only (never affects routing; recorded only when jev.shadow is enabled)
  --usage-json <path>          usage telemetry fixture instead of usage-axi
  --now <epoch>                fix the current epoch second (test seam)
  --json                       emit the same decision as JSON
  --flags                      print exactly ${FM_SPAWN_FLAGS}
outputs:
  TOON decision: ${DECISION_FIELDS.join(", ")}
flags[${ROUTE_FLAGS.length + 1}]:
${ROUTE_FLAGS.map((flag) => `  ${flag.name}${flag.value ? ` <${flag.value}>` : ""}`).join(", ")}, --help
examples:
  llm-router-axi route --kind ship --difficulty medium --surface backend
  llm-router-axi route --kind review --difficulty hard --surface docs --json
  llm-router-axi route --kind scout --difficulty easy --surface mixed --flags
`;

export interface RouteDeps {
  /** Injected Jev transport for the shadow hook (tests stub this; the CLI uses global fetch). */
  fetchImpl?: FetchImpl;
  /** Shadow total budget and per-attempt classify timeout in ms (test seam). */
  timeoutMs?: number;
}

export async function routeCommand(args: string[], deps: RouteDeps = {}): Promise<string> {
  if (args[0] === "chain") {
    return chainCommand(args.slice(1));
  }
  if (args.includes("--help") || args.includes("-h")) {
    return ROUTE_HELP;
  }
  const { values, booleans } = parseArgs("route", args, ROUTE_FLAGS);

  const kind = requireEnum(values.get("--kind"), "--kind", KIND_VALUES);
  const difficulty = requireEnum(
    values.get("--difficulty"),
    "--difficulty",
    DIFFICULTY_VALUES,
  );
  const surface = requireEnum(values.get("--surface"), "--surface", SURFACE_VALUES);
  const now = requireInteger(values.get("--now"), "--now");

  const missing = [
    kind === undefined ? "--kind" : undefined,
    difficulty === undefined ? "--difficulty" : undefined,
  ].filter((value): value is string => value !== undefined);
  if (missing.length > 0) {
    throw new AxiError(
      `route is missing required flag${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
      "VALIDATION_ERROR",
      ["Usage: llm-router-axi route --kind <kind> --difficulty <level>"],
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

  // Slice 3 shadow hook: bounded, silent, and read-only. It records the
  // Jev-derived descriptor next to the supplied one and never changes the
  // decision, the output, or the exit code computed below.
  const taskRaw = values.get("--task");
  await runRouteShadow(
    {
      policy: evaluation.policy,
      kind: kind as string,
      difficulty: difficulty as string,
      ...(surface ? { surface: surface as string } : {}),
      ...(taskRaw !== undefined ? { taskRaw } : {}),
      ...(usageJson ? { usageJson } : {}),
      now: evaluation.now,
      decision: toShadowDecision(result.decision),
    },
    {
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    },
  );

  if (!result.report.ok || !result.decision) {
    return renderRefusal(result);
  }

  if (!result.capacity.ok) {
    return renderCapacityRefusal(result);
  }

  if (booleans.has("--flags")) {
    return spawnFlags(result);
  }
  if (booleans.has("--json")) {
    return JSON.stringify(result.decision, null, 2);
  }
  return toon(
    { decision: result.decision },
    helpBlock([
      `Run \`llm-router-axi route --kind ${kind} --difficulty ${difficulty} --flags\` for fm-spawn flags`,
      "Run `llm-router-axi explain ...` to see why each candidate was accepted or dropped",
    ]),
  );
}

/**
 * `--flags` prints exactly the fm-spawn flags, omitting an unset axis and
 * nothing else.
 */
function spawnFlags(result: RouterResult): string {
  const decision = result.decision;
  if (!decision) {
    return "";
  }
  const parts = [`--harness ${decision.harness}`];
  if (decision.model) parts.push(`--model ${decision.model}`);
  if (decision.effort) parts.push(`--effort ${decision.effort}`);
  return parts.join(" ");
}

function renderRefusal(result: RouterResult): string {
  process.exitCode = 1;
  return toon(
    {
      error: "no subscription candidate has current dispatch capacity evidence",
      code: "NO_ELIGIBLE_CANDIDATE",
      reason: result.report.reason ?? "no eligible candidate",
    },
    { candidates: candidateRows(result) },
    { capacity: result.capacity },
    helpBlock([
      "Run `llm-router-axi explain ...` for the per-candidate reasons",
      "Run `llm-router-axi policy show --full` to inspect the candidate chain",
    ]),
  );
}

function renderCapacityRefusal(result: RouterResult): string {
  process.exitCode = 1;
  return toon(
    {
      error: "route refused by machine capacity",
      code: "CAPACITY_REFUSED",
      reasons: result.capacity.reasons,
    },
    { capacity: result.capacity },
    helpBlock([
      "Wait for the fleet to drain, then route again",
      "Run `usage-axi machine` for the live measurement",
    ]),
  );
}

/**
 * Project the routing decision onto the shadow ledger's decision shape.
 * Refusals (no decision) become null; the hook records, never decides.
 */
function toShadowDecision(
  decision: RouterResult["decision"],
): ShadowDecision | null {
  if (!decision) return null;
  return {
    harness: decision.harness,
    ...(decision.model ? { model: decision.model } : {}),
    ...(decision.effort ? { effort: decision.effort } : {}),
  };
}

/** Shared candidate table for `explain` and route refusals. */
export function candidateRows(result: RouterResult): Array<Record<string, unknown>> {
  const byProfile = new Map(result.evaluations.map((evaluation) => [evaluation.profile, evaluation]));
  return result.routes.map((route, index) => {
    const evaluation = byProfile.get(route.profile);
    const pool = route.candidate.pool ?? route.profile.poolLabel ?? null;
    return {
      rank: index + 1,
      harness: route.profile.harness,
      provider: route.profile.provider,
      pool: pool ?? "provider-wide",
      model: route.profile.model ?? "harness-default",
      decision: evaluation?.eligible ? "eligible" : "refused",
      reason: evaluation?.reason ?? "not evaluated",
    };
  });
}
