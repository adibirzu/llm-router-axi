/**
 * `pick --task ... --candidate ...`: choose among caller-named candidates.
 *
 * Slice 2 advises only. Pick never consults capacity, reserve, or cooldown,
 * nothing calls it from `route`/`select`, and it changes no state. Nothing
 * routes real traffic through Jev until the lab's `docs/when-to-route.md`
 * verdict exists and the captain says go.
 */

import { existsSync, readFileSync, statSync } from "node:fs";

import { AxiError } from "axi-sdk-js";

import { parseArgs, type FlagSpec } from "../args.js";
import {
  evaluateSystemOne,
  JEV_KEY_ENV,
  JevError,
  type FetchImpl,
} from "../jev/client.js";
import {
  buildPickQuestions,
  heuristicPick,
  isPickResult,
  mapPickAnswers,
  PICK_MIN_CONFIDENCE,
  validatePickCandidates,
  type PickResult,
} from "../jev/pick.js";
import { helpBlock, toon } from "../render.js";

const PICK_FLAGS: FlagSpec[] = [
  {
    name: "--task",
    value: "text|file|-",
    description: "Task descriptor: literal text, a path to read, or - for stdin",
  },
  {
    name: "--candidate",
    value: "harness:model",
    description: "Candidate name to choose among; repeat for each candidate",
  },
  { name: "--json", description: "Emit the pick as JSON" },
  { name: "--full", description: "Include latencyMs" },
];

export const PICK_HELP = `usage: llm-router-axi pick --task <text|file|-> --candidate <harness:model> [--candidate <harness:model> ...] [--json] [--full]
description:
  Choose among the NAMED candidates supplied by the caller for a task.
  Slice 2 advises only: the output NEVER consults capacity, reserve, or
  cooldown, nothing calls pick from route/select, and pick changes no
  state. Capacity, reserve and cooldown logic stay exactly as is.
  Nothing routes real traffic through Jev until the lab docs/when-to-route.md verdict exists and the captain says go.
inputs:
  --task <text|file|->  literal task text; a path to a file to read when the
                        value names an existing file; - reads stdin
  --candidate <harness:model>
                        one candidate name; repeat for each candidate. A name
                        is two non-empty sides around one colon; anything else
                        is refused as an unknown candidate, and an exact repeat
                        is refused as a duplicate.
  --json                emit the pick as JSON instead of TOON
  --full                include latencyMs
outputs:
  source=jev|fallback, always; reason is present only when source=fallback.
  choice is always one of the caller's candidates; ranking lists every
  candidate best-first with probabilities summing to 1; reasons is a list
  drawn ONLY from the closed reason enum (never free text). A Jev
  selection below ${PICK_MIN_CONFIDENCE} confidence falls back with a reason.
  No key, no network, a timeout, or a client error also falls back, so the
  fleet works with no key and no network. The key comes ONLY from
  ${JEV_KEY_ENV}; it is never a flag and never appears in any output or error.
flags[${PICK_FLAGS.length + 1}]:
${PICK_FLAGS.map((flag) => `  ${flag.name}${flag.value ? ` <${flag.value}>` : ""}`).join(", ")}, --help
examples:
  llm-router-axi pick --task "Fix the login retry bug" --candidate opencode:opencode-go/qwen3.8-flash --candidate claude:claude-opus
  llm-router-axi pick --task ./TASK.md --candidate a:m1 --candidate b:m2 --json
`;

export interface PickDeps {
  fetchImpl?: FetchImpl;
  /** Per-attempt Jev timeout in ms (test seam; defaults to the client default). */
  timeoutMs?: number;
}

export async function pickCommand(
  args: string[],
  deps: PickDeps = {},
): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) {
    return PICK_HELP;
  }
  const { values, booleans } = parseArgs("pick", args, PICK_FLAGS);
  const rawTask = values.get("--task");
  if (rawTask === undefined) {
    throw new AxiError("pick is missing required flag: --task", "VALIDATION_ERROR", [
      "Usage: llm-router-axi pick --task <text|file|-> --candidate <harness:model> [...]",
      "Run `llm-router-axi pick --help` for the contract",
    ]);
  }
  const task = readTask(rawTask);
  if (task.trim().length === 0) {
    throw new AxiError("pick requires a non-empty --task", "VALIDATION_ERROR", [
      "Pass task text, a readable file, or - for stdin",
    ]);
  }

  // `parseArgs` keeps the last `--candidate`; the list itself is every
  // occurrence in order, collected here so repeats all count.
  const rawCandidates = collectCandidates(args);
  const validated = validatePickCandidates(rawCandidates);
  if ("error" in validated) {
    throw new AxiError(`pick: ${validated.error}`, "VALIDATION_ERROR", [
      "Pass each candidate as --candidate <harness:model>",
      "Run `llm-router-axi pick --help` for the contract",
    ]);
  }
  const candidates = validated.candidates;

  const full = booleans.has("--full");
  const started = Date.now();
  const result = await pickCandidate(task, candidates, deps);
  const latencyMs = Date.now() - started;

  if (!isPickResult(result)) {
    throw new AxiError("pick produced an invalid result", "VALIDATION_ERROR", [
      "This is a bug: report it with the task text and candidates",
    ]);
  }

  if (booleans.has("--json")) {
    return JSON.stringify(withFull(result, full, latencyMs), null, 2);
  }
  return toon(
    { pick: withFull(result, full, latencyMs) },
    helpBlock([
      "Slice 2 advises only: pick consults no capacity, reserve, or cooldown",
      "Run `llm-router-axi doctor` to check the Jev path",
    ]),
  );
}

/** Every `--candidate X` / `--candidate=X` occurrence in order. */
function collectCandidates(args: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--candidate") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("--")) {
        out.push(value);
      }
    } else if (arg.startsWith("--candidate=")) {
      out.push(arg.slice("--candidate=".length));
    }
  }
  return out;
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
      throw new AxiError("pick could not read task text from stdin", "VALIDATION_ERROR", [
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

async function pickCandidate(
  task: string,
  candidates: string[],
  deps: PickDeps,
): Promise<PickResult> {
  if (!process.env[JEV_KEY_ENV]) {
    return heuristicPick(task, candidates, `no ${JEV_KEY_ENV} in the environment; using heuristic fallback`);
  }
  let response;
  try {
    response = await evaluateSystemOne(task, buildPickQuestions(candidates), {
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    });
  } catch (error) {
    const reason = error instanceof JevError ? error.message : "Jev request failed";
    return heuristicPick(task, candidates, `${reason}; using heuristic fallback`);
  }
  const mapped = mapPickAnswers(response.answers, candidates);
  if ("error" in mapped) {
    return heuristicPick(task, candidates, `${mapped.error}; using heuristic fallback`);
  }
  if (mapped.confidence < PICK_MIN_CONFIDENCE) {
    return heuristicPick(
      task,
      candidates,
      `low Jev confidence below ${PICK_MIN_CONFIDENCE}: selection (${mapped.confidence.toFixed(2)}); using heuristic fallback`,
    );
  }
  // The ranking is the model's distribution, best first; ties break by
  // name so the order is stable. Shares are renormalized so they always
  // sum to 1 even when the distribution omits a candidate or rounds.
  const rawRanking = Object.entries(mapped.probabilities)
    .filter(([name]) => candidates.includes(name))
    .map(([candidate, probability]) => ({ candidate, probability }));
  for (const candidate of candidates) {
    if (!rawRanking.some((entry) => entry.candidate === candidate)) {
      rawRanking.push({ candidate, probability: 0 });
    }
  }
  const total = rawRanking.reduce((sum, entry) => sum + entry.probability, 0);
  const ranking = rawRanking
    .map((entry) => ({
      candidate: entry.candidate,
      probability: total > 0 ? entry.probability / total : 1 / rawRanking.length,
    }))
    .sort((a, b) => b.probability - a.probability || (a.candidate < b.candidate ? -1 : 1));
  return {
    source: "jev",
    model: response.model,
    choice: mapped.choice,
    ranking,
    reasons: mapped.reasons,
  };
}

function withFull(
  result: PickResult,
  full: boolean,
  latencyMs: number,
): Record<string, unknown> {
  if (!full) {
    return { ...result };
  }
  return { ...result, latencyMs };
}
