import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { configDir, readDefaultPolicy } from "../src/policy/index.js";
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

/**
 * The live quota-axi shape (adi1 2026-09-23): the paid subscription is the
 * only opencode telemetry, published as provider `opencode-go` — fresh, with
 * populated raw windows but unknown joint semantics and no pools[].
 */
function opencodeGoUsage(): unknown {
  return {
    schemaVersion: 5,
    generatedAt: new Date().toISOString(),
    providers: [
      {
        provider: "opencode-go",
        label: "OpenCode Go",
        source: "quota-axi",
        plan: "OpenCode Go",
        state: { status: "fresh", stale: false },
        windows: [
          { id: "rolling", label: "rolling", kind: "unknown", percentRemaining: 89 },
          { id: "weekly", label: "weekly", kind: "weekly", percentRemaining: 51 },
          { id: "monthly", label: "monthly", kind: "monthly", percentRemaining: 4 },
        ],
        quotaSemantics: {
          status: "unknown",
          description: "no joint binding evidence",
          effectiveAvailability: [],
          unresolvedWindowIds: ["rolling", "weekly", "monthly"],
        },
      },
    ],
  };
}

/** The legacy OpenUsage shape: one `opencode` row with pools[]. */
function legacyOpencodeUsage(): unknown {
  return {
    schemaVersion: 5,
    generatedAt: new Date().toISOString(),
    providers: [
      {
        provider: "opencode",
        label: "OpenCode",
        source: "openusage",
        state: { status: "fresh", stale: false },
        windows: [
          { id: "session", kind: "session", percentRemaining: 90 },
          { id: "weekly", kind: "weekly", percentRemaining: 76 },
          { id: "monthly", kind: "monthly", percentRemaining: 97 },
        ],
        pools: [
          { id: "opencode-go", label: "Go", provider: "opencode", windowIds: ["session", "weekly", "monthly"], percentRemaining: 76, modelCount: 27 },
          { id: "opencode", label: "Zen", provider: "opencode", windowIds: ["session", "weekly", "monthly"], percentRemaining: 76, modelCount: 69 },
        ],
        quotaSemantics: { status: "unknown", description: "no scalar", effectiveAvailability: [] },
      },
    ],
  };
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
  dir = mkdtempSync(join(tmpdir(), "llm-router-axi-opencode-go-"));
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

describe("opencode-go telemetry identity", () => {
  it("routes the paid Go pool on the opencode-go row with its real headroom", async () => {
    writePolicy(cloneDefault());
    const usageFile = writeJson("usage.json", opencodeGoUsage());

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
      pool?: string;
      model?: string;
      reason: string;
    };
    expect(decision.harness).toBe("opencode");
    expect(decision.provider).toBe("opencode-go");
    expect(decision.pool).toBe("opencode-go");
    expect(decision.model).toBe("opencode-go/deepseek-v4.1-flash");
    // The doctrine scopes the Go pool to its allowance windows, so the
    // tightest scoped window (weekly) prices the lane — never the
    // telemetry-unavailable refusal, and never the unscoped monthly meter.
    expect(decision.reason).toContain("headroom=51%");
  });

  it("explains Go lanes eligible and free lanes telemetry-unavailable", async () => {
    writePolicy(cloneDefault());
    const usageFile = writeJson("usage.json", opencodeGoUsage());

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
      candidates: Array<{ provider: string; pool: string; decision: string; reason: string }>;
    };
    expect(report.selected?.provider).toBe("opencode-go");
    const go = report.candidates.filter((row) => row.pool === "opencode-go");
    expect(go.length).toBeGreaterThan(0);
    expect(go.every((row) => row.decision === "eligible")).toBe(true);
    const free = report.candidates.filter((row) => row.pool === "opencode");
    expect(free.length).toBeGreaterThan(0);
    for (const row of free) {
      expect(row.decision).toBe("refused");
      // Byte-identical frozen string: no free telemetry row exists.
      expect(row.reason).toBe(
        "candidate provider=opencode unavailable: provider telemetry unavailable",
      );
    }
  });

  it("fails closed on every live window when the doctrine has no goWindows scope", async () => {
    const policy = cloneDefault();
    delete policy.pools.opencode.goWindows;
    writePolicy(policy);
    const usageFile = writeJson("usage.json", opencodeGoUsage());

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
    expect(output).toContain("NO_ELIGIBLE_CANDIDATE");
    expect(output).toContain("window monthly headroom 4% is at or below 20% reserve");
  });

  it("falls back to the legacy opencode row when no opencode-go row is live", async () => {
    writePolicy(cloneDefault());
    const usageFile = writeJson("usage.json", legacyOpencodeUsage());

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
      pool?: string;
      model?: string;
      reason: string;
    };
    expect(decision.harness).toBe("opencode");
    // The legacy identity is preserved byte-identically: provider `opencode`
    // priced on the row's own pool windows.
    expect(decision.provider).toBe("opencode");
    expect(decision.pool).toBe("opencode-go");
    expect(decision.model).toBe("opencode-go/deepseek-v4.1-flash");
    expect(decision.reason).toContain("headroom=76%");
  });

  it("refuses byte-identically when neither opencode row is live", async () => {
    writePolicy(cloneDefault());
    const usageFile = writeJson("usage.json", {
      schemaVersion: 5,
      generatedAt: new Date().toISOString(),
      providers: [],
    });

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
    expect(output).toContain("NO_ELIGIBLE_CANDIDATE");
    expect(output).toContain(
      "candidate provider=opencode-go unavailable: provider telemetry unavailable",
    );
  });
});
