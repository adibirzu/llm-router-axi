export type Effort = "low" | "medium" | "high";

export type Harness =
  | "claude"
  | "codex"
  | "grok"
  | "cursor"
  | "agy"
  | "opencode";

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

export interface CapacitySettings {
  agentCeiling: number;
  oneSuiteAtATime: boolean;
  memoryFreeReservePercent: number;
  maxLoadPerCore: number;
}

export interface PoolSettings {
  cursor: { default: "auto_usage" | "api_usage"; auto: string; api: string };
  agy: {
    default: "gemini" | "nonGemini";
    gemini: string[];
    nonGemini: string[];
  };
  opencode: { default: "opencode-go" | "opencode"; go: string; free: string };
}

export interface SpendPrioritySettings {
  weight: number;
  tieBreaker: "least-recent-use" | "declared-order";
  preferKnown: boolean;
}

export interface Policy {
  $schema?: string;
  version: 1;
  routing: RoutingSettings;
  capacity: CapacitySettings;
  pools: PoolSettings;
  spendPriority: SpendPrioritySettings;
  candidateGroups: Record<string, Candidate[]>;
  kinds: Record<Kind, KindLanes>;
}
