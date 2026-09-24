import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { AxiError } from "axi-sdk-js";

import { parseArgs, requireInteger, type FlagSpec } from "../args.js";
import { capacityVerdict } from "../capacity.js";
import { loadEffectivePolicy, stateDir } from "../policy/index.js";
import type { Candidate, Policy } from "../policy/types.js";
import { helpBlock, toon } from "../render.js";
import { selectProfiles, type CandidateEvaluation, type EngineProfile } from "../selector.js";
import { homeDir, loadState, saveState, withStateLock } from "../state.js";
import { candidatePoolName, candidateToProfile, loadUsage } from "../usage.js";

const CHECK_FLAGS: FlagSpec[] = [
  { name: "--harness", value: "name", description: "Explicit harness override to validate" },
  { name: "--model", value: "id", description: "Explicit model override to validate" },
  { name: "--usage-json", value: "path", description: "Usage telemetry fixture instead of usage-axi" },
  { name: "--now", value: "epoch", description: "Fix the current epoch second (test seam)" },
  { name: "--force-override", description: "Allow a refused override and append an audit record" },
  { name: "--json", description: "Emit the same result as JSON" },
];

export const CHECK_HELP = `usage: llm-router-axi check --harness <name> --model <id> [flags]
description: Gate an explicit launch override on live quota, cooldown, runtime health, and machine capacity.
  A refusal carries the selector's exact reason and the next eligible candidate
  from the matching policy candidate group. --force-override allows the launch
  and appends a credential-free audit record.
inputs:
  --harness <name>            explicit harness override
  --model <id>                explicit model override
  --usage-json <path>         usage telemetry fixture instead of usage-axi
  --now <epoch>               fix the current epoch second (test seam)
  --force-override            allow a refused override and log it
  --json                      emit the same result as JSON
outputs:
  TOON gate: allowed, forced, requested, reason, next
exit:
  0  override allowed (healthy or forced)
  1  override refused
  2  invalid flags, policy, or unknown override
flags[${CHECK_FLAGS.length + 1}]:
${CHECK_FLAGS.map((flag) => `  ${flag.name}${flag.value ? ` <${flag.value}>` : ""}`).join(", ")}, --help
examples:
  llm-router-axi check --harness codex --model gpt-5.6
  llm-router-axi check --harness opencode --model opencode-go/qwen3.8-flash --json
  llm-router-axi check --harness cursor --model auto --force-override
`;

interface LaunchCandidate {
  harness: string;
  model?: string;
  effort?: string;
  provider: string;
  pool?: string;
}

interface CheckPayload {
  allowed: boolean;
  forced: boolean;
  requested: LaunchCandidate;
  reason: string;
  next: LaunchCandidate | null;
}

export async function checkCommand(args: string[]): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) return CHECK_HELP;
  const { values, booleans } = parseArgs("check", args, CHECK_FLAGS);
  const harness = requireNonEmpty(values.get("--harness"), "--harness");
  const model = requireNonEmpty(values.get("--model"), "--model");
  const now = requireInteger(values.get("--now"), "--now") ?? Math.floor(Date.now() / 1000);
  const missing = [harness ? undefined : "--harness", model ? undefined : "--model"]
    .filter((value): value is string => value !== undefined);
  if (missing.length > 0) {
    throw new AxiError(
      `check is missing required flag${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
      "VALIDATION_ERROR",
      ["Usage: llm-router-axi check --harness <name> --model <id>"],
    );
  }

  const read = loadEffectivePolicy();
  if (!read.ok) {
    throw new AxiError(read.message, "VALIDATION_ERROR", [
      ...read.issues.map((issue) => `${issue.path}: ${issue.message}`),
      "Run `llm-router-axi policy validate` for the full issue list",
    ]);
  }
  const chain = overrideChain(read.policy, harness as string, model as string);
  const quota = loadUsage({
    ...(values.get("--usage-json") ? { usageJson: values.get("--usage-json") } : {}),
    maxAgeSeconds: read.policy.routing.telemetryMaxAgeSeconds,
    now,
  });
  const profiles = chain.map((candidate) => toProfile(read.policy, candidate, quota));
  const settings = {
    reservePercent: read.policy.routing.reservePercent,
    telemetryMaxAgeSeconds: read.policy.routing.telemetryMaxAgeSeconds,
    cooldownSeconds: read.policy.routing.cooldownSeconds,
  };

  const evaluated = withStateLock(() => {
    const state = loadState();
    const requested = selectProfiles({
      profiles: [profiles[0] as EngineProfile], quota, settings, now, state, home: homeDir(), ranks: [0],
    });
    // `check` is a gate, not a dispatch. Persist only cooldown evidence the
    // selector learned; do not rotate least-recent-use state merely by probing.
    const gatedState = { ...state, cooldowns: requested.state.cooldowns };
    const alternatives = profiles.slice(1);
    const next = alternatives.length > 0
      ? selectProfiles({
          profiles: alternatives,
          quota,
          settings,
          now,
          state: gatedState,
          home: homeDir(),
          ranks: alternatives.map((_, index) => index),
        })
      : undefined;
    saveState(gatedState);
    return { requested, next };
  });

  const requestedEvaluation = evaluated.requested.evaluations[0] as CandidateEvaluation;
  const capacity = capacityVerdict(read.policy, quota);
  const eligible = requestedEvaluation.eligible && capacity.ok;
  const reason = requestedEvaluation.eligible
    ? (capacity.ok ? requestedEvaluation.detail : (capacity.reasons[0] ?? "route refused by machine capacity"))
    : requestedEvaluation.detail;
  const nextIndex = capacity.ok && evaluated.next?.selected
    ? profiles.slice(1).indexOf(evaluated.next.selected)
    : -1;
  const next = nextIndex >= 0
    ? launchCandidate(read.policy, chain[nextIndex + 1] as Candidate, profiles[nextIndex + 1] as EngineProfile)
    : null;
  const forced = booleans.has("--force-override");
  const payload: CheckPayload = {
    allowed: eligible || forced,
    forced,
    requested: launchCandidate(read.policy, chain[0] as Candidate, profiles[0] as EngineProfile),
    reason,
    next,
  };

  if (forced && !eligible) appendOverrideAudit(now, payload);
  if (!payload.allowed) process.exitCode = 1;
  const output: Record<string, unknown> = payload.allowed
    ? { ...payload }
    : { error: "explicit override refused", code: "OVERRIDE_REFUSED", ...payload };
  if (booleans.has("--json")) return JSON.stringify(output, null, 2);
  return payload.allowed
    ? toon(output)
    : toon(output, helpBlock([
        "Launch the returned next candidate instead",
        "Pass `--force-override` only when the refusal is understood; the bypass is logged",
      ]));
}

function overrideChain(policy: Policy, harness: string, model: string): Candidate[] {
  let generic: Candidate[] | undefined;
  for (const group of Object.values(policy.candidateGroups)) {
    if (group.some((candidate) => candidate.harness === harness && candidate.model === model)) {
      const requested = group.find((candidate) => candidate.harness === harness && candidate.model === model) as Candidate;
      return [requested, ...group.filter((candidate) => candidate !== requested)];
    }
    if (!generic && group.some((candidate) => candidate.harness === harness && candidate.model === undefined)) {
      generic = group;
    }
  }
  if (generic) {
    const base = generic.find((candidate) => candidate.harness === harness && candidate.model === undefined) as Candidate;
    const requested = { ...base, model };
    return [requested, ...generic.filter((candidate) => candidate !== base)];
  }
  throw new AxiError(
    `override is not represented in policy: harness=${harness} model=${model}`,
    "VALIDATION_ERROR",
    ["Add the harness to a candidate group or correct the explicit override"],
  );
}

function toProfile(policy: Policy, candidate: Candidate, quota: Parameters<typeof candidateToProfile>[3]): EngineProfile {
  const resolved = candidateToProfile(policy, candidate, candidate.effort ?? "medium", quota);
  if ("error" in resolved) {
    throw new AxiError(resolved.error, "VALIDATION_ERROR", [
      `candidate harness=${candidate.harness} provider=${candidate.provider}`,
      "Fix the candidate in the policy (run `llm-router-axi policy show --full`)",
    ]);
  }
  return resolved.profile;
}

function launchCandidate(policy: Policy, candidate: Candidate, profile: EngineProfile): LaunchCandidate {
  const pool = candidatePoolName(policy, candidate);
  return {
    harness: profile.harness,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.effort ? { effort: profile.effort } : {}),
    provider: profile.provider,
    ...(pool ? { pool } : {}),
  };
}

function overrideAuditPath(): string {
  return process.env.LLM_ROUTER_OVERRIDE_LOG || join(stateDir(), "override-audit.jsonl");
}

function appendOverrideAudit(at: number, payload: CheckPayload): void {
  const path = overrideAuditPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify({
    v: 1,
    at,
    harness: payload.requested.harness,
    ...(payload.requested.model ? { model: payload.requested.model } : {}),
    provider: payload.requested.provider,
    reason: payload.reason,
    next: payload.next,
  })}\n`, { encoding: "utf8", mode: 0o600 });
}

function requireNonEmpty(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0) {
    throw new AxiError(`${flag} must not be empty`, "VALIDATION_ERROR", [`Pass a value: ${flag} <value>`]);
  }
  return value;
}
