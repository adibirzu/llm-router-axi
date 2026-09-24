import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    stdout: { write: (chunk: string) => { output += chunk; return true; } },
  });
  return { output, exitCode: process.exitCode ?? 0 };
}

function writePolicy(): void {
  const policy = JSON.parse(JSON.stringify(readDefaultPolicy())) as Policy;
  policy.candidateGroups.workers = [
    { harness: "opencode", provider: "opencode", pool: "opencode-go", model: "opencode-go/deepseek-v4.1-flash" },
    { harness: "codex", provider: "codex", model: "gpt-5.6" },
  ];
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(join(configDir(), "policy.json"), JSON.stringify(policy));
}

function usageFile(providers: unknown[]): string {
  const path = join(dir, "usage.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: 5,
    generatedAt: "1970-01-01T00:16:40.000Z",
    providers,
  }));
  return path;
}

function provider(name: string, remaining: number, status = "fresh"): unknown {
  return {
    provider: name,
    state: { status, stale: false, ...(status === "fresh" ? {} : { error: "runtime probe failed" }) },
    windows: name === "opencode-go"
      ? [
          { id: "rolling", percentRemaining: remaining },
          { id: "weekly", percentRemaining: remaining },
        ]
      : [{ id: "all", percentRemaining: remaining }],
  };
}

beforeEach(() => {
  savedExitCode = process.exitCode;
  savedEnv = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    LLM_ROUTER_STATE_FILE: process.env.LLM_ROUTER_STATE_FILE,
    LLM_ROUTER_OVERRIDE_LOG: process.env.LLM_ROUTER_OVERRIDE_LOG,
  };
  dir = mkdtempSync(join(tmpdir(), "llm-router-check-"));
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.XDG_STATE_HOME = join(dir, "state");
  process.env.LLM_ROUTER_STATE_FILE = join(dir, "state", "dispatch.json");
  process.env.LLM_ROUTER_OVERRIDE_LOG = join(dir, "state", "override-audit.jsonl");
  writePolicy();
});

afterEach(() => {
  process.exitCode = savedExitCode ?? 0;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("check override gate", () => {
  it("allows a healthy explicit override", async () => {
    const usage = usageFile([provider("opencode-go", 80), provider("codex", 75)]);
    const result = await run([
      "check", "--harness", "opencode", "--model", "opencode-go/deepseek-v4.1-flash",
      "--usage-json", usage, "--now", "1000", "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      allowed: true,
      forced: false,
      requested: { harness: "opencode", model: "opencode-go/deepseek-v4.1-flash", provider: "opencode-go" },
    });
  });

  it("refuses exhausted headroom with the exact selector reason and next eligible candidate", async () => {
    const usage = usageFile([provider("opencode-go", 0), provider("codex", 75)]);
    const result = await run([
      "check", "--harness", "opencode", "--model", "opencode-go/deepseek-v4.1-flash",
      "--usage-json", usage, "--now", "1000", "--json",
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      code: "OVERRIDE_REFUSED",
      reason: "window rolling headroom 0% is at or below 20% reserve",
      next: { harness: "codex", model: "gpt-5.6", provider: "codex" },
    });
  });

  it("refuses an active cooldown and a known-failing runtime", async () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(process.env.LLM_ROUTER_STATE_FILE as string, JSON.stringify({
      version: 1,
      sequence: 0,
      lastSelected: {},
      profileLastSelected: {},
      cooldowns: { "opencode-go": { until: 2000, reason: "verified", recordedAt: 900 } },
    }));
    const usage = usageFile([provider("opencode-go", 80), provider("codex", 75)]);
    const cooled = await run([
      "check", "--harness", "opencode", "--model", "opencode-go/deepseek-v4.1-flash",
      "--usage-json", usage, "--now", "1000", "--json",
    ]);
    expect(JSON.parse(cooled.output).reason).toBe("candidate provider=opencode-go unavailable: cooldown until epoch 2000");

    writeFileSync(process.env.LLM_ROUTER_STATE_FILE as string, JSON.stringify({
      version: 1, sequence: 0, lastSelected: {}, profileLastSelected: {}, cooldowns: {},
    }));
    const failedUsage = usageFile([provider("opencode-go", 80, "error"), provider("codex", 75)]);
    const failed = await run([
      "check", "--harness", "opencode", "--model", "opencode-go/deepseek-v4.1-flash",
      "--usage-json", failedUsage, "--now", "1000", "--json",
    ]);
    expect(JSON.parse(failed.output).reason).toBe("provider telemetry not fresh");
  });

  it("force-overrides a refusal and appends an audit record", async () => {
    const usage = usageFile([provider("opencode-go", 0), provider("codex", 75)]);
    const result = await run([
      "check", "--harness", "opencode", "--model", "opencode-go/deepseek-v4.1-flash",
      "--usage-json", usage, "--now", "1000", "--force-override", "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ allowed: true, forced: true });
    const rows = readFileSync(process.env.LLM_ROUTER_OVERRIDE_LOG as string, "utf8").trim().split("\n");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0] as string)).toMatchObject({
      v: 1,
      at: 1000,
      harness: "opencode",
      model: "opencode-go/deepseek-v4.1-flash",
      reason: "window rolling headroom 0% is at or below 20% reserve",
    });
  });

  it("does not audit a force-override when the override was healthy", async () => {
    const usage = usageFile([provider("opencode-go", 80), provider("codex", 75)]);
    const result = await run([
      "check", "--harness", "opencode", "--model", "opencode-go/deepseek-v4.1-flash",
      "--usage-json", usage, "--now", "1000", "--force-override", "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ allowed: true, forced: true });
    expect(existsSync(process.env.LLM_ROUTER_OVERRIDE_LOG as string)).toBe(false);
  });

  it("suggests no next candidate when machine capacity alone refuses", async () => {
    const machine = join(dir, "machine.json");
    const healthy = JSON.parse(readFileSync(process.env.LLM_ROUTER_MACHINE_JSON as string, "utf8")) as Record<string, unknown>;
    writeFileSync(machine, JSON.stringify({ ...healthy, agents: 999 }));
    const savedMachine = process.env.LLM_ROUTER_MACHINE_JSON;
    process.env.LLM_ROUTER_MACHINE_JSON = machine;
    try {
      const usage = usageFile([provider("opencode-go", 80), provider("codex", 75)]);
      const args = [
        "check", "--harness", "opencode", "--model", "opencode-go/deepseek-v4.1-flash",
        "--usage-json", usage, "--now", "1000", "--json",
      ];
      const refused = await run(args);
      expect(refused.exitCode).toBe(1);
      expect(JSON.parse(refused.output)).toMatchObject({ code: "OVERRIDE_REFUSED", next: null });

      const forced = await run([...args, "--force-override"]);
      expect(forced.exitCode).toBe(0);
      expect(JSON.parse(forced.output)).toMatchObject({ allowed: true, forced: true, next: null });
      expect(readFileSync(process.env.LLM_ROUTER_OVERRIDE_LOG as string, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      process.env.LLM_ROUTER_MACHINE_JSON = savedMachine;
    }
  });

  it("does not change ordinary route output", async () => {
    const usage = usageFile([provider("opencode-go", 80), provider("codex", 75)]);
    const routed = await run([
      "route", "--kind", "ship", "--difficulty", "medium",
      "--usage-json", usage, "--now", "1000", "--flags",
    ]);
    expect(routed).toEqual({
      exitCode: 0,
      output: "--harness opencode --model opencode-go/deepseek-v4.1-flash --effort medium\n",
    });
  });
});
