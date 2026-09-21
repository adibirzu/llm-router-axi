/**
 * Shared `classify` output schema (Slice 1).
 *
 * The Jev path and the deterministic no-network fallback return the SAME
 * shape; `test/jev.test.ts` proves both validate against this schema
 * (fallback-parity). Every field carries its own confidence plus a
 * `heuristic` flag: Jev answers report the model's calibrated confidence
 * with `heuristic: false`; fallback answers report a fixed heuristic weight
 * with `heuristic: true`, so a reader can never mistake a guess for a
 * calibrated decision.
 */

import { DIFFICULTY_VALUES, KIND_VALUES, SURFACE_VALUES } from "../commands/descriptor.js";

export const REASONING_CLASS_VALUES = ["code-gen", "debug", "review", "architecture", "docs"] as const;
export const RISK_CLASS_VALUES = ["low", "medium", "high"] as const;
export const TOOL_AFFINITY_VALUES = ["browser", "shell", "git", "db", "none"] as const;

export type Kind = (typeof KIND_VALUES)[number];
export type Difficulty = (typeof DIFFICULTY_VALUES)[number];
export type Surface = (typeof SURFACE_VALUES)[number];
export type ReasoningClass = (typeof REASONING_CLASS_VALUES)[number];
export type RiskClass = (typeof RISK_CLASS_VALUES)[number];
export type ToolAffinity = (typeof TOOL_AFFINITY_VALUES)[number];

export interface ClassifiedField<T> {
  value: T;
  /** Calibrated model confidence (Jev) or fixed heuristic weight (fallback). */
  confidence: number;
  /** True only for the deterministic no-network fallback. */
  heuristic: boolean;
  /** Full option distribution; present on the Jev path with --full. */
  probabilities?: Record<string, number>;
}

export interface ClassifyResult {
  /** `jev` when a live Jev call produced the answer, else `fallback`. */
  source: "jev" | "fallback";
  /** Present only when `source` is `fallback`: why no Jev answer was used. */
  reason?: string;
  /** Versioned model id that answered; Jev path only. */
  model?: string;
  kind: ClassifiedField<Kind>;
  difficulty: ClassifiedField<Difficulty>;
  surface: ClassifiedField<Surface>;
  reasoningClass: ClassifiedField<ReasoningClass>;
  riskClass: ClassifiedField<RiskClass>;
  toolAffinity: ClassifiedField<ToolAffinity>;
}

/**
 * Answers below this calibrated confidence on any of the three core fields
 * (kind/difficulty/surface) are treated as "Jev is unsure" and fall back to
 * the deterministic heuristic with a reason. 0.5 is the docs' own
 * genuinely-unsure floor (confidence.md gates anything below 0.5 to a
 * human/fallback); classify NEVER routes, so a conservative floor is right.
 */
export const JEV_MIN_CONFIDENCE = 0.5;

const FIELD_NAMES = [
  "kind",
  "difficulty",
  "surface",
  "reasoningClass",
  "riskClass",
  "toolAffinity",
] as const;

function isClassifiedField(value: unknown, allowed: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const field = value as Record<string, unknown>;
  return (
    typeof field.value === "string" &&
    (allowed as readonly string[]).includes(field.value) &&
    typeof field.confidence === "number" &&
    field.confidence >= 0 &&
    field.confidence <= 1 &&
    typeof field.heuristic === "boolean" &&
    (field.probabilities === undefined ||
      (typeof field.probabilities === "object" &&
        field.probabilities !== null &&
        Object.values(field.probabilities).every((p) => typeof p === "number")))
  );
}

/** Schema check shared by both paths (and the parity test). */
export function isClassifyResult(value: unknown): value is ClassifyResult {
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
  const allowed: Record<(typeof FIELD_NAMES)[number], readonly string[]> = {
    kind: KIND_VALUES,
    difficulty: DIFFICULTY_VALUES,
    surface: SURFACE_VALUES,
    reasoningClass: REASONING_CLASS_VALUES,
    riskClass: RISK_CLASS_VALUES,
    toolAffinity: TOOL_AFFINITY_VALUES,
  };
  return FIELD_NAMES.every((name) => isClassifiedField(result[name], allowed[name]));
}
