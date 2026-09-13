import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { configDir } from "../src/policy/index.js";
import { readDefaultPolicy } from "../src/policy/index.js";
import type { Policy } from "../src/policy/types.js";

let dir: string;
let savedExitCode: number | undefined;
let savedEnv: Record<string, string | undefined>;

async function run(argv: string[]): Promise<{ output: string; exitCode: number }> {
  process.exitCode = 0;
  let output = "";
  await main({
    argv,
    stdout: {
      write: (chunk: string) => {
        output += chunk;
        return true;
      },
    },
  });
  return { output, exitCode: process.exitCode ?? 0 };
}

function writePolicy(policy: Policy): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(join(configDir(), "policy.json"), JSON.stringify(policy, null, 2));
}

function cloneDefault(): Policy {
  return JSON.parse(JSON.stringify(readDefaultPolicy())) as Policy;
}

function writeJson(name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function usage(options: {
  providers: unknown[];
  machine?: unknown;
  generatedAt?: string;
}): unknown {
  return {
    schemaVersion: 5,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    providers: options.providers,
    ...(options.machine ? { machine: options.machine } : {}),
  };
}

function fresh(name: string, percentRemaining: number, id = "all"): unknown {
  return { provider: name, state: { status: "fresh", stale: false }, windows: [{ id, percentRemaining }] };
}

function opencodeUsage(percentRemaining = 94): unknown {
  return usage({
    providers: [
      {
        provider: "opencode",
        label: "OpenCode",
        source: "openusage",
        state: { status: "fresh", stale: false },
        windows: [
          { id: "session", kind: "session", percentRemaining },
          { id: "weekly", kind: "weekly", percentRemaining: 93 },
          { id: "monthly", kind: "monthly", percentRemaining: 97 },
        ],
        pools: [
          { id: "opencode-go", label: "Go", provider: "opencode", windowIds: ["session", "weekly", "monthly"], percentRemaining, modelCount: 27 },
          { id: "opencode", label: "Zen", provider: "opencode", windowIds: ["session", "weekly", "monthly"], percentRemaining, modelCount: 69 },
        ],
        quotaSemantics: { status: "unknown", description: "no scalar", effectiveAvailability: [] },
      },
    ],
  });
}

beforeEach(() => {
  savedExitCode = process.exitCode;
  savedEnv = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    LLM_ROUTER_STATE_FILE: process.env.LLM_ROUTER_STATE_FILE,
    LLM_ROUTER_USAGE_AXI: process.env.LLM_ROUTER_USAGE_AXI,
  };
  process.exitCode = 0;
  dir = mkdtempSync(join(tmpdir(), "llm-router-axi-router-"));
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.XDG_STATE_HOME = join(dir, "state");
  delete process.env.LLM_ROUTER_STATE_FILE;
  process.env.LLM_ROUTER_USAGE_AXI = join(dir, "missing-usage-axi");
});

afterEach(() => {
  process.exitCode = savedExitCode ?? 0;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("route", () => {
  it("prints exactly the fm-spawn flags and nothing else", async () => {
    const policy = cloneDefault();
    policy.kinds.ship.medium.candidates = [
      { harness: "claude", provider: "claude", model: "sonnet" },
    ];
    writePolicy(policy);
    const usageFile = writeJson("usage.json", usage({ providers: [fresh("claude", 80)] }));

    const { output, exitCode } = await run([
      "route",
      "--kind",
      "ship",
      "--difficulty",
      "medium",
      "--usage-json",
      usageFile,
      "--flags",
    ]);
    expect(exitCode).toBe(0);
    expect(output.trim()).toBe("--harness claude --model sonnet --effort medium");
  });

  it("emits a full decision with fallbacks and capacity", async () => {
    const policy = cloneDefault();
    policy.kinds.ship.medium.candidates = [
      { harness: "claude", provider: "claude", model: "sonnet" },
      { harness: "codex", provider: "codex", model: "gpt" },
    ];
    writePolicy(policy);
    const usageFile = writeJson(
      "usage.json",
      usage({
        providers: [fresh("claude", 80), fresh("codex", 70)],
        machine: { agents: 2, agentCeiling: 10, loadPerCore: 0.5, memoryFreePct: 60, suiteSlotFree: true },
      }),
    );

    const { output, exitCode } = await run([
      "route",
      "--kind",
      "ship",
      "--difficulty",
      "medium",
      "--usage-json",
      usageFile,
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const decision = JSON.parse(output) as {
      harness: string;
      provider: string;
      reason: string;
      fallbacks: Array<{ provider: string }>;
      capacity: { ok: boolean };
    };
    expect(["claude", "codex"]).toContain(decision.harness);
    expect(decision.provider).toBe(decision.harness);
    expect(decision.reason).toContain("headroom");
    expect(decision.fallbacks).toHaveLength(1);
    expect(decision.fallbacks[0]?.provider).not.toBe(decision.provider);
    expect(decision.capacity.ok).toBe(true);
  });

  it("routes OpenCode Go by model prefix", async () => {
    const policy = cloneDefault();
    policy.kinds.ship.medium.candidates = [
      {
        harness: "opencode",
        provider: "opencode",
        pool: "opencode-go",
        model: "opencode-go/deepseek-v4.1-flash",
      },
    ];
    writePolicy(policy);
    const usageFile = writeJson("usage.json", opencodeUsage());

    const { output, exitCode } = await run([
      "route",
      "--kind",
      "ship",
      "--difficulty",
      "medium",
      "--usage-json",
      usageFile,
      "--flags",
    ]);
    expect(exitCode).toBe(0);
    expect(output.trim()).toBe(
      "--harness opencode --model opencode-go/deepseek-v4.1-flash --effort medium",
    );
  });

  it("selects an OpenCode worker from the default doctrine when only opencode is eligible", async () => {
    writePolicy(cloneDefault());
    const usageFile = writeJson("usage.json", opencodeUsage(96));

    const { output, exitCode } = await run([
      "route",
      "--kind",
      "ship",
      "--difficulty",
      "medium",
      "--usage-json",
      usageFile,
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const decision = JSON.parse(output) as { harness: string; provider: string; model: string };
    expect(decision.harness).toBe("opencode");
    expect(decision.provider).toBe("opencode");
    expect(decision.model).toMatch(/^opencode(-go)?\//);
  });

  it("refuses when the fleet is at the agent ceiling", async () => {
    const policy = cloneDefault();
    policy.kinds.ship.medium.candidates = [
      { harness: "claude", provider: "claude", model: "sonnet" },
    ];
    writePolicy(policy);
    const usageFile = writeJson(
      "usage.json",
      usage({
        providers: [fresh("claude", 80)],
        machine: { agents: 10, agentCeiling: 10, loadPerCore: 0.2, memoryFreePct: 80, suiteSlotFree: true },
      }),
    );

    const { output, exitCode } = await run([
      "route",
      "--kind",
      "ship",
      "--difficulty",
      "medium",
      "--usage-json",
      usageFile,
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain("CAPACITY_REFUSED");
    expect(output).toContain("10-agent ceiling");
  });

  it("fails closed when the usage fixture is unreadable", async () => {
    writePolicy(cloneDefault());
    const { output, exitCode } = await run([
      "route",
      "--kind",
      "ship",
      "--difficulty",
      "medium",
      "--usage-json",
      join(dir, "does-not-exist.json"),
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain("quota fixture unreadable");
    expect(output).toContain("NO_ELIGIBLE_CANDIDATE");
  });

  it("refuses a native harness/provider mismatch as a config error", async () => {
    const policy = cloneDefault();
    policy.kinds.ship.medium.candidates = [{ harness: "codex", provider: "claude" }];
    writePolicy(policy);
    const usageFile = writeJson("usage.json", usage({ providers: [fresh("claude", 80)] }));

    const { output, exitCode } = await run([
      "route",
      "--kind",
      "ship",
      "--difficulty",
      "medium",
      "--usage-json",
      usageFile,
    ]);
    expect(exitCode).toBe(2);
    expect(output).toContain("native harness codex requires provider codex");
  });
});

describe("explain", () => {
  it("lists every candidate with a frozen reason", async () => {
    const policy = cloneDefault();
    policy.kinds.ship.medium.candidates = [
      { harness: "claude", provider: "claude" },
      { harness: "codex", provider: "codex" },
    ];
    writePolicy(policy);
    const usageFile = writeJson(
      "usage.json",
      usage({ providers: [fresh("claude", 20), fresh("codex", 75)] }),
    );

    const { output, exitCode } = await run([
      "explain",
      "--kind",
      "ship",
      "--difficulty",
      "medium",
      "--usage-json",
      usageFile,
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const report = JSON.parse(output) as {
      selected: { provider: string } | null;
      candidates: Array<{ provider: string; decision: string; reason: string }>;
    };
    expect(report.selected?.provider).toBe("codex");
    const claude = report.candidates.find((row) => row.provider === "claude");
    expect(claude?.decision).toBe("refused");
    expect(claude?.reason).toContain("quota headroom 20% is at or below 20% reserve");
  });

  it("prints the selected harness/model/provider inline in TOON", async () => {
    const policy = cloneDefault();
    policy.kinds.ship.medium.candidates = [
      { harness: "claude", provider: "claude" },
      { harness: "codex", provider: "codex" },
    ];
    writePolicy(policy);
    const usageFile = writeJson(
      "usage.json",
      usage({ providers: [fresh("claude", 20), fresh("codex", 75)] }),
    );

    const { output, exitCode } = await run([
      "explain",
      "--kind",
      "ship",
      "--difficulty",
      "medium",
      "--usage-json",
      usageFile,
    ]);
    expect(exitCode).toBe(0);
    const line = output.split("\n").find((row) => row.startsWith("selected:"));
    expect(line).toBe("selected: codex/harness-default/codex");
  });

  it("omits the selected line when no candidate is eligible", async () => {
    const policy = cloneDefault();
    policy.kinds.ship.medium.candidates = [{ harness: "claude", provider: "claude" }];
    writePolicy(policy);
    const usageFile = writeJson(
      "usage.json",
      usage({ providers: [fresh("claude", 20)] }),
    );

    const { output, exitCode } = await run([
      "explain",
      "--kind",
      "ship",
      "--difficulty",
      "medium",
      "--usage-json",
      usageFile,
    ]);
    expect(exitCode).toBe(0);
    expect(output.split("\n").some((row) => row.startsWith("selected:"))).toBe(false);
  });
});

describe("record", () => {
  it("persists a cooldown the next route call honours", async () => {
    const policy = cloneDefault();
    policy.kinds.ship.medium.candidates = [
      { harness: "claude", provider: "claude" },
      { harness: "codex", provider: "codex" },
    ];
    writePolicy(policy);
    const usageFile = writeJson(
      "usage.json",
      usage({ providers: [fresh("claude", 80), fresh("codex", 80)] }),
    );

    const record = await run([
      "record",
      "--provider",
      "codex",
      "--outcome",
      "rate_limit",
      "--task",
      "t-42",
      "--now",
      "1000",
      "--json",
    ]);
    expect(record.exitCode).toBe(0);
    const receipt = JSON.parse(record.output) as { cooldownUntil: number; statePath: string };
    expect(receipt.cooldownUntil).toBe(2800);
    expect(receipt.statePath).toContain("llm-router-axi");

    const explain = await run([
      "explain",
      "--kind",
      "ship",
      "--difficulty",
      "medium",
      "--usage-json",
      usageFile,
      "--now",
      "1001",
      "--json",
    ]);
    expect(explain.exitCode).toBe(0);
    const report = JSON.parse(explain.output) as {
      candidates: Array<{ provider: string; reason: string }>;
    };
    const codex = report.candidates.find((row) => row.provider === "codex");
    expect(codex?.reason).toContain(
      "candidate provider=codex unavailable: cooldown until epoch 2800",
    );
  });

  it("clears a cooldown on an ok outcome", async () => {
    const policy = cloneDefault();
    policy.kinds.ship.medium.candidates = [
      { harness: "claude", provider: "claude" },
      { harness: "codex", provider: "codex" },
    ];
    writePolicy(policy);
    const usageFile = writeJson(
      "usage.json",
      usage({ providers: [fresh("claude", 80), fresh("codex", 80)] }),
    );

    await run([
      "record", "--provider", "codex", "--outcome", "rate_limit", "--task", "t-1", "--now", "1000",
    ]);
    const clear = await run([
      "record", "--provider", "codex", "--outcome", "ok", "--task", "t-1", "--now", "1001", "--json",
    ]);
    expect(clear.exitCode).toBe(0);
    expect(JSON.parse(clear.output).cooldownUntil).toBeNull();

    const explain = await run([
      "explain",
      "--kind",
      "ship",
      "--difficulty",
      "medium",
      "--usage-json",
      usageFile,
      "--now",
      "1002",
      "--json",
    ]);
    const report = JSON.parse(explain.output) as {
      candidates: Array<{ provider: string; reason: string }>;
    };
    const codex = report.candidates.find((row) => row.provider === "codex");
    expect(codex?.reason).not.toContain("cooldown until epoch");
  });
});
