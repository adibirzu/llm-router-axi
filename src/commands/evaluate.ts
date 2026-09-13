import { AxiError } from "axi-sdk-js";

import { loadEffectivePolicy } from "../policy/index.js";
import type { Difficulty, Kind, Policy } from "../policy/types.js";
import { routeLane, type RouterResult } from "../router.js";
import { homeDir, loadState, saveState, withStateLock } from "../state.js";
import { loadUsage } from "../usage.js";

export interface DescriptorRequest {
  kind: Kind;
  difficulty: Difficulty;
  usageJson?: string;
  now?: number;
}

export interface DescriptorEvaluation {
  policy: Policy;
  result: RouterResult;
  now: number;
}

/**
 * The shared `route`/`explain` pipeline: active policy, one usage snapshot,
 * locked state, and the lane evaluation. State is persisted even when the
 * evaluation refuses, so telemetry-derived cooldowns survive.
 */
export function evaluateDescriptor(request: DescriptorRequest): DescriptorEvaluation {
  const read = loadEffectivePolicy();
  if (!read.ok) {
    throw new AxiError(read.message, "VALIDATION_ERROR", [
      ...read.issues.map((issue) => `${issue.path}: ${issue.message}`),
      "Run `llm-router-axi policy validate` for the full issue list",
    ]);
  }

  const now = request.now ?? Math.floor(Date.now() / 1000);
  const quota = loadUsage({
    ...(request.usageJson ? { usageJson: request.usageJson } : {}),
    maxAgeSeconds: read.policy.routing.telemetryMaxAgeSeconds,
    now,
  });

  const result = withStateLock(() => {
    const state = loadState();
    const evaluation = routeLane({
      policy: read.policy,
      kind: request.kind,
      difficulty: request.difficulty,
      quota,
      state,
      now,
      home: homeDir(),
    });
    saveState(evaluation.report.state);
    return evaluation;
  });

  return { policy: read.policy, result, now };
}
