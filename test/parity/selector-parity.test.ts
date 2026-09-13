import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyEvidence,
  emptyState,
  selectProfiles,
  type EngineProfile,
  type EngineSettings,
  type EngineState,
  type QuotaRead,
  type QuotaTelemetry,
} from "../../src/selector.js";
import { loadState, saveState } from "../../src/state.js";

const SELECTOR = fileURLToPath(
  new URL("../fixtures/selector/fm-dispatch-select.mjs", import.meta.url),
);

const NOW = 1000;
const STAMP = "1970-01-01T00:16:40.000Z";
const OLD_STAMP = "1970-01-01T00:00:00.000Z";

interface Scenario {
  name: string;
  quota: unknown | string;
  profiles: EngineProfile[];
  settings?: Partial<EngineSettings>;
  seedState?: Partial<EngineState>;
  expect: "select" | "refuse";
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function settingsOf(overrides: Partial<EngineSettings> = {}): EngineSettings {
  return {
    reservePercent: 20,
    telemetryMaxAgeSeconds: 300,
    cooldownSeconds: 1800,
    ...overrides,
  };
}

/** Run the pinned firstmate selector on the same inputs. */
function runSelector(
  scenario: Scenario,
  home: string,
  quotaFile: string,
  stateFile: string,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [SELECTOR, "select", "--quota-json", quotaFile, "--now", String(NOW), JSON.stringify(scenario.profiles.map(selectorProfile))],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FM_HOME: home,
        FM_STATE_OVERRIDE: join(home, "state"),
        FM_CONFIG_OVERRIDE: join(home, "config"),
        FM_DISPATCH_STATE_FILE: stateFile,
      },
    },
  );
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Run our engine on the mirror inputs, persisting state in the same shape. */
function runEngine(
  scenario: Scenario,
  home: string,
  stateFile: string,
): {
  code: number;
  selected?: EngineProfile;
  reasons: string[];
  state: EngineState;
} {
  const state = loadState(stateFile);
  const parsed = typeof scenario.quota === "string" ? JSON.parse(scenario.quota) : scenario.quota;
  const quota: QuotaRead = { available: true, data: parsed as QuotaTelemetry };
  const report = selectProfiles({
    profiles: scenario.profiles,
    quota,
    settings: settingsOf(scenario.settings),
    now: NOW,
    state,
    home,
  });
  saveState(report.state, stateFile);
  return {
    code: report.exitCode,
    ...(report.selected ? { selected: report.selected } : {}),
    reasons: [...new Set(report.evaluations.map((evaluation) => evaluation.reason))],
    state: report.state,
  };
}

function seed(partial: Partial<EngineState>): EngineState {
  return { ...emptyState(), ...partial };
}

/** Selector profile shape: it derives provider from native harness or explicit provider. */
function selectorProfile(profile: EngineProfile): Record<string, unknown> {
  return {
    harness: profile.harness,
    provider: profile.provider,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.effort ? { effort: profile.effort } : {}),
    ...(profile.quotaWindow ? { quotaWindow: profile.quotaWindow } : {}),
  };
}

function clean(profile: EngineProfile): Record<string, unknown> {
  return {
    harness: profile.harness,
    provider: profile.provider,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.effort ? { effort: profile.effort } : {}),
  };
}

function quota(providers: unknown[], generatedAt = STAMP): { schemaVersion: number; generatedAt: string; providers: unknown[] } {
  return { schemaVersion: 5, generatedAt, providers };
}

function window(id: string, percentRemaining: number): unknown {
  return { id, percentRemaining };
}

function provider(name: string, windows: unknown[], status = "fresh"): unknown {
  return { provider: name, state: { status, stale: false }, windows };
}

function prepare(
  scenario: Scenario,
): { home: string; quotaFile: string; selectorState: string; engineState: string } {
  const home = mkdtempSync(join(tmpdir(), "llm-router-parity-"));
  tempDirs.push(home);
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(join(home, "config"), { recursive: true });
  const quotaFile = join(home, "quota.json");
  writeFileSync(
    quotaFile,
    typeof scenario.quota === "string" ? scenario.quota : JSON.stringify(scenario.quota),
  );
  if (scenario.settings) {
    writeFileSync(
      join(home, "config", "crew-dispatch.json"),
      JSON.stringify({ subscriptionRouting: scenario.settings }),
    );
  }
  const selectorState = join(home, "state", "selector-state.json");
  const engineState = join(home, "state", "engine-state.json");
  if (scenario.seedState) {
    const seeded = JSON.stringify(seed(scenario.seedState));
    writeFileSync(selectorState, seeded);
    writeFileSync(engineState, seeded);
  }
  return { home, quotaFile, selectorState, engineState };
}

function assertParity(scenario: Scenario): void {
  const env = prepare(scenario);
  const selector = runSelector(scenario, env.home, env.quotaFile, env.selectorState);
  const engine = runEngine(scenario, env.home, env.engineState);

  if (scenario.expect === "refuse") {
    expect(engine.code, `${scenario.name}: engine should refuse`).not.toBe(0);
    // The refusals must be identical, not merely both non-zero.
    const selectorReasons = selector.stderr
      .split("\n")
      .map((line) => line.replace(/^fm-dispatch-select: /, "").trim())
      .filter((line) => line.startsWith("candidate "));
    for (const reason of selectorReasons) {
      expect(engine.reasons, `${scenario.name}: missing selector reason`).toContain(reason);
    }
    expect(selector.stderr).toContain("no subscription candidate has current dispatch capacity evidence");
    return;
  }

  expect(selector.code, `${scenario.name}: selector failed: ${selector.stderr}`).toBe(0);
  expect(engine.code, `${scenario.name}: engine refused`).toBe(0);
  const chosen = JSON.parse(selector.stdout) as Record<string, unknown>;
  expect(clean(engine.selected as EngineProfile)).toEqual(chosen);

  const selectorReasons = selector.stderr
    .split("\n")
    .map((line) => line.replace(/^fm-dispatch-select: /, "").trim())
    .filter((line) => line.startsWith("candidate "));
  for (const reason of selectorReasons) {
    expect(engine.reasons, `${scenario.name}: diagnostic mismatch`).toContain(reason);
  }
}

describe("selector parity: the 14 firstmate fixtures", () => {
  it("1. distributes deterministically across healthy subscriptions", () => {
    const base: Scenario = {
      name: "distribution",
      quota: quota([provider("claude", [window("all", 80)]), provider("codex", [window("all", 80)])]),
      profiles: [
        { harness: "claude", provider: "claude", model: "sonnet" },
        { harness: "codex", provider: "codex", model: "gpt" },
      ],
      expect: "select",
    };
    assertParity(base);
    assertParity({ ...base, profiles: [...base.profiles].reverse() });
  });

  it("2. fails closed on stale, unavailable, and reserve-tight telemetry", () => {
    assertParity({
      name: "stale",
      quota: quota(
        [provider("claude", [window("all", 90)]), provider("codex", [window("all", 90)])],
        OLD_STAMP,
      ),
      profiles: [
        { harness: "claude", provider: "claude" },
        { harness: "codex", provider: "codex" },
      ],
      expect: "refuse",
    });
    assertParity({
      name: "reserve",
      quota: quota([provider("claude", [window("all", 20)]), provider("codex", [window("all", 21)])]),
      profiles: [
        { harness: "claude", provider: "claude" },
        { harness: "codex", provider: "codex" },
      ],
      expect: "select",
    });
    assertParity({
      name: "unavailable",
      quota: quota([
        provider("claude", [window("all", 99)], "auth_required"),
        provider("codex", [window("all", 75)]),
      ]),
      profiles: [
        { harness: "claude", provider: "claude" },
        { harness: "codex", provider: "codex" },
      ],
      expect: "select",
    });
    assertParity({
      name: "windowless",
      quota: quota([
        {
          provider: "claude",
          state: { status: "fresh", stale: false },
          quotaSemantics: { effectiveAvailability: [{ status: "known", effectivePercentRemaining: 90 }] },
        },
      ]),
      profiles: [{ harness: "claude", provider: "claude" }],
      expect: "refuse",
    });
  });

  it("3. applies a seeded cooldown and fails over", () => {
    assertParity({
      name: "cooldown",
      quota: quota([provider("claude", [window("all", 80)]), provider("codex", [window("all", 80)])]),
      profiles: [
        { harness: "claude", provider: "claude" },
        { harness: "codex", provider: "codex" },
      ],
      seedState: {
        sequence: 1,
        cooldowns: { codex: { until: 2800, reason: "verified", recordedAt: 1000 } },
      },
      expect: "select",
    });
  });

  it("5. keeps wrapper-provider and native Grok routes selectable", () => {
    assertParity({
      name: "wrapper-grok",
      quota: quota([provider("claude", [window("all", 70)]), provider("grok", [window("all", 70)])]),
      profiles: [
        { harness: "pi", provider: "claude", model: "anthropic/example" },
        { harness: "grok", provider: "grok" },
      ],
      expect: "select",
    });
  });

  it("6. does not price grok with usable auth but no window", () => {
    assertParity({
      name: "grok-no-window-alone",
      quota: quota([
        provider("claude", [window("all", 80)]),
        {
          provider: "grok",
          source: "unavailable",
          windows: [],
          state: { status: "error", stale: false, error: "Grok quota unavailable", authStatus: "usable" },
        },
      ]),
      profiles: [{ harness: "grok", provider: "grok" }],
      expect: "refuse",
    });
    assertParity({
      name: "grok-no-window-mixed",
      quota: quota([
        provider("claude", [window("all", 80)]),
        {
          provider: "grok",
          source: "unavailable",
          windows: [],
          state: { status: "error", stale: false, error: "Grok quota unavailable", authStatus: "usable" },
        },
      ]),
      profiles: [
        { harness: "claude", provider: "claude", model: "sonnet" },
        { harness: "grok", provider: "grok" },
      ],
      expect: "select",
    });
  });

  it("7. selects new verified adapters with explicit providers", () => {
    assertParity({
      name: "new-adapters",
      quota: quota([
        provider("claude", [window("all", 80)]),
        provider("codex", [window("all", 80)]),
        provider("cursor", [window("all", 80)]),
      ]),
      profiles: [
        { harness: "cline", provider: "claude", model: "claude-sonnet-5", effort: "high" },
        { harness: "cursor", provider: "cursor" },
        { harness: "copilot", provider: "claude", model: "gpt-5.6", effort: "max" },
      ],
      expect: "select",
    });
    assertParity({
      name: "cursor-exhausted",
      quota: quota([
        provider("codex", [window("all", 80)]),
        provider("cursor", [window("all", 0)]),
      ]),
      profiles: [
        { harness: "cursor", provider: "cursor" },
        { harness: "codex", provider: "codex" },
      ],
      expect: "select",
    });
  });

  it("8. prices a declared quota window instead of the provider minimum", () => {
    assertParity({
      name: "cursor-undeclared",
      quota: splitPool(0),
      profiles: [{ harness: "cursor", provider: "cursor", model: "cursor-grok-4.6-high" }],
      expect: "refuse",
    });
    assertParity({
      name: "cursor-auto",
      quota: splitPool(0),
      profiles: [
        { harness: "cursor", provider: "cursor", model: "cursor-grok-4.6-high", quotaWindow: "auto_usage" },
      ],
      expect: "select",
    });
    assertParity({
      name: "cursor-api",
      quota: splitPool(0),
      profiles: [{ harness: "cursor", provider: "cursor", quotaWindow: "api_usage" }],
      expect: "refuse",
    });
  });

  it("9. fails closed on a declared window absent from telemetry", () => {
    assertParity({
      name: "missing-window",
      quota: splitPool(0),
      profiles: [{ harness: "cursor", provider: "cursor", quotaWindow: "renamed_usage" }],
      expect: "refuse",
    });
    assertParity({
      name: "unusable-window",
      quota: quota([
        {
          provider: "cursor",
          state: { status: "fresh", stale: false },
          windows: [{ id: "auto_usage" }, window("included_usage", 90)],
        },
      ]),
      profiles: [{ harness: "cursor", provider: "cursor", quotaWindow: "auto_usage" }],
      expect: "refuse",
    });
  });

  it("10. ranks a known spendPriority above headroom", () => {
    assertParity({
      name: "spend-priority",
      quota: quota([
        spend("claude", 80, -1.1111),
        spend("codex", 40, -0.8333),
      ]),
      profiles: [
        { harness: "claude", provider: "claude", model: "sonnet" },
        { harness: "codex", provider: "codex", model: "gpt" },
      ],
      expect: "select",
    });
  });

  it("11. rotates tied spendPriority by least-recent use", () => {
    const scenario: Scenario = {
      name: "spend-tie",
      quota: quota([spend("claude", 80, 0), spend("codex", 80, 0)]),
      profiles: [
        { harness: "claude", provider: "claude" },
        { harness: "codex", provider: "codex" },
      ],
      expect: "select",
    };
    const env = prepare(scenario);
    const first = runEngine(scenario, env.home, env.engineState);
    writeFileSync(env.engineState, JSON.stringify(seed(first.state)));
    const second = runEngine(scenario, env.home, env.engineState);
    expect(first.selected?.provider).not.toBe(second.selected?.provider);
    assertParity(scenario);
  });

  it("12. prices agy gemini and claude/gpt pools separately", () => {
    const agyQuota = quota([
      {
        provider: "agy",
        state: { status: "fresh", stale: false },
        windows: [
          window("gemini_5h", 100),
          window("gemini_weekly", 93),
          window("claude_gpt_5h", 0),
          window("claude_gpt_weekly", 32),
        ],
        quotaSemantics: { effectiveAvailability: [] },
      },
    ]);
    assertParity({
      name: "agy-undeclared",
      quota: agyQuota,
      profiles: [{ harness: "agy", provider: "agy", model: "gemini-3.7-flash-high" }],
      expect: "refuse",
    });
    assertParity({
      name: "agy-gemini",
      quota: agyQuota,
      profiles: [{ harness: "agy", provider: "agy", model: "gemini-3.7-flash-high", quotaWindow: "gemini_5h" }],
      expect: "select",
    });
    assertParity({
      name: "agy-claude",
      quota: agyQuota,
      profiles: [{ harness: "agy", provider: "agy", model: "claude-sonnet-4-6", quotaWindow: "claude_gpt_5h" }],
      expect: "refuse",
    });
  });

  it("13. restores agy eligibility after a cooldown clear", () => {
    assertParity({
      name: "agy-cooldown",
      quota: quota([
        {
          provider: "agy",
          state: { status: "fresh", stale: false },
          windows: [window("gemini_5h", 100)],
        },
        provider("codex", [window("all", 90)]),
      ]),
      profiles: [
        { harness: "agy", provider: "agy", model: "gemini-3.7-flash-high", quotaWindow: "gemini_5h" },
        { harness: "codex", provider: "codex", model: "gpt" },
      ],
      seedState: {
        sequence: 1,
        cooldowns: { agy: { until: 2800, reason: "verified", recordedAt: 1000 } },
      },
      expect: "select",
    });
  });
});

function splitPool(apiRemaining: number): unknown {
  return quota([
    {
      provider: "cursor",
      state: { status: "fresh", stale: false },
      windows: [
        window("included_usage", 84),
        window("auto_usage", 97),
        window("api_usage", apiRemaining),
      ],
      quotaSemantics: {
        effectiveAvailability: [
          { scope: "all_models", status: "known", effectivePercentRemaining: apiRemaining },
        ],
      },
    },
  ]);
}

function spend(name: string, headroom: number, priority: number): unknown {
  return {
    provider: name,
    state: { status: "fresh", stale: false },
    windows: [window("all", headroom)],
    quotaSemantics: {
      status: "known",
      effectiveAvailability: [
        {
          scope: "all_models",
          status: "known",
          effectivePercentRemaining: headroom,
          selection: { status: "known", spendPriority: priority },
        },
      ],
    },
  };
}

/**
 * The depletion vocabulary is one owner: `classify-evidence` and our
 * `classifyEvidence` must agree on both subscription holes and working limits.
 */
describe("selector parity: depletion evidence gate", () => {
  const cases: Array<[string, boolean]> = [
    ["failed: request failed with status code 429", true],
    ["failed: insufficient_quota - add credits to continue", true],
    ["failed: you are out of credits for this billing period", true],
    ["failed: your weekly usage allowance is exhausted", true],
    ["working: context token limit reached; compacting", false],
    ["failed: exceeded the tool output limit", false],
    ["working: applying the hunk at line 429 of the diff", false],
    ["working: max output tokens limit hit; continuing", false],
  ];

  it("agrees with the selector's classify-evidence on every fixture", () => {
    for (const [line, depleted] of cases) {
      const result = spawnSync(process.execPath, [SELECTOR, "classify-evidence"], {
        input: line,
        encoding: "utf8",
      });
      const selectorDepleted = (result.stdout ?? "").startsWith("classification=depleted");
      expect(selectorDepleted, `selector classification for: ${line}`).toBe(depleted);
      expect(Boolean(classifyEvidence(line)), `router classification for: ${line}`).toBe(depleted);
    }
  });
});
