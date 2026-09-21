/**
 * Slice 2: typed triage of failure/worker-outcome evidence.
 *
 * `triage` answers three narrow, typed questions about a status line or
 * error tail: WHAT broke (a closed defect enum), WHETHER a retry could
 * succeed, and WHETHER a human must look. The Jev path asks one `Choice`
 * (defect) plus two `Noul` (retryable, needsHuman) questions in a single
 * `POST /v1/systemone` call through the shared `src/jev/client.ts`; the
 * deterministic fallback reuses the `classify-evidence` depletion
 * vocabulary (`classifyEvidence` in `src/selector.ts`) so triage can never
 * contradict the depletion detector, then falls through keyword heuristics
 * for the remaining classes.
 *
 * Triage is read-only: it never touches cooldown, record, or routing
 * state. Nothing routes real traffic through Jev until the lab's
 * `docs/when-to-route.md` verdict exists and the captain says go.
 */

import { classifyEvidence } from "../selector.js";
import type { JevQuestion } from "./client.js";
import { HEURISTIC_CONFIDENCE } from "./fallback.js";
import { JEV_MIN_CONFIDENCE } from "./schema.js";

/** Closed defect vocabulary. Aligned with `classify-evidence`: anything the
 * depletion detector flags lands on `rate_limit` or `quota_exhausted`,
 * never on another class. */
export const TRIAGE_DEFECT_VALUES = [
  "rate_limit",
  "quota_exhausted",
  "auth",
  "region_refused",
  "tool_error",
  "test_failure",
  "timeout",
  "unknown",
] as const;

export type TriageDefect = (typeof TRIAGE_DEFECT_VALUES)[number];

export interface TriageDefectField {
  value: TriageDefect;
  /** Calibrated model confidence (Jev) or fixed heuristic weight (fallback). */
  confidence: number;
  /** True only for the deterministic no-network fallback. */
  heuristic: boolean;
  /** Full option distribution; present on the Jev path with --full. */
  probabilities?: Record<string, number>;
}

export interface TriageBoolField {
  value: boolean;
  /** P(value is correct): the Noul probability on the Jev path, a fixed
   * heuristic weight on the fallback path. */
  probability: number;
  /** True only for the deterministic no-network fallback. */
  heuristic: boolean;
}

export interface TriageResult {
  /** `jev` when a live Jev call produced the answer, else `fallback`. */
  source: "jev" | "fallback";
  /** Present only when `source` is `fallback`: why no Jev answer was used. */
  reason?: string;
  /** Versioned model id that answered; Jev path only. */
  model?: string;
  defect: TriageDefectField;
  retryable: TriageBoolField;
  needsHuman: TriageBoolField;
}

/** Re-exported so commands share one floor with `classify`. */
export const TRIAGE_MIN_CONFIDENCE = JEV_MIN_CONFIDENCE;

const DEFECT_BLURBS: Record<TriageDefect, string> = {
  rate_limit: "A rate limit or too-many-requests refusal: retrying later may succeed.",
  quota_exhausted: "A quota, credit, allowance, or budget that is used up or exhausted.",
  auth: "Authentication or authorization failed: bad key, 401/403, permission denied.",
  region_refused: "Refused for the caller's region or geography, not for load or quota.",
  tool_error: "A tool, command, or environment step failed (exit code, missing binary).",
  test_failure: "A test suite ran and failed: assertion, failing test, red build.",
  timeout: "The operation timed out or exceeded its deadline.",
  unknown: "None of the above fits; the evidence is unclear.",
};

/** One request, three questions against the evidence text as `state`: a
 * `Choice` over the closed defect enum plus two `Noul` yes/no judgments.
 * (Documented speculative fan-out: every question sees the same state.) */
export const TRIAGE_QUESTIONS: Record<string, JevQuestion> = {
  defect: {
    type: "choice",
    instructions: "What kind of failure does this evidence describe?",
    criteria: { ...DEFECT_BLURBS },
  },
  retryable: {
    type: "noul",
    instructions: "Would retrying the same operation, unchanged, plausibly succeed?",
    criteria: {
      true: "A retry could succeed: transient limit, timeout, or flake.",
      false: "A retry would fail the same way: bad key, exhausted quota, refused region, broken code.",
    },
  },
  needsHuman: {
    type: "noul",
    instructions: "Does this failure need a human to look before the fleet continues?",
    criteria: {
      true: "Needs a human: credentials, billing, region policy, or an unclear break.",
      false: "No human needed: the fleet can retry, step down, or fix it alone.",
    },
  },
};

export interface MappedTriage {
  defect: { value: TriageDefect; confidence: number; probabilities: Record<string, number> };
  retryable: { value: boolean; probability: number };
  needsHuman: { value: boolean; probability: number };
}

function mapNoul(id: string, raw: unknown): { value: boolean; probability: number } | { error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: `question "${id}" has no answer` };
  }
  const answer = raw as Record<string, unknown>;
  if (answer.type !== "noul" || typeof answer.noul !== "number") {
    return { error: `question "${id}" did not return a noul answer` };
  }
  const noul = answer.noul;
  if (!(noul >= 0 && noul <= 1)) {
    return { error: `question "${id}" returned an out-of-range noul` };
  }
  const value = noul >= 0.5;
  return { value, probability: value ? noul : 1 - noul };
}

/**
 * Map the three Jev answers to typed fields. Returns an `error` naming the
 * first problem so the caller can fall back with a precise reason. An
 * off-list defect choice can never become output.
 */
export function mapTriageAnswers(
  answers: Record<string, unknown>,
): MappedTriage | { error: string } {
  const raw = answers.defect;
  if (typeof raw !== "object" || raw === null) {
    return { error: `question "defect" has no answer` };
  }
  const defectAnswer = raw as Record<string, unknown>;
  if (defectAnswer.type !== "choice" || typeof defectAnswer.choice !== "string") {
    return { error: `question "defect" did not return a choice answer` };
  }
  if (!(TRIAGE_DEFECT_VALUES as readonly string[]).includes(defectAnswer.choice)) {
    return { error: `question "defect" returned an off-list option` };
  }
  if (typeof defectAnswer.confidence !== "number") {
    return { error: `question "defect" returned no confidence` };
  }
  const probabilities =
    typeof defectAnswer.probabilities === "object" && defectAnswer.probabilities !== null
      ? (defectAnswer.probabilities as Record<string, number>)
      : {};
  const retryable = mapNoul("retryable", answers.retryable);
  if ("error" in retryable) return retryable;
  const needsHuman = mapNoul("needsHuman", answers.needsHuman);
  if ("error" in needsHuman) return needsHuman;
  return {
    defect: {
      value: defectAnswer.choice as TriageDefect,
      confidence: defectAnswer.confidence,
      probabilities,
    },
    retryable,
    needsHuman,
  };
}

const QUOTA_WORDS = [
  /\bquota\b/i,
  /\bcredit\b/i,
  /\ballowance\b/i,
  /\bbalance\b/i,
  /\bbudget\b/i,
  /\bsubscription\b/i,
  /resource[ _-]?exhausted/i,
  /\bexhaust/i,
  /\bdeplet/i,
  /\bused up\b/i,
  /\bzero\b.*\b(credit|balance|quota)\b/i,
];

const AUTH_PATTERNS = [
  /\b401\b/,
  /\bunauthor/i,
  /\binvalid\b.*\b(api[ _-]?key|key|token)\b/i,
  /\bbad\b.*\b(api[ _-]?key|key|token)\b/i,
  /\bforbidden\b/i,
  /\bpermission denied\b/i,
  /\baccess denied\b/i,
  /\bauth(entication|orization)?\b[^\\n]{0,40}\b(fail|error|denied|expired)\b/i,
  /\b(fail|error|denied)[^\\n]{0,40}\bauth(entication|orization)?\b/i,
];

const REGION_PATTERNS = [
  /\bregion\b/i,
  /\bgeo/i,
  /\bnot (available|supported) in your (country|region)/i,
  /\bblocked in\b/i,
  /\bunavailable in\b/i,
];

const TIMEOUT_PATTERNS = [
  /\btimed? ?out\b/i,
  /\bdeadline exceeded\b/i,
  /\betimedout\b/i,
  /\btook too long\b/i,
  /\brequest timeout\b/i,
];

const TEST_PATTERNS = [
  /\btests? failed\b/i,
  /\bfailing tests?\b/i,
  /\bassertion/i,
  /\bexpect\(.*\)\.to/i,
  /^\s*FAIL\b/im,
  /\bFAIL(ED)?\b/,
  /✗/,
  /\bjest\b/i,
  /\bvitest\b/i,
  /\bpytest\b/i,
  /\bred build\b/i,
];

const TOOL_PATTERNS = [
  /\btool\b.*\b(fail|error)\b/i,
  /\bcommand failed\b/i,
  /\bexit (code|status)\b/i,
  /\benoent\b/i,
  /\beacces\b/i,
  /\bcommand not found\b/i,
  /\bspawn\b.*\b(fail|error|enoent)\b/i,
];

/** Fixed retry/human judgments per defect: a guess, not a calibration. */
const DEFECT_JUDGMENTS: Record<TriageDefect, { retryable: boolean; retryableP: number; needsHuman: boolean; needsHumanP: number }> = {
  rate_limit: { retryable: true, retryableP: 0.8, needsHuman: false, needsHumanP: 0.8 },
  quota_exhausted: { retryable: false, retryableP: 0.75, needsHuman: true, needsHumanP: 0.7 },
  auth: { retryable: false, retryableP: 0.85, needsHuman: true, needsHumanP: 0.85 },
  region_refused: { retryable: false, retryableP: 0.8, needsHuman: true, needsHumanP: 0.8 },
  tool_error: { retryable: true, retryableP: 0.6, needsHuman: false, needsHumanP: 0.6 },
  test_failure: { retryable: false, retryableP: 0.7, needsHuman: false, needsHumanP: 0.6 },
  timeout: { retryable: true, retryableP: 0.75, needsHuman: false, needsHumanP: 0.7 },
  unknown: { retryable: false, retryableP: 0.5, needsHuman: true, needsHumanP: 0.5 },
};

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Triage without any network call and without touching any state.
 * Depletion is decided by the shared `classify-evidence` vocabulary first:
 * anything it flags becomes `rate_limit` (transient limit language) or
 * `quota_exhausted` (quota/credit/allowance wording), never another class.
 * `cause` names why the Jev path was not used and becomes `reason`.
 */
export function heuristicTriage(evidence: string, cause: string): TriageResult {
  let defect: TriageDefect = "unknown";
  if (classifyEvidence(evidence) !== null) {
    defect = hasAny(evidence, QUOTA_WORDS) ? "quota_exhausted" : "rate_limit";
  } else if (hasAny(evidence, REGION_PATTERNS)) {
    defect = "region_refused";
  } else if (hasAny(evidence, AUTH_PATTERNS)) {
    defect = "auth";
  } else if (hasAny(evidence, TIMEOUT_PATTERNS)) {
    defect = "timeout";
  } else if (hasAny(evidence, TEST_PATTERNS)) {
    // Before tool_error: a failing suite usually exits non-zero too, and
    // the test signal is the more specific diagnosis.
    defect = "test_failure";
  } else if (hasAny(evidence, TOOL_PATTERNS)) {
    defect = "tool_error";
  }

  const judgment = DEFECT_JUDGMENTS[defect];
  return {
    source: "fallback",
    reason: cause,
    defect: { value: defect, confidence: HEURISTIC_CONFIDENCE, heuristic: true },
    retryable: { value: judgment.retryable, probability: judgment.retryableP, heuristic: true },
    needsHuman: { value: judgment.needsHuman, probability: judgment.needsHumanP, heuristic: true },
  };
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

/** Schema check shared by both paths (and the parity test). */
export function isTriageResult(value: unknown): value is TriageResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (result.source !== "jev" && result.source !== "fallback") {
    return false;
  }
  if (result.reason !== undefined && typeof result.reason !== "string") {
    return false;
  }
  if (result.model !== undefined && typeof result.model !== "string") {
    return false;
  }
  const defect = result.defect as Record<string, unknown> | undefined;
  if (
    typeof defect !== "object" ||
    defect === null ||
    typeof defect.value !== "string" ||
    !(TRIAGE_DEFECT_VALUES as readonly string[]).includes(defect.value) ||
    !isProbability(defect.confidence) ||
    typeof defect.heuristic !== "boolean" ||
    (defect.probabilities !== undefined &&
      (typeof defect.probabilities !== "object" ||
        defect.probabilities === null ||
        !Object.values(defect.probabilities).every((p) => typeof p === "number")))
  ) {
    return false;
  }
  for (const name of ["retryable", "needsHuman"] as const) {
    const field = result[name] as Record<string, unknown> | undefined;
    if (
      typeof field !== "object" ||
      field === null ||
      typeof field.value !== "boolean" ||
      !isProbability(field.probability) ||
      typeof field.heuristic !== "boolean"
    ) {
      return false;
    }
  }
  return true;
}
