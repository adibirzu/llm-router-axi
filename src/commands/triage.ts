/**
 * `triage --evidence ...`: type a failure or worker-outcome evidence string.
 *
 * Slice 2 triages only. It never changes cooldown, record, or routing
 * state (it imports no state module and writes nothing), and `route` is
 * untouched. Nothing routes real traffic through Jev until the lab's
 * `docs/when-to-route.md` verdict exists and the captain says go.
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
  isTriageResult,
  TRIAGE_MIN_CONFIDENCE,
  TRIAGE_QUESTIONS,
  heuristicTriage,
  mapTriageAnswers,
  type TriageResult,
} from "../jev/triage.js";
import { helpBlock, toon } from "../render.js";

const TRIAGE_FLAGS: FlagSpec[] = [
  {
    name: "--evidence",
    value: "text|file|-",
    description: "Failure or worker-outcome evidence: literal text, a path to read, or - for stdin",
  },
  { name: "--json", description: "Emit the triage as JSON" },
  { name: "--full", description: "Include the per-option defect distribution and latency" },
];

export const TRIAGE_HELP = `usage: llm-router-axi triage --evidence <text|file|-> [--json] [--full]
description:
  Type a failure or worker-outcome evidence string (a status line, an
  error tail) into a closed defect class plus retry/human judgments, each
  with a probability. Slice 2 only triages: the output NEVER changes
  cooldown, record, or routing state, and route is untouched. Capacity,
  reserve and cooldown logic stay exactly as is.
  Nothing routes real traffic through Jev until the lab docs/when-to-route.md verdict exists and the captain says go.
inputs:
  --evidence <text|file|->  literal evidence text; a path to a file to read
                            when the value names an existing file; - reads stdin
  --json                    emit the triage as JSON instead of TOON
  --full                    include the per-option defect probabilities and latencyMs
outputs:
  source=jev|fallback, always; reason is present only when source=fallback.
  defect is one of rate_limit|quota_exhausted|auth|region_refused|
  tool_error|test_failure|timeout|unknown with a confidence, retryable and
  needsHuman are booleans each with a probability. The depletion classes
  (rate_limit, quota_exhausted) reuse the classify-evidence vocabulary, so
  triage never contradicts it. A Jev defect answer below ${TRIAGE_MIN_CONFIDENCE}
  confidence falls back with a reason. No key, no network, a timeout, or a
  client error also falls back, so the fleet works with no key and no network.
  The key comes ONLY from ${JEV_KEY_ENV}; it is never a flag and never
  appears in any output or error.
flags[${TRIAGE_FLAGS.length + 1}]:
${TRIAGE_FLAGS.map((flag) => `  ${flag.name}${flag.value ? ` <${flag.value}>` : ""}`).join(", ")}, --help
examples:
  llm-router-axi triage --evidence "failed: request failed with status code 429"
  llm-router-axi triage --evidence ./worker.status --json
  printf 'exit status 1: FAIL api/auth_test.go' | llm-router-axi triage --evidence - --full
`;

export interface TriageDeps {
  fetchImpl?: FetchImpl;
  /** Per-attempt Jev timeout in ms (test seam; defaults to the client default). */
  timeoutMs?: number;
}

export async function triageCommand(
  args: string[],
  deps: TriageDeps = {},
): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) {
    return TRIAGE_HELP;
  }
  const { values, booleans } = parseArgs("triage", args, TRIAGE_FLAGS);
  const rawEvidence = values.get("--evidence");
  if (rawEvidence === undefined) {
    throw new AxiError("triage is missing required flag: --evidence", "VALIDATION_ERROR", [
      "Usage: llm-router-axi triage --evidence <text|file|->",
      "Run `llm-router-axi triage --help` for the contract",
    ]);
  }
  const evidence = readEvidence(rawEvidence);
  if (evidence.trim().length === 0) {
    throw new AxiError("triage requires non-empty --evidence", "VALIDATION_ERROR", [
      "Pass evidence text, a readable file, or - for stdin",
    ]);
  }

  const full = booleans.has("--full");
  const started = Date.now();
  const result = await triageEvidence(evidence, deps);
  const latencyMs = Date.now() - started;

  if (!isTriageResult(result)) {
    throw new AxiError("triage produced an invalid result", "VALIDATION_ERROR", [
      "This is a bug: report it with the evidence text",
    ]);
  }

  if (booleans.has("--json")) {
    return JSON.stringify(withFull(result, full, latencyMs), null, 2);
  }
  return toon(
    { triage: withFull(result, full, latencyMs) },
    helpBlock([
      "Slice 2 only triages: it changes no cooldown, record, or routing state",
      "Run `llm-router-axi doctor` to check the Jev path",
    ]),
  );
}

/**
 * `--evidence` disambiguation, documented in --help: `-` reads stdin, a
 * value naming an existing file reads that file, otherwise the value IS
 * the text.
 */
function readEvidence(raw: string): string {
  if (raw === "-") {
    try {
      return readFileSync(0, "utf8");
    } catch {
      throw new AxiError("triage could not read evidence text from stdin", "VALIDATION_ERROR", [
        "Pipe the evidence text or pass --evidence <text>",
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

async function triageEvidence(evidence: string, deps: TriageDeps): Promise<TriageResult> {
  if (!process.env[JEV_KEY_ENV]) {
    return heuristicTriage(evidence, `no ${JEV_KEY_ENV} in the environment; using heuristic fallback`);
  }
  let response;
  try {
    response = await evaluateSystemOne(evidence, TRIAGE_QUESTIONS, {
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    });
  } catch (error) {
    const reason = error instanceof JevError ? error.message : "Jev request failed";
    return heuristicTriage(evidence, `${reason}; using heuristic fallback`);
  }
  const mapped = mapTriageAnswers(response.answers);
  if ("error" in mapped) {
    return heuristicTriage(evidence, `${mapped.error}; using heuristic fallback`);
  }
  if (mapped.defect.confidence < TRIAGE_MIN_CONFIDENCE) {
    return heuristicTriage(
      evidence,
      `low Jev confidence below ${TRIAGE_MIN_CONFIDENCE}: defect (${mapped.defect.confidence.toFixed(2)}); using heuristic fallback`,
    );
  }
  return {
    source: "jev",
    model: response.model,
    defect: {
      value: mapped.defect.value,
      confidence: mapped.defect.confidence,
      heuristic: false,
      probabilities: mapped.defect.probabilities,
    },
    retryable: { ...mapped.retryable, heuristic: false },
    needsHuman: { ...mapped.needsHuman, heuristic: false },
  };
}

function withFull(
  result: TriageResult,
  full: boolean,
  latencyMs: number,
): Record<string, unknown> {
  if (!full) {
    const stripDefect = {
      value: result.defect.value,
      confidence: result.defect.confidence,
      heuristic: result.defect.heuristic,
    };
    return {
      source: result.source,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.model ? { model: result.model } : {}),
      defect: stripDefect,
      retryable: result.retryable,
      needsHuman: result.needsHuman,
    };
  }
  return { ...result, latencyMs };
}
