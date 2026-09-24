import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli.js";
import { configDir, readDefaultPolicy } from "../../src/policy/index.js";
import type { Policy } from "../../src/policy/types.js";

const SELECTOR = fileURLToPath(
  new URL("../fixtures/selector/fm-dispatch-select.mjs", import.meta.url),
);

const NOW = 1000;
const STAMP = "1970-01-01T00:16:40.000Z";

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

beforeEach(() => {
  savedExitCode = process.exitCode;
  savedEnv = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    LLM_ROUTER_STATE_FILE: process.env.LLM_ROUTER_STATE_FILE,
    LLM_ROUTER_USAGE_AXI: process.env.LLM_ROUTER_USAGE_AXI,
  };
  process.exitCode = 0;
  dir = mkdtempSync(join(tmpdir(), "llm-router-axi-opencode-divergence-"));
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

/**
 * The quota-axi `opencode-go` row in the fork fixture's own quota shape: the
 * pinned firstmate selector predates the row, so it refuses the identity at
 * its provider gate while the router's policy pool mapping selects it. This
 * is the intended dispatch-surface divergence the quota program is built on:
 * the fork never learns pool-aware opencode pricing; the router owns it.
 */
function opencodeGoQuota(): unknown {
  return {
    schemaVersion: 5,
    generatedAt: STAMP,
    providers: [
      {
        provider: "opencode-go",
        state: { status: "fresh", stale: false },
        windows: [
          { id: "rolling", percentRemaining: 89 },
          { id: "weekly", percentRemaining: 51 },
          { id: "monthly", percentRemaining: 4 },
        ],
        quotaSemantics: {
          status: "unknown",
          effectiveAvailability: [],
          unresolvedWindowIds: ["rolling", "weekly", "monthly"],
        },
      },
    ],
  };
}

function runForkSelector(quota: unknown, profiles: unknown): { code: number; stderr: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "llm-router-axi-fork-")));
  try {
    mkdirSync(join(home, "state"), { recursive: true });
    mkdirSync(join(home, "config"), { recursive: true });
    const quotaFile = join(home, "quota.json");
    writeFileSync(quotaFile, JSON.stringify(quota));
    const stateFile = join(home, "state", "selector-state.json");
    const result = spawnSync(
      process.execPath,
      [SELECTOR, "select", "--quota-json", quotaFile, "--now", String(NOW), JSON.stringify(profiles)],
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
    return { code: result.status ?? 1, stderr: result.stderr ?? "" };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("parity: opencode-go divergence from the pinned fork selector", () => {
  it("the fork refuses the opencode identity its provider set predates", () => {
    const quota = opencodeGoQuota();
    for (const provider of ["opencode-go", "opencode"]) {
      const fork = runForkSelector(quota, [
        { harness: "opencode", provider, model: "opencode-go/qwen3.8-flash" },
      ]);
      expect(fork.code).toBe(2);
      expect(fork.stderr).toContain(
        "provider identity is unresolved or unsupported for harness opencode",
      );
    }
  });

  it("the router selects the same telemetry through its pool mapping", async () => {
    writePolicy(cloneDefault());
    const usageFile = join(dir, "usage.json");
    writeFileSync(usageFile, JSON.stringify(opencodeGoQuota()));

    const { output, exitCode } = await run([
      "route",
      "--kind",
      "ship",
      "--difficulty",
      "medium",
      "--usage-json",
      usageFile,
      "--now",
      String(NOW),
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const decision = JSON.parse(output) as { provider: string; reason: string };
    expect(decision.provider).toBe("opencode-go");
    expect(decision.reason).toContain("headroom=51%");
  });
});
