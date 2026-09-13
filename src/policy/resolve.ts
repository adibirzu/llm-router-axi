import type { Candidate, DifficultyLane, Policy } from "./types.js";

/** Expand a lane's ordered chain, resolving candidate-group references. */
export function resolveLaneCandidates(
  policy: Policy,
  lane: DifficultyLane,
): Candidate[] {
  const resolved: Candidate[] = [];
  for (const entry of lane.candidates) {
    if (typeof entry === "string") {
      resolved.push(...(policy.candidateGroups[entry] ?? []));
    } else {
      resolved.push(entry);
    }
  }
  return resolved;
}
