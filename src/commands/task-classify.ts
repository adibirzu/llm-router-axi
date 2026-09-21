/**
 * `classify --task ...`: describe a task in, get a task descriptor out.
 *
 * Slice 1 ONLY classifies. It never changes a routing decision and `route`
 * is untouched: `route` keeps taking explicit `--kind/--difficulty/--surface`
 * flags, and capacity/reserve/cooldown logic is exactly as is. Nothing
 * routes real traffic through Jev until the lab's `docs/when-to-route.md`
 * verdict exists and the captain says go.
 */

import { existsSync, readFileSync, statSync } from "node:fs";

import { AxiError } from "axi-sdk-js";

import { parseArgs, type FlagSpec } from "../args.js";
import { helpBlock, toon } from "../render.js";
import {
  evaluateSystemOne,
  JEV_KEY_ENV,
  JevError,
  type FetchImpl,
} from "../jev/client.js";
import { heuristicClassify } from "../jev/fallback.js";
import { CLASSIFY_QUESTIONS, mapClassifyAnswers } from "../jev/questions.js";
import { isClassifyResult, JEV_MIN_CONFIDENCE, type ClassifyResult } from "../jev/schema.js";

const TASK_CLASSIFY_FLAGS: FlagSpec[] = [
  {
    name: "--task",
    value: "text|file|-",
    description: "Task descriptor: literal text, a path to read, or - for stdin",
  },
  { name: "--json", description: "Emit the classification as JSON" },
  { name: "--full", description: "Include per-option probabilities and latency" },
];

export const TASK_CLASSIFY_HELP = `usage: llm-router-axi classify --task <text|file|-> [--json] [--full]
description:
  Classify a task descriptor into the enums route accepts (kind, difficulty,
  surface) plus classifier-only enrichments (reasoningClass, riskClass,
  toolAffinity), each with a probability/confidence. Slice 1 only
  classifies: the output NEVER changes a routing decision and route is
  untouched. Capacity, reserve and cooldown logic stay exactly as is.
  Nothing routes real traffic through Jev until the lab docs/when-to-route.md verdict exists and the captain says go.
inputs:
  --task <text|file|->  literal task text; a path to a file to read when the
                        value names an existing file; - reads stdin
  --json                emit the classification as JSON instead of TOON
  --full                include the per-option probabilities and latencyMs
outputs:
  source=jev|fallback, always; reason is present only when source=fallback.
  Jev answers carry the model's calibrated confidence (heuristic=false).
  Fallback answers carry a fixed heuristic weight (heuristic=true).
  A Jev answer below ${JEV_MIN_CONFIDENCE} confidence on kind, difficulty or surface
  falls back with a reason. No key, no network, a timeout, or a client
  error also falls back, so the fleet works with no key and no network.
  The key comes ONLY from ${JEV_KEY_ENV}; it is never a flag and never
  appears in any output or error.
flags[${TASK_CLASSIFY_FLAGS.length + 1}]:
${TASK_CLASSIFY_FLAGS.map((flag) => `  ${flag.name}${flag.value ? ` <${flag.value}>` : ""}`).join(", ")}, --help
examples:
  llm-router-axi classify --task "Fix the login retry bug in api/auth.py"
  llm-router-axi classify --task ./TASK.md --json
  printf 'Review the payments PR' | llm-router-axi classify --task - --full
  Run \`llm-router-axi classify --task <text> --json\`, then pass kind/difficulty/surface to route explicitly.
`;

export interface TaskClassifyDeps {
  fetchImpl?: FetchImpl;
  /** Per-attempt Jev timeout in ms (test seam; defaults to the client default). */
  timeoutMs?: number;
}

export async function taskClassifyCommand(
  args: string[],
  deps: TaskClassifyDeps = {},
): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) {
    return TASK_CLASSIFY_HELP;
  }
  const { values, booleans } = parseArgs("classify", args, TASK_CLASSIFY_FLAGS);
  const rawTask = values.get("--task");
  if (rawTask === undefined) {
    throw new AxiError("classify is missing required flag: --task", "VALIDATION_ERROR", [
      "Usage: llm-router-axi classify --task <text|file|->",
      "Run `llm-router-axi classify --help` for the contract",
    ]);
  }
  const task = readTask(rawTask);
  if (task.trim().length === 0) {
    throw new AxiError("classify requires a non-empty --task", "VALIDATION_ERROR", [
      "Pass task text, a readable file, or - for stdin",
    ]);
  }

  const full = booleans.has("--full");
  const started = Date.now();
  const result = await classifyTask(task, deps);
  const latencyMs = Date.now() - started;

  if (!isClassifyResult(result)) {
    throw new AxiError("classify produced an invalid result", "VALIDATION_ERROR", [
      "This is a bug: report it with the task text",
    ]);
  }

  if (booleans.has("--json")) {
    return JSON.stringify(withFull(result, full, latencyMs), null, 2);
  }
  return toon(
    { classification: withFull(result, full, latencyMs) },
    helpBlock([
      "Slice 1 only classifies: pass kind/difficulty/surface to `route` explicitly",
      "Run `llm-router-axi doctor` to check the Jev path",
    ]),
  );
}

/**
 * `--task` disambiguation, documented in --help: `-` reads stdin, a value
 * naming an existing file reads that file, otherwise the value IS the text.
 */
function readTask(raw: string): string {
  if (raw === "-") {
    try {
      return readFileSync(0, "utf8");
    } catch {
      throw new AxiError("classify could not read task text from stdin", "VALIDATION_ERROR", [
        "Pipe the task text or pass --task <text>",
      ]);
    }
  }
  try {
    if (existsSync(raw) && statSync(raw).isFile()) {
      return readFileSync(raw, "utf8");
    }
  } catch {
    // Fall through and treat the value as literal text.
  }
  return raw;
}

async function classifyTask(task: string, deps: TaskClassifyDeps): Promise<ClassifyResult> {
  if (!process.env[JEV_KEY_ENV]) {
    return heuristicClassify(task, `no ${JEV_KEY_ENV} in the environment; using heuristic fallback`);
  }
  let response;
  try {
    response = await evaluateSystemOne(task, CLASSIFY_QUESTIONS, {
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    });
  } catch (error) {
    const reason = error instanceof JevError ? error.message : "Jev request failed";
    return heuristicClassify(task, `${reason}; using heuristic fallback`);
  }
  const mapped = mapClassifyAnswers(response.answers);
  if ("error" in mapped) {
    return heuristicClassify(task, `${mapped.error}; using heuristic fallback`);
  }
  const low = [
    { name: "kind", confidence: mapped.kind.confidence },
    { name: "difficulty", confidence: mapped.difficulty.confidence },
    { name: "surface", confidence: mapped.surface.confidence },
  ].filter((entry) => entry.confidence < JEV_MIN_CONFIDENCE);
  if (low.length > 0) {
    const names = low.map((entry) => `${entry.name} (${entry.confidence.toFixed(2)})`).join(", ");
    return heuristicClassify(
      task,
      `low Jev confidence below ${JEV_MIN_CONFIDENCE}: ${names}; using heuristic fallback`,
    );
  }
  const field = <T>(mappedField: { value: T; confidence: number; probabilities: Record<string, number> }) => ({
    value: mappedField.value,
    confidence: mappedField.confidence,
    heuristic: false,
    probabilities: mappedField.probabilities,
  });
  return {
    source: "jev",
    model: response.model,
    kind: field(mapped.kind),
    difficulty: field(mapped.difficulty),
    surface: field(mapped.surface),
    reasoningClass: field(mapped.reasoningClass),
    riskClass: field(mapped.riskClass),
    toolAffinity: field(mapped.toolAffinity),
  };
}

function withFull(
  result: ClassifyResult,
  full: boolean,
  latencyMs: number,
): Record<string, unknown> {
  if (!full) {
    const { kind, difficulty, surface, reasoningClass, riskClass, toolAffinity } = result;
    const strip = (field: { value: unknown; confidence: number; heuristic: boolean }) => ({
      value: field.value,
      confidence: field.confidence,
      heuristic: field.heuristic,
    });
    return {
      source: result.source,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.model ? { model: result.model } : {}),
      kind: strip(kind),
      difficulty: strip(difficulty),
      surface: strip(surface),
      reasoningClass: strip(reasoningClass),
      riskClass: strip(riskClass),
      toolAffinity: strip(toolAffinity),
    };
  }
  return { ...result, latencyMs };
}
