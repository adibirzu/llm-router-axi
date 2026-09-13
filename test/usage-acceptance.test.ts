import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { configDir, readDefaultPolicy } from "../src/policy/index.js";
import type { Candidate, Policy } from "../src/policy/types.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/usage/", import.meta.url));

let dir: string;
let savedExitCode: number | undefined;
let savedEnv: Record<string, string | undefined>;

async function run(argv: string[]): Promise<{ output: string; exitCode: number }> {
  process.exitCode = 0;
  let output = "";
  await main({ argv, stdout: { write: (chunk: string) => { output += chunk; return true; } } });
  return { output, exitCode: process.exitCode ?? 0 };
}

function writePolicy(policy: Policy): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(join(configDir(), "policy.json"), JSON.stringify(policy, null, 2));
}

function cloneDefault(): Policy {
  return JSON.parse(JSON.stringify(readDefaultPolicy())) as Policy;
}

function onlyShipCandidate(policy: Policy, candidate: Candidate): void {
  policy.kinds.ship.medium.candidates = [candidate];
}

beforeEach(() => {
  savedExitCode = process.exitCode;
  savedEnv = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    LLM_ROUTER_USAGE_AXI: process.env.LLM_ROUTER_USAGE_AXI,
  };
  process.exitCode = 0;
  dir = mkdtempSync(join(tmpdir(), "llm-router-usage-"));
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.XDG_STATE_HOME = join(dir, "state");
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

function fixture(name: string): string {
  return join(FIXTURES, name);
}

describe("usage-axi acceptance (U1, U4-U9)", () => {
  it("U1: routes from a minimal two-provider document", async () => {
    writePolicy(cloneDefault());
    const { output, exitCode } = await run([
      "route", "--kind", "ship", "--difficulty", "medium",
      "--usage-json", fixture("selector-minimal.quota.json"), "--now", "1000", "--json",
    ]);
    expect(exitCode).toBe(0);
    const decision = JSON.parse(output) as { provider: string };
    expect(decision.provider.length).toBeGreaterThan(0);
  });

  it("U4/U5/U6: cursor split pools price the declared window only", async () => {
    const undeclared = cloneDefault();
    onlyShipCandidate(undeclared, { harness: "cursor", provider: "cursor", model: "cursor-grok-4.6-high" });
    writePolicy(undeclared);
    const wide = await run([
      "route", "--kind", "ship", "--difficulty", "medium",
      "--usage-json", fixture("cursor-split-pools.quota.json"), "--now", "1000",
    ]);
    expect(wide.exitCode).toBe(1);
    expect(wide.output).toContain("quota headroom 0% is at or below 20% reserve");

    const declared = cloneDefault();
    onlyShipCandidate(declared, {
      harness: "cursor", provider: "cursor", model: "cursor-grok-4.6-high", pool: "auto_usage",
    });
    writePolicy(declared);
    const auto = await run([
      "route", "--kind", "ship", "--difficulty", "medium",
      "--usage-json", fixture("cursor-split-pools.quota.json"), "--now", "1000", "--json",
    ]);
    expect(auto.exitCode).toBe(0);
    expect((JSON.parse(auto.output) as { reason: string }).reason).toContain("window auto_usage");

    const api = cloneDefault();
    onlyShipCandidate(api, { harness: "cursor", provider: "cursor", pool: "api_usage" });
    writePolicy(api);
    const spent = await run([
      "route", "--kind", "ship", "--difficulty", "medium",
      "--usage-json", fixture("cursor-split-pools.quota.json"), "--now", "1000",
    ]);
    expect(spent.exitCode).toBe(1);
    expect(spent.output).toContain("window api_usage headroom 0% is at or below 20% reserve");
  });

  it("U7: parses a schemaVersion 5 quota-axi document without calling it malformed", async () => {
    writePolicy(cloneDefault());
    const { output, exitCode } = await run([
      "explain", "--kind", "review", "--difficulty", "hard",
      "--usage-json", fixture("quota-axi.adi1.json"), "--now", "1780000000", "--json",
    ]);
    expect(exitCode).toBe(0);
    const report = JSON.parse(output) as { candidates: Array<{ reason: string }> };
    expect(output).not.toContain("malformed");
    expect(report.candidates.length).toBeGreaterThan(0);
  });

  it("U8: prices OpenUsage-mapped cursor auto (~99%), not quota-axi api (0%)", async () => {
    const mapped = {
      generatedAt: "1970-01-01T00:16:40.000Z",
      schemaVersion: 5,
      providers: [
        {
          provider: "cursor",
          label: "Cursor",
          source: "openusage",
          state: { status: "fresh", stale: false },
          windows: [
            { id: "auto_usage", kind: "monthly", percentRemaining: 99.16 },
            { id: "api_usage", kind: "monthly", percentRemaining: 0 },
          ],
          quotaSemantics: { status: "unknown", description: "mapped", effectiveAvailability: [] },
        },
      ],
      machine: { agents: 1, agentCeiling: 10, loadPerCore: 0.2, memoryFreePct: 70, suiteSlotFree: true },
    };
    const path = join(dir, "mapped.json");
    writeFileSync(path, JSON.stringify(mapped));

    const policy = cloneDefault();
    onlyShipCandidate(policy, { harness: "cursor", provider: "cursor", model: "cursor-grok-4.6-high", pool: "auto_usage" });
    writePolicy(policy);
    const { output, exitCode } = await run([
      "route", "--kind", "ship", "--difficulty", "medium",
      "--usage-json", path, "--now", "1000", "--json",
    ]);
    expect(exitCode).toBe(0);
    expect((JSON.parse(output) as { reason: string }).reason).toContain("headroom=99.16%");
  });

  it("U9: tolerates additive machine{}, pools[], source, and label keys", async () => {
    const additive = {
      generatedAt: "1970-01-01T00:16:40.000Z",
      schemaVersion: 5,
      providers: [
        {
          provider: "claude",
          label: "Claude",
          plan: "Max 20x",
          source: "openusage",
          state: { status: "fresh", stale: false, refreshedAt: "1970-01-01T00:16:40.000Z" },
          windows: [{ id: "five_hour", kind: "session", percentRemaining: 88 }],
          pools: [{ id: "default", windowIds: ["five_hour"], percentRemaining: 88, modelCount: 3 }],
          quotaSemantics: { status: "unknown", description: "none", effectiveAvailability: [] },
        },
      ],
      machine: { agents: 1, agentCeiling: 10, loadPerCore: 0.2, memoryFreePct: 70, suiteSlotFree: true },
    };
    const path = join(dir, "additive.json");
    writeFileSync(path, JSON.stringify(additive));
    const policy = cloneDefault();
    onlyShipCandidate(policy, { harness: "claude", provider: "claude", model: "sonnet" });
    writePolicy(policy);
    const { exitCode } = await run([
      "route", "--kind", "ship", "--difficulty", "medium",
      "--usage-json", path, "--now", "1000", "--json",
    ]);
    expect(exitCode).toBe(0);
  });
});
