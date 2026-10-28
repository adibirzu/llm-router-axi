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

async function runWithStderr(
  argv: string[],
): Promise<{ output: string; stderr: string; exitCode: number }> {
  process.exitCode = 0;
  let output = "";
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    await main({
      argv,
      stdout: {
        write: (chunk: string) => {
          output += chunk;
          return true;
        },
      },
    });
  } finally {
    process.stderr.write = original;
  }
  return { output, stderr, exitCode: process.exitCode ?? 0 };
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

  const spellings = ["opencode", "opencode-go"];
  for (const [recorded, cleared] of spellings.flatMap((a) => spellings.map((b) => [a, b] as const))) {
    it(`gates the Go lanes after a rate_limit recorded for ${recorded}, and ok for ${cleared} clears it`, async () => {
      writePolicy(cloneDefault());
      const usageFile = writeJson("usage.json", opencodeGoUsage());
      const routeArgs = ["route", "--kind", "ship", "--difficulty", "medium", "--usage-json", usageFile, "--json"];

      const before = await run(routeArgs);
      expect(before.exitCode).toBe(0);
      expect((JSON.parse(before.output) as { provider: string }).provider).toBe("opencode-go");

      const rate = await run([
        "record", "--provider", recorded, "--outcome", "rate_limit", "--task", "t-1", "--json",
      ]);
      expect(rate.exitCode).toBe(0);

      const gated = await run(routeArgs);
      expect(gated.exitCode).toBe(1);
      expect(gated.output).toContain("NO_ELIGIBLE_CANDIDATE");
      expect(gated.output).toMatch(/candidate provider=opencode-go unavailable: cooldown until epoch/);

      const ok = await run([
        "record", "--provider", cleared, "--outcome", "ok", "--task", "t-1", "--json",
      ]);
      expect(ok.exitCode).toBe(0);

      const after = await run(routeArgs);
      expect(after.exitCode).toBe(0);
      expect((JSON.parse(after.output) as { provider: string }).provider).toBe("opencode-go");
    });
  }

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

  it("routes and checks a policy candidate declared with the live Go identity", async () => {
    const policy = cloneDefault();
    policy.candidateGroups.workers = [{
      harness: "opencode",
      provider: "opencode-go",
      pool: "opencode-go",
      model: "opencode-go/deepseek-v4.1-flash",
    }];
    writePolicy(policy);
    const usageFile = writeJson("usage.json", opencodeGoUsage());

    const routed = await run([
      "route", "--kind", "ship", "--difficulty", "medium", "--usage-json", usageFile, "--json",
    ]);
    expect(routed.exitCode).toBe(0);
    expect(JSON.parse(routed.output)).toMatchObject({ provider: "opencode-go" });

    const checked = await run([
      "check", "--harness", "opencode", "--model", "opencode-go/deepseek-v4.1-flash",
      "--usage-json", usageFile, "--json",
    ]);
    expect(checked.exitCode).toBe(0);
    expect(JSON.parse(checked.output)).toMatchObject({
      allowed: true,
      requested: { provider: "opencode-go" },
    });
  });

  for (const pool of ["opencode", "opencode-go"]) {
    it(`refuses a free model declared with Go telemetry and ${pool} pool`, async () => {
      const policy = cloneDefault();
      policy.candidateGroups.workers = [{
        harness: "opencode",
        provider: "opencode-go",
        pool,
        model: "opencode/big-pickle",
      }];
      writePolicy(policy);
      const usageFile = writeJson("usage.json", opencodeGoUsage());

      const routed = await run([
        "route", "--kind", "ship", "--difficulty", "medium", "--usage-json", usageFile,
      ]);
      expect(routed.exitCode).toBe(2);
      expect(routed.output).toContain("provider opencode-go requires OpenCode Go pool");

      const checked = await run([
        "check", "--harness", "opencode", "--model", "opencode/big-pickle",
        "--usage-json", usageFile,
      ]);
      expect(checked.exitCode).toBe(2);
      expect(checked.output).toContain("provider opencode-go requires OpenCode Go pool");
    });
  }

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

describe("select: opencode dispatch-profile provider identity", () => {
  it("selects the Go lane on the live opencode-go row with its declared window", async () => {
    writePolicy(cloneDefault());
    const usageFile = writeJson("usage.json", opencodeGoUsage());

    const { output, exitCode } = await run([
      "select",
      "--quota-json",
      usageFile,
      '[{"harness":"opencode","provider":"opencode-go","model":"opencode-go/muse-spark-1.3-contributor","quotaWindow":"weekly"}]',
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toEqual({
      harness: "opencode",
      provider: "opencode-go",
      model: "opencode-go/muse-spark-1.3-contributor",
    });
  });

  it("accepts both native spellings side by side and keeps the Go row first", async () => {
    writePolicy(cloneDefault());
    const usageFile = writeJson("usage.json", opencodeGoUsage());

    const { stderr, exitCode } = await runWithStderr([
      "select",
      "--quota-json",
      usageFile,
      '[{"harness":"opencode","provider":"opencode","quotaWindow":"weekly"},{"harness":"opencode","provider":"opencode-go","model":"opencode-go/muse-spark-1.3-contributor","quotaWindow":"weekly"}]',
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });

  it("refuses the legacy opencode identity with the frozen telemetry string on Go-only telemetry", async () => {
    writePolicy(cloneDefault());
    const usageFile = writeJson("usage.json", opencodeGoUsage());

    const { stderr, exitCode } = await runWithStderr([
      "select",
      "--quota-json",
      usageFile,
      '[{"harness":"opencode","provider":"opencode","quotaWindow":"weekly"}]',
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain(
      "candidate provider=opencode unavailable: provider telemetry unavailable",
    );
  });

  it("fails closed provider-wide when the Go profile declares no window", async () => {
    writePolicy(cloneDefault());
    const usageFile = writeJson("usage.json", opencodeGoUsage());

    const { stderr, exitCode } = await runWithStderr([
      "select",
      "--quota-json",
      usageFile,
      '[{"harness":"opencode","provider":"opencode-go","model":"opencode-go/muse-spark-1.3-contributor"}]',
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain(
      "candidate provider=opencode-go unavailable: quota headroom 4% is at or below 20% reserve",
    );
  });

  it("refuses a non-native provider for the opencode harness with exit 2", async () => {
    writePolicy(cloneDefault());
    const usageFile = writeJson("usage.json", opencodeGoUsage());

    const { output, exitCode } = await run([
      "select",
      "--quota-json",
      usageFile,
      '[{"harness":"opencode","provider":"bogus"}]',
    ]);
    expect(exitCode).toBe(2);
    expect(output).toContain("native harness opencode requires provider opencode");
  });

  it("refuses a free model declared with Go telemetry", async () => {
    writePolicy(cloneDefault());
    const usageFile = writeJson("usage.json", opencodeGoUsage());

    const { output, exitCode } = await run([
      "select",
      "--quota-json",
      usageFile,
      '[{"harness":"opencode","provider":"opencode-go","model":"opencode/big-pickle","quotaWindow":"weekly"}]',
    ]);
    expect(exitCode).toBe(2);
    expect(output).toContain("provider opencode-go requires OpenCode Go pool");
  });
});
