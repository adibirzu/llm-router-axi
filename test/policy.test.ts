import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  POLICY_SCHEMA,
  readDefaultPolicy,
  resolveLaneCandidates,
  validatePolicy,
} from "../src/policy/index.js";

const schemaPath = fileURLToPath(new URL("../policy.schema.json", import.meta.url));

function cloneDefault() {
  return JSON.parse(JSON.stringify(readDefaultPolicy())) as Record<string, unknown>;
}

describe("default policy", () => {
  it("validates against the bundled schema", () => {
    const result = validatePolicy(readDefaultPolicy());
    expect(result.ok).toBe(true);
  });

  it("publishes policy.schema.json generated from the TS source of truth", () => {
    const committed = readFileSync(schemaPath, "utf8");
    expect(committed).toBe(`${JSON.stringify(POLICY_SCHEMA, null, 2)}\n`);
  });

  it("carries the captain's routing constants", () => {
    const policy = readDefaultPolicy();
    expect(policy.routing.reservePercent).toBe(20);
    expect(policy.routing.cooldownSeconds).toBe(1800);
    expect(policy.routing.telemetryMaxAgeSeconds).toBe(300);
    expect(policy.capacity.agentCeiling).toBe(10);
    expect(policy.capacity.oneSuiteAtATime).toBe(true);
  });

  it("keeps every lane's candidate-group references resolvable", () => {
    const policy = readDefaultPolicy();
    const groups = Object.keys(policy.candidateGroups);
    for (const lanes of Object.values(policy.kinds)) {
      for (const lane of Object.values(lanes)) {
        for (const entry of lane.candidates) {
          if (typeof entry === "string") {
            expect(groups).toContain(entry);
          }
        }
      }
    }
  });

  it("declares the doctrine: architects, reviewers, then Go workers before Zen", () => {
    const policy = readDefaultPolicy();
    const architects = policy.candidateGroups.architects;
    expect(architects.map((candidate) => candidate.harness)).toEqual(["claude", "codex"]);

    const reviewers = policy.candidateGroups.reviewers;
    expect(reviewers.map((candidate) => candidate.harness)).toEqual([
      "grok",
      "agy",
      "cursor",
    ]);

    const workers = policy.candidateGroups.workers;
    const firstGo = workers.findIndex((candidate) => candidate.pool === "opencode-go");
    const firstFree = workers.findIndex((candidate) => candidate.pool === "opencode");
    const firstSubscription = workers.findIndex(
      (candidate) => candidate.pool === undefined && candidate.harness !== "opencode",
    );
    expect(firstGo).toBe(0);
    expect(firstFree).toBeGreaterThan(firstGo);
    expect(firstSubscription).toBeGreaterThan(firstFree);
  });

  it("spells the split pools exactly as the P0 fixtures do", () => {
    const policy = readDefaultPolicy();
    expect(policy.pools.cursor.auto).toBe("auto_usage");
    expect(policy.pools.cursor.api).toBe("api_usage");
    expect(policy.pools.agy.gemini).toContain("gemini_5h");
    expect(policy.pools.agy.nonGemini).toContain("claude_gpt_5h");
    expect(policy.pools.opencode.go).toBe("opencode-go");
    expect(policy.pools.opencode.free).toBe("opencode");
  });

  it("declares the in-run step-down doctrine and the memory gauges", () => {
    const policy = readDefaultPolicy();
    expect(policy.modelFallback?.opencode?.[0]).toBe("opencode-go/deepseek-v4.1-flash");
    expect(policy.fallbackLanes).toEqual(["opencode", "grok", "cursor", "agy", "claude"]);
    expect(policy.modelFallbackCycles).toContain("opencode");
    expect(policy.capacity.memoryFreeReservePercent).toBe(10);
    expect(policy.capacity.memoryPressureMax).toBe("warn");
    expect(policy.capacity.maxSwapUsedPercent).toBeNull();
  });

  it("fans a shared candidate group into all three difficulties", () => {
    const policy = readDefaultPolicy();
    for (const difficulty of ["easy", "medium", "hard"] as const) {
      const lane = policy.kinds.ship[difficulty];
      expect(resolveLaneCandidates(policy, lane)).toHaveLength(
        policy.candidateGroups.workers.length,
      );
    }
  });
});

describe("malformed policy refusal", () => {
  const cases: Array<{ name: string; mutate: (policy: Record<string, unknown>) => void; path: string }> = [
    {
      name: "reservePercent above the 0..99 range",
      mutate: (policy) => {
        (policy.routing as Record<string, unknown>).reservePercent = 150;
      },
      path: "/routing/reservePercent",
    },
    {
      name: "cooldownSeconds below the selector floor",
      mutate: (policy) => {
        (policy.routing as Record<string, unknown>).cooldownSeconds = 10;
      },
      path: "/routing/cooldownSeconds",
    },
    {
      name: "unknown top-level property",
      mutate: (policy) => {
        policy.bogus = true;
      },
      path: "(root)",
    },
    {
      name: "missing candidateGroups",
      mutate: (policy) => {
        delete policy.candidateGroups;
      },
      path: "(root)",
    },
    {
      name: "empty candidate group",
      mutate: (policy) => {
        (policy.candidateGroups as Record<string, unknown>).workers = [];
      },
      path: "/candidateGroups/workers",
    },
    {
      name: "unknown harness",
      mutate: (policy) => {
        const groups = policy.candidateGroups as Record<string, Array<Record<string, unknown>>>;
        groups.workers[0].harness = "gemini";
      },
      path: "/candidateGroups/workers/0/harness",
    },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.name}`, () => {
      const policy = cloneDefault();
      testCase.mutate(policy);
      const result = validatePolicy(policy);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((issue) => issue.path === testCase.path)).toBe(true);
      }
    });
  }

  it("refuses a lane that references an undeclared candidate group", () => {
    const policy = cloneDefault();
    const kinds = policy.kinds as Record<string, Record<string, { candidates: unknown[] }>>;
    kinds.ship.easy.candidates = ["ghost-workers"];
    const result = validatePolicy(policy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find(
        (candidate) => candidate.path === "/kinds/ship/easy/candidates/0",
      );
      expect(issue?.message).toContain("ghost-workers");
    }
  });

  it("refuses a non-object", () => {
    expect(validatePolicy([]).ok).toBe(false);
    expect(validatePolicy("policy").ok).toBe(false);
    expect(validatePolicy(null).ok).toBe(false);
  });

  it("refuses modelFallback and its legacy alias together", () => {
    const policy = cloneDefault();
    policy._model_fallback = { claude: ["a", "b"] };
    const result = validatePolicy(policy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === "/_model_fallback")).toBe(true);
    }
  });

  it("refuses a cyclic lane whose chain has fewer than two models", () => {
    const policy = cloneDefault();
    policy.modelFallback = { claude: ["only-one"] };
    const result = validatePolicy(policy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.message.includes("at least two model ids"))).toBe(true);
    }
  });

  it("refuses a modelFallback key that is not a routable harness", () => {
    const policy = cloneDefault();
    policy.modelFallback = { "not-a-harness": ["a"] };
    expect(validatePolicy(policy).ok).toBe(false);
  });
});
