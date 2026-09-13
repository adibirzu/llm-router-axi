import { AxiError } from "axi-sdk-js";

import { capacityVerdict, type CapacityVerdict } from "./capacity.js";
import { resolveLaneCandidates } from "./policy/index.js";
import type { Candidate, Difficulty, Kind, Policy } from "./policy/types.js";
import {
  profileIdentity,
  selectProfiles,
  type CandidateEvaluation,
  type EngineProfile,
  type EngineState,
  type QuotaRead,
  type SelectionReport,
} from "./selector.js";
import { candidatePoolName, candidateToProfile } from "./usage.js";

interface DecisionCandidate {
  harness: string;
  model?: string;
  effort?: string;
  provider: string;
  pool?: string;
}

interface Decision {
  harness: string;
  model?: string;
  effort?: string;
  provider: string;
  pool?: string;
  reason: string;
  fallbacks: DecisionCandidate[];
  capacity: {
    ok: boolean;
    measured: Record<string, unknown>;
    reasons: string[];
  };
}

interface RoutedCandidate {
  candidate: Candidate;
  profile: EngineProfile;
}

export interface RouterResult {
  report: SelectionReport;
  capacity: CapacityVerdict;
  routes: RoutedCandidate[];
  evaluations: CandidateEvaluation[];
  decision?: Decision;
}

interface RouteLaneParams {
  policy: Policy;
  kind: Kind;
  difficulty: Difficulty;
  quota: QuotaRead;
  state: EngineState;
  now: number;
  home: string;
}

/** Resolve the lane, evaluate every candidate, and assemble the decision. */
export function routeLane(params: RouteLaneParams): RouterResult {
  const { policy, kind, difficulty, quota, state, now, home } = params;
  const lane = policy.kinds[kind][difficulty];
  const candidates = resolveLaneCandidates(policy, lane);

  const routed: RoutedCandidate[] = [];
  for (const candidate of candidates) {
    const resolved = candidateToProfile(policy, candidate, lane.effort, quota);
    if ("error" in resolved) {
      throw new AxiError(resolved.error, "VALIDATION_ERROR", [
        `candidate harness=${candidate.harness} provider=${candidate.provider}`,
        "Fix the candidate in the policy (run `llm-router-axi policy show --full`)",
      ]);
    }
    routed.push({ candidate, profile: resolved.profile });
  }

  const profiles = routed.map((item) => item.profile);
  const report = selectProfiles({
    profiles,
    ranks: profiles.map((_, index) => index),
    quota,
    settings: {
      reservePercent: policy.routing.reservePercent,
      telemetryMaxAgeSeconds: policy.routing.telemetryMaxAgeSeconds,
      cooldownSeconds: policy.routing.cooldownSeconds,
    },
    now,
    state,
    home,
  });
  const capacity = capacityVerdict(policy, quota);

  const result: RouterResult = {
    report,
    capacity,
    routes: routed,
    evaluations: report.evaluations,
  };
  if (!report.ok || !report.selected) {
    return result;
  }

  const byProfile = new Map<EngineProfile, CandidateEvaluation>();
  for (const evaluation of report.evaluations) {
    byProfile.set(evaluation.profile, evaluation);
  }

  const selectedIndex = profiles.indexOf(report.selected);
  const selectedRoute = routed[selectedIndex];
  const selectedEval = byProfile.get(report.selected);

  const decision: Decision = {
    ...decisionCandidate(policy, selectedRoute.candidate, report.selected),
    reason: selectedEval?.detail ?? "eligible",
    fallbacks: [],
    capacity: {
      ok: capacity.ok,
      measured: capacity.measured,
      reasons: capacity.reasons,
    },
  };

  const selectedIdentity = profileIdentity(report.selected);
  for (let index = 0; index < routed.length; index++) {
    if (index === selectedIndex) continue;
    const route = routed[index];
    if (!route) continue;
    if (profileIdentity(route.profile) === selectedIdentity) continue;
    const evaluation = byProfile.get(route.profile);
    if (!evaluation?.eligible) continue;
    decision.fallbacks.push(decisionCandidate(policy, route.candidate, route.profile));
    if (decision.fallbacks.length >= policy.routing.maxFallbacks) break;
  }

  result.decision = decision;
  return result;
}

function decisionCandidate(
  policy: Policy,
  candidate: Candidate,
  profile: EngineProfile,
): DecisionCandidate {
  const pool = candidatePoolName(policy, candidate);
  return {
    harness: profile.harness,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.effort ? { effort: profile.effort } : {}),
    provider: profile.provider,
    ...(pool ? { pool } : {}),
  };
}
