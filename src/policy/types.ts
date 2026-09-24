export type Effort = "low" | "medium" | "high";

export type Harness =
  | "claude"
  | "codex"
  | "grok"
  | "cursor"
  | "agy"
  | "opencode"
  | "copilot"
  | "cline";

export type Kind = "ship" | "scout" | "review" | "architecture" | "admin";

export type Difficulty = "easy" | "medium" | "hard";

export interface Candidate {
  harness: Harness;
  provider: string;
  model?: string;
  pool?: string;
  effort?: Effort;
  needs?: string[];
}

export interface DifficultyLane {
  effort: Effort;
  candidates: Array<string | Candidate>;
}

export interface KindLanes {
  easy: DifficultyLane;
  medium: DifficultyLane;
  hard: DifficultyLane;
}

export interface RoutingSettings {
  reservePercent: number;
  cooldownSeconds: number;
  telemetryMaxAgeSeconds: number;
  maxFallbacks: number;
}

export type MemoryPressureMax = "normal" | "warn" | "ignore";

export interface CapacitySettings {
  agentCeiling: number;
  oneSuiteAtATime: boolean;
  memoryFreeReservePercent: number;
  maxLoadPerCore: number;
  /**
   * Worst kernel memory-pressure level still admitted. `normal` refuses on
   * `warn`, `warn` refuses only on `critical`, `ignore` never refuses on
   * pressure. An unreadable pressure reading never refuses. Optional for a
   * policy file written before P2b; the code default is `warn`.
   */
  memoryPressureMax?: MemoryPressureMax;
  /**
   * Swap-in-use ceiling in percent, or `null` to report without refusing.
   * Optional for a policy file written before P2b; the code default is `null`
   * because a long-lived dev box swaps inactive pages without being strained.
   */
  maxSwapUsedPercent?: number | null;
  /**
   * Configured llama.cpp --parallel ceiling for the local qwen fleet.
   * Reported in capacity measured{}; enforced only for purpose `local-llm`.
   * Optional for older policy files; code default is 2.
   */
  llamaParallel?: number;
}

/**
 * The in-run step-down doctrine, deliberately spelled with the same keys as
 * firstmate's `config/crew-dispatch.json` so `bin/fm-model-fallback.sh` can be
 * driven from the router policy in P3 (plan §2.3).
 */
export interface FallbackSettings {
  /** harness -> ordered model ids to step down through in-run. */
  modelFallback: Record<string, string[]>;
  /** Ordered harness lanes an exhausted chain may move to. */
  fallbackLanes: string[];
  /** Harnesses whose chain wraps back to its head instead of exhausting. */
  modelFallbackCycles: string[];
}

export interface PoolSettings {
  cursor: { default: "auto_usage" | "api_usage"; auto: string; api: string };
  agy: {
    default: "gemini" | "nonGemini";
    gemini: string[];
    nonGemini: string[];
  };
  opencode: {
    default: "opencode-go" | "opencode";
    go: string;
    free: string;
    /**
     * Window ids the paid Go pool is priced on. quota-axi reports the
     * `opencode-go` row with unknown joint semantics (it cannot claim the
     * rolling, weekly, and monthly windows jointly bind every model), so the
     * doctrine names the allowance windows explicitly — the same way agy's
     * `gemini` names its two windows — instead of min-pricing every live
     * window. Optional for a policy file written before the quota-axi row
     * existed; without it the Go pool falls back to every live window.
     */
    goWindows?: string[];
  };
}

export interface SpendPrioritySettings {
  weight: number;
  tieBreaker: "least-recent-use" | "declared-order";
  preferKnown: boolean;
}

export interface JevShadowSettings {
  /**
   * Shadow-mode classify hook in `route` (slice 3): when true, `route
   * --task <text>` additionally classifies the task text with Jev and
   * records the Jev-derived descriptor next to the supplied one. The
   * routing decision is always computed from the supplied descriptor and
   * never changes. Optional; absent means disabled.
   */
  enabled?: boolean;
}

export interface JevSettings {
  /** Shadow-mode hook settings. Optional; absent means disabled. */
  shadow?: JevShadowSettings;
}

export interface Policy {
  $schema?: string;
  version: 1;
  routing: RoutingSettings;
  capacity: CapacitySettings;
  pools: PoolSettings;
  spendPriority: SpendPrioritySettings;
  candidateGroups: Record<string, Candidate[]>;
  /**
   * Optional Jev settings (slice 3 shadow hook). Absent means every Jev
   * hook is disabled; older policy files without it keep validating.
   */
  jev?: JevSettings;
  kinds: Record<Kind, KindLanes>;
  /**
   * The in-run step-down chains. Optional so an existing policy file written
   * before P2b keeps validating; the bundled default always declares them.
   */
  modelFallback?: Record<string, string[]>;
  fallbackLanes?: string[];
  modelFallbackCycles?: string[];
}
