import type { Policy } from "./policy/types.js";

/**
 * The in-run step-down decision, ported from firstmate's
 * `bin/fm-model-fallback.sh` (the walk at "selection"). The algorithm is frozen
 * so P3 may replace that script's chain walk with `llm-router-axi route chain`
 * while it keeps owning evidence classification and the evidence cursor.
 *
 * Step-down semantics, exactly as the script reads `config/crew-dispatch.json`:
 *
 * 1. Walk the harness's `modelFallback` chain: the entry after the recorded
 *    model is next; a model absent from its chain steps to the chain head; the
 *    last entry means the lane is walked out unless the harness is listed in
 *    `modelFallbackCycles`, which wraps to the chain head.
 * 2. When the lane is walked out, the next harness named after it in
 *    `fallbackLanes` is a lane move, starting at that lane's chain head (or its
 *    harness default when it has no chain).
 * 3. Otherwise the whole fallback is exhausted.
 */

export interface ResolvedFallbacks {
  modelFallback: Record<string, string[]>;
  fallbackLanes: string[];
  modelFallbackCycles: string[];
}

export type ChainAction = "harness-step" | "lane-move" | "exhausted";

export interface ChainStep {
  action: ChainAction;
  harness: string;
  fromModel?: string;
  toModel?: string;
  toHarness?: string;
  reason?: string;
  chain: string[];
  fallbackLanes: string[];
}

/**
 * Normalize the doctrine, honoring the legacy `_model_fallback` alias the way
 * `fm-dispatch-select.mjs validate-model-fallback` does. The schema refuses the
 * two keys together; if both somehow reach here the canonical key wins.
 */
export function resolveFallbacks(
  policy: Policy & { _model_fallback?: Record<string, string[]> },
): ResolvedFallbacks {
  return {
    modelFallback: policy.modelFallback ?? policy._model_fallback ?? {},
    fallbackLanes: policy.fallbackLanes ?? [],
    modelFallbackCycles: policy.modelFallbackCycles ?? [],
  };
}

function chainOf(
  fallbacks: ResolvedFallbacks,
  harness: string,
): string[] {
  return fallbacks.modelFallback[harness] ?? [];
}

function laneSuccessor(lanes: string[], harness: string): string | undefined {
  for (let index = 0; index < lanes.length - 1; index++) {
    if (lanes[index] === harness) return lanes[index + 1];
  }
  return undefined;
}

/** Compute the next in-run step-down for a harness/model pair. */
export function planStepDown(
  policy: Policy & { _model_fallback?: Record<string, string[]> },
  harness: string,
  currentModel: string | undefined,
): ChainStep {
  const fallbacks = resolveFallbacks(policy);
  const chain = chainOf(fallbacks, harness);
  const model = currentModel ?? "";
  const base = { harness, fallbackLanes: fallbacks.fallbackLanes, chain };

  let nextModel = "";
  let foundCurrent = false;
  for (const entry of chain) {
    if (foundCurrent) {
      nextModel = entry;
      break;
    }
    if (entry === model) foundCurrent = true;
  }
  // A recorded model outside its chain starts from the chain head.
  if (!foundCurrent) {
    nextModel = chain[0] ?? "";
    if (nextModel === model) nextModel = "";
  }
  // The chain's last entry is walked out; a cyclic lane wraps to its head.
  if (nextModel === "" && foundCurrent && fallbacks.modelFallbackCycles.includes(harness)) {
    nextModel = chain[0] ?? "";
  }

  if (nextModel !== "") {
    return {
      ...base,
      action: "harness-step",
      ...(model ? { fromModel: model } : {}),
      toModel: nextModel,
    };
  }

  const nextHarness = laneSuccessor(fallbacks.fallbackLanes, harness);
  if (nextHarness !== undefined) {
    return {
      ...base,
      action: "lane-move",
      ...(model ? { fromModel: model } : {}),
      toHarness: nextHarness,
      toModel: chainOf(fallbacks, nextHarness)[0] ?? "",
    };
  }

  return {
    ...base,
    action: "exhausted",
    ...(model ? { fromModel: model } : {}),
    reason: `every model in the '${harness}' chain is depleted and no fallbackLanes successor exists`,
  };
}
