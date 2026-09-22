/**
 * Slice 2: advisory pick among caller-named candidates.
 *
 * `pick` chooses one of the `--candidate` names the caller supplies
 * (e.g. `harness:model` pairs) for a task. The Jev path asks two `Choice`
 * questions in a single `POST /v1/systemone` call through the shared
 * `src/jev/client.ts`: `selection` over the candidate names (its
 * probabilities ARE the ranking) and `reason` over the closed reason enum.
 * The deterministic fallback scores candidates by task-fit (name-token
 * overlap with the task text), ties broken by name.
 *
 * Pick is advisory only: it never consults capacity, reserve, or cooldown,
 * nothing calls it from `route`/`select`, and it changes no state. Nothing
 * routes real traffic through Jev until the lab's `docs/when-to-route.md`
 * verdict exists and the captain says go.
 */

import type { JevQuestion } from "./client.js";
import { JEV_MIN_CONFIDENCE } from "./schema.js";

/**
 * Closed reason vocabulary. Every reason `pick` ever prints is one of
 * these; free-text reasons are refused by construction (and by test).
 */
export const PICK_REASON_VALUES = [
  "keyword-match",
  "name-order",
  "single-candidate",
  "model-judgment",
] as const;

export type PickReason = (typeof PICK_REASON_VALUES)[number];

export interface PickRank {
  candidate: string;
  probability: number;
}

export interface PickResult {
  /** `jev` when a live Jev call produced the answer, else `fallback`. */
  source: "jev" | "fallback";
  /** Present only when `source` is `fallback`: why no Jev answer was used. */
  reason?: string;
  /** Versioned model id that answered; Jev path only. */
  model?: string;
  /** The chosen candidate: always one of the caller's `--candidate` names. */
  choice: string;
  /** Every candidate, best first, probabilities summing to ~1. */
  ranking: PickRank[];
  /** Typed reasons for the choice; every entry is a {@link PickReason}. */
  reasons: PickReason[];
}

/** Re-exported so commands share one floor with `classify`. */
export const PICK_MIN_CONFIDENCE = JEV_MIN_CONFIDENCE;

const REASON_BLURBS: Record<PickReason, string> = {
  "keyword-match": "The winner's name tokens appear in the task text.",
  "name-order": "No task signal distinguished the candidates; stable name order decided.",
  "single-candidate": "Only one candidate was supplied, so it wins by default.",
  "model-judgment": "The model's calibrated judgment selected the winner.",
};

/**
 * Validate the caller's candidate list. A candidate is a `harness:model`
 * name: two non-empty sides around one colon. Anything else is refused as
 * an unknown candidate (this keeps doctrine out of code: no harness, model,
 * lane, or pool is hard-coded here); an exact repeat is refused as a
 * duplicate. Returns the cleaned names or an `error` for the caller to
 * raise as a validation failure.
 */
export function validatePickCandidates(raw: string[]): { candidates: string[] } | { error: string } {
  const candidates = raw.map((name) => name.trim()).filter((name) => name.length > 0);
  if (candidates.length === 0) {
    return { error: "pick requires at least one --candidate <harness:model>" };
  }
  const seen = new Set<string>();
  for (const name of raw) {
    const trimmed = name.trim();
    const sides = trimmed.split(":");
    if (
      trimmed.length === 0 ||
      /\s/.test(trimmed) ||
      sides.length !== 2 ||
      (sides[0] ?? "").length === 0 ||
      (sides[1] ?? "").length === 0
    ) {
      return { error: `unknown candidate "${trimmed}": expected <harness:model>` };
    }
    if (seen.has(trimmed)) {
      return { error: `duplicate candidate "${trimmed}"` };
    }
    seen.add(trimmed);
  }
  return { candidates };
}

/**
 * Build the Jev question set for this candidate list. `selection` ranges
 * over the caller's names (the documented Choice pattern with dynamic
 * options); `reason` ranges over the closed reason enum so the Jev path's
 * reasons are typed too.
 */
export function buildPickQuestions(candidates: string[]): Record<string, JevQuestion> {
  return {
    selection: {
      type: "choice",
      instructions: "Which of these named candidates fits this task best?",
      criteria: Object.fromEntries(
        candidates.map((name) => [name, `Candidate "${name}" (harness:model pair).`]),
      ),
    },
    reason: {
      type: "choice",
      instructions: "Why does that candidate fit best?",
      criteria: { ...REASON_BLURBS },
    },
  };
}

export interface MappedPick {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  reasons: PickReason[];
}

/**
 * Map the two Jev answers to a typed pick. Returns an `error` naming the
 * first problem (missing answer, off-list choice, off-list reason) so the
 * caller can fall back with a precise reason.
 */
export function mapPickAnswers(
  answers: Record<string, unknown>,
  candidates: string[],
): MappedPick | { error: string } {
  const raw = answers.selection;
  if (typeof raw !== "object" || raw === null) {
    return { error: `question "selection" has no answer` };
  }
  const selection = raw as Record<string, unknown>;
  if (selection.type !== "choice" || typeof selection.choice !== "string") {
    return { error: `question "selection" did not return a choice answer` };
  }
  if (!candidates.includes(selection.choice)) {
    return { error: `question "selection" returned an off-list option` };
  }
  if (typeof selection.confidence !== "number") {
    return { error: `question "selection" returned no confidence` };
  }
  const probabilities =
    typeof selection.probabilities === "object" && selection.probabilities !== null
      ? (selection.probabilities as Record<string, number>)
      : {};

  const rawReason = answers.reason;
  if (typeof rawReason !== "object" || rawReason === null) {
    return { error: `question "reason" has no answer` };
  }
  const reasonAnswer = rawReason as Record<string, unknown>;
  if (reasonAnswer.type !== "choice" || typeof reasonAnswer.choice !== "string") {
    return { error: `question "reason" did not return a choice answer` };
  }
  if (!(PICK_REASON_VALUES as readonly string[]).includes(reasonAnswer.choice)) {
    return { error: `question "reason" returned an off-list option` };
  }
  return {
    choice: selection.choice,
    confidence: selection.confidence,
    probabilities,
    reasons: [reasonAnswer.choice as PickReason],
  };
}

function candidateTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[:/\-_@.]+/)
    .filter((token) => token.length > 1);
}

function compareName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Pick without any network call and without consulting capacity, reserve,
 * cooldown, or any state. Each candidate scores one point per name token
 * found in the task text; the ranking is the Laplace-smoothed share
 * `(score + 1) / total` in descending order with ties broken by name, so
 * the order is stable and the probabilities always sum to 1.
 * `cause` names why the Jev path was not used and becomes `reason`.
 */
export function heuristicPick(task: string, candidates: string[], cause: string): PickResult {
  const lower = task.toLowerCase();
  const scored = candidates.map((candidate) => ({
    candidate,
    score: candidateTokens(candidate).filter((token) => lower.includes(token)).length,
  }));
  const total = scored.reduce((sum, entry) => sum + entry.score + 1, 0);
  const ranking: PickRank[] = scored
    .map((entry) => ({ candidate: entry.candidate, probability: (entry.score + 1) / total }))
    .sort((a, b) => b.probability - a.probability || compareName(a.candidate, b.candidate));

  const winner = ranking[0] as PickRank;
  const topScore = scored.find((entry) => entry.candidate === winner.candidate)?.score ?? 0;
  const reasons: PickReason[] =
    candidates.length === 1
      ? ["single-candidate"]
      : topScore > 0
        ? ["keyword-match"]
        : ["name-order"];

  return { source: "fallback", reason: cause, choice: winner.candidate, ranking, reasons };
}

/** Schema check shared by both paths (and the parity test). */
export function isPickResult(value: unknown): value is PickResult {
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
  if (typeof result.choice !== "string" || result.choice.length === 0) {
    return false;
  }
  if (!Array.isArray(result.ranking) || result.ranking.length === 0) {
    return false;
  }
  const names = new Set<string>();
  let total = 0;
  for (const entry of result.ranking) {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const rank = entry as Record<string, unknown>;
    if (typeof rank.candidate !== "string" || rank.candidate.length === 0) {
      return false;
    }
    if (typeof rank.probability !== "number" || !(rank.probability >= 0) || !(rank.probability <= 1)) {
      return false;
    }
    if (names.has(rank.candidate)) {
      return false;
    }
    names.add(rank.candidate);
    total += rank.probability;
  }
  if (!names.has(result.choice as string)) {
    return false;
  }
  // Ranking probabilities are shares: they must sum to ~1.
  if (Math.abs(total - 1) > 0.01) {
    return false;
  }
  if (!Array.isArray(result.reasons) || result.reasons.length === 0) {
    return false;
  }
  for (const reason of result.reasons) {
    if (typeof reason !== "string" || !(PICK_REASON_VALUES as readonly string[]).includes(reason)) {
      return false;
    }
  }
  return true;
}
