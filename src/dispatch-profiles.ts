import { createHash } from "node:crypto";

import { AxiError } from "axi-sdk-js";

import type { EngineProfile } from "./selector.js";

/**
 * A faithful port of `fm-dispatch-select.mjs`'s `parseProfiles`/`cleanProfile`
 * input contract. firstmate's selector accepts a full rule object with `use`,
 * one profile object, or a non-empty profile array; each profile names
 * `harness`, optional `provider`, `model`, `effort`, and `quotaWindow`. This
 * module owns only that parsing/validation, so `llm-router-axi select` can
 * consume the fork's input shape and the fork can become a shim in P3.
 *
 * Every refusal string is frozen from the fork's own `die(...)` set.
 */

/** Harnesses the fork's `select` accepts before the provider gate runs. */
export const VERIFIED_HARNESSES: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "opencode",
  "pi",
  "pi-signed",
  "grok",
  "kimi",
  "cursor",
  "muse",
  "agy",
  "cline",
  "copilot",
]);

/** Providers a candidate may be metered on (quota telemetry identities). */
export const DISPATCH_PROVIDERS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "grok",
  "cursor",
  "agy",
]);

export const NATIVE_PROVIDER: ReadonlyMap<string, string> = new Map([
  ["claude", "claude"],
  ["codex", "codex"],
  ["grok", "grok"],
  ["cursor", "cursor"],
  ["agy", "agy"],
]);

export interface DispatchProfile {
  /** The launch/pricing profile handed to the selection engine. */
  profile: EngineProfile;
  provider: string;
  quotaWindow: string | null;
  /** Frozen concrete identity, including the pool declaration. */
  identity: string;
  /** sha256(identity), the least-recent-use key. */
  key: string;
}

function die(message: string): never {
  throw new AxiError(message, "VALIDATION_ERROR", [
    "Fix the dispatch profiles and retry",
    "Input is a single profile, a {use:[...]} rule, or a non-empty array",
  ]);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The launch shape: pricing declarations never reach stdout. */
export function cleanDispatchProfile(
  profile: Pick<EngineProfile, "harness" | "provider" | "model" | "effort">,
): Record<string, unknown> {
  return {
    harness: profile.harness,
    provider: profile.provider,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.effort ? { effort: profile.effort } : {}),
  };
}

/** Parse the fork's JSON input shape into concrete, validated profiles. */
export function parseDispatchProfiles(input: string): DispatchProfile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    die("dispatch input is malformed JSON");
  }
  let value = parsed;
  if (value && !Array.isArray(value) && typeof value === "object" && Object.hasOwn(value, "use")) {
    value = (value as { use: unknown }).use;
  }
  const list: unknown[] = Array.isArray(value) ? value : [value];
  if (list.length === 0) die("dispatch profile array must not be empty");

  const seen = new Set<string>();
  return list.map((raw) => {
    if (!raw || Array.isArray(raw) || typeof raw !== "object") {
      die("each dispatch profile must be an object");
    }
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate["harness"] !== "string" || !candidate["harness"]) {
      die("each dispatch profile needs a non-empty harness");
    }
    const harness = candidate["harness"] as string;
    for (const field of ["provider", "model", "effort", "quotaWindow"]) {
      if (Object.hasOwn(candidate, field)) {
        const fieldValue = candidate[field];
        if (typeof fieldValue !== "string" || !fieldValue) {
          die(`dispatch profile ${field} must be a non-empty string when present`);
        }
      }
    }
    if (!VERIFIED_HARNESSES.has(harness)) {
      die(`subscription dispatch requires a verified harness, not ${harness}`);
    }
    if (harness === "kimi") die("Kimi is unsupported for subscription dispatch");

    const nativeProvider = NATIVE_PROVIDER.get(harness);
    const explicitProvider =
      typeof candidate["provider"] === "string" && candidate["provider"]
        ? (candidate["provider"] as string)
        : undefined;
    if (nativeProvider && explicitProvider && explicitProvider !== nativeProvider) {
      die(`native harness ${harness} requires provider ${nativeProvider}`);
    }
    const provider = explicitProvider ?? nativeProvider;
    if (!provider || !DISPATCH_PROVIDERS.has(provider)) {
      die(`provider identity is unresolved or unsupported for harness ${harness}`);
    }
    const model = typeof candidate["model"] === "string" ? (candidate["model"] as string) : undefined;
    const effort =
      typeof candidate["effort"] === "string" ? (candidate["effort"] as string) : undefined;

    const profile: EngineProfile = {
      harness,
      provider,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    };
    const quotaWindow =
      typeof candidate["quotaWindow"] === "string" ? (candidate["quotaWindow"] as string) : null;
    const identity = JSON.stringify({ ...profile, provider, quotaWindow });
    if (seen.has(identity)) die("dispatch profile array contains a duplicate concrete profile");
    seen.add(identity);
    return {
      profile: quotaWindow ? { ...profile, quotaWindow } : profile,
      provider,
      quotaWindow,
      identity,
      key: digest(identity),
    };
  });
}
