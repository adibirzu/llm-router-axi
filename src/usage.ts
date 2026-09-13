import { readFileSync } from "node:fs";

import { spawnSync } from "node:child_process";

import type { Candidate, Policy } from "./policy/types.js";
import type { EngineProfile, QuotaProvider, QuotaRead, QuotaTelemetry } from "./selector.js";

/** Provider identity is the router's job: native harnesses resolve by name. */
const NATIVE_PROVIDER: ReadonlyMap<string, string> = new Map([
  ["claude", "claude"],
  ["codex", "codex"],
  ["grok", "grok"],
  ["cursor", "cursor"],
  ["agy", "agy"],
]);

const DEFAULT_USAGE_AXI = "usage-axi";

/**
 * Load the usage-axi document: `usage-axi --json --full` by default, or a
 * fixture via `--usage-json`. `machine{}` rides in the same document.
 */
export function loadUsage(options: { usageJson?: string } = {}): QuotaRead {
  let text: string;
  if (options.usageJson) {
    try {
      text = readFileSync(options.usageJson, "utf8");
    } catch {
      return { available: false, reason: "quota fixture unreadable" };
    }
  } else {
    const executable = process.env.LLM_ROUTER_USAGE_AXI ?? DEFAULT_USAGE_AXI;
    const result = spawnSync(executable, ["--json", "--full"], {
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) {
      return { available: false, reason: "quota-axi unavailable" };
    }
    text = result.stdout;
  }

  try {
    const data = JSON.parse(text) as QuotaTelemetry;
    if (!data || !Array.isArray(data.providers)) throw new Error("shape");
    return { available: true, data };
  } catch {
    return { available: false, reason: "quota telemetry malformed" };
  }
}

type ProviderResolution = { provider: string } | { error: string };

function resolveProvider(harness: string, provider: string): ProviderResolution {
  const native = NATIVE_PROVIDER.get(harness);
  if (native && provider !== native) {
    return { error: `native harness ${harness} requires provider ${native}` };
  }
  if (!provider) {
    return { error: `provider identity is unresolved or unsupported for harness ${harness}` };
  }
  return { provider };
}

interface PoolDeclaration {
  quotaWindow?: string;
  poolWindows?: string[];
  poolLabel?: string;
}

function usageProvider(
  quota: QuotaRead,
  providerName: string,
): QuotaProvider | undefined {
  if (!quota.available) return undefined;
  return quota.data.providers.find((item) => item?.provider === providerName);
}

/**
 * Price a candidate on its own pool when it declares one; otherwise the
 * conservative provider-wide minimum. Policy `pools` and usage-axi `pools[]`
 * both feed the mapping, so a policy pool name and a raw window id are both
 * expressible.
 */
function resolvePool(
  policy: Policy,
  candidate: Candidate,
  providerName: string,
  quota: QuotaRead,
): PoolDeclaration {
  const provider = usageProvider(quota, providerName);
  const declared = candidate.pool ?? opencodeDefaultPool(policy, candidate, provider);

  if (!declared) {
    return {};
  }

  const livePool = provider?.pools?.find(
    (item) => item.id === declared || item.windowIds.includes(declared),
  );
  if (livePool && livePool.windowIds.length > 0) {
    return poolFromWindows(livePool.windowIds, livePool.id);
  }

  if (providerName === "agy") {
    const agy = policy.pools.agy;
    if (declared === "gemini" || agy.gemini.includes(declared)) {
      return poolFromWindows(agy.gemini, "gemini");
    }
    if (declared === "nonGemini" || declared === "claude_gpt" || agy.nonGemini.includes(declared)) {
      return poolFromWindows(agy.nonGemini, "nonGemini");
    }
  }
  if (providerName === "cursor") {
    const cursor = policy.pools.cursor;
    if (declared === cursor.auto || declared === "auto") {
      return poolFromWindows([cursor.auto], "auto");
    }
    if (declared === cursor.api || declared === "api") {
      return poolFromWindows([cursor.api], "api");
    }
  }
  if (providerName === "opencode") {
    const opencode = policy.pools.opencode;
    if (declared === opencode.go || declared === "go") {
      return { poolWindows: opencodeWindows(provider, opencode.go), poolLabel: opencode.go };
    }
    if (declared === opencode.free || declared === "free") {
      return { poolWindows: opencodeWindows(provider, opencode.free), poolLabel: opencode.free };
    }
  }

  return { quotaWindow: declared, poolWindows: [declared] };
}

function opencodeDefaultPool(
  policy: Policy,
  candidate: Candidate,
  provider: QuotaProvider | undefined,
): string | undefined {
  if (candidate.harness !== "opencode") return undefined;
  const model = candidate.model ?? "";
  if (model.startsWith("opencode-go/")) return policy.pools.opencode.go;
  if (model.startsWith("opencode/")) return policy.pools.opencode.free;
  if (provider?.pools && provider.pools.length > 0) return policy.pools.opencode.default;
  return undefined;
}

function opencodeWindows(provider: QuotaProvider | undefined, poolId: string): string[] {
  const pool = provider?.pools?.find((item) => item.id === poolId);
  if (pool && pool.windowIds.length > 0) return pool.windowIds;
  const live = (provider?.windows ?? [])
    .map((window) => window?.id)
    .filter((id): id is string => typeof id === "string");
  return live;
}

function poolFromWindows(windowIds: string[], label: string): PoolDeclaration {
  if (windowIds.length === 1) {
    return { quotaWindow: windowIds[0], poolWindows: windowIds };
  }
  return { poolWindows: windowIds, poolLabel: label };
}

/** Build the engine profile a policy candidate routes as. */
export function candidateToProfile(
  policy: Policy,
  candidate: Candidate,
  laneEffort: string,
  quota: QuotaRead,
): { profile: EngineProfile } | { error: string } {
  const resolved = resolveProvider(candidate.harness, candidate.provider);
  if ("error" in resolved) return resolved;
  const provider = resolved.provider;
  const pool = resolvePool(policy, candidate, provider, quota);
  const profile: EngineProfile = {
    harness: candidate.harness,
    provider,
    ...(candidate.model ? { model: candidate.model } : {}),
    effort: candidate.effort ?? laneEffort,
    ...(pool.quotaWindow ? { quotaWindow: pool.quotaWindow } : {}),
    ...(pool.poolWindows ? { poolWindows: pool.poolWindows } : {}),
    ...(pool.poolLabel ? { poolLabel: pool.poolLabel } : {}),
  };
  return { profile };
}

/** The human pool name a candidate draws on, for the decision's `pool` field. */
export function candidatePoolName(
  policy: Policy,
  candidate: Candidate,
): string | undefined {
  if (candidate.pool) return candidate.pool;
  if (candidate.harness !== "opencode") return undefined;
  const model = candidate.model ?? "";
  if (model.startsWith("opencode-go/")) return policy.pools.opencode.go;
  if (model.startsWith("opencode/")) return policy.pools.opencode.free;
  return policy.pools.opencode.default;
}

export type { QuotaProvider, QuotaRead, QuotaTelemetry } from "./selector.js";
