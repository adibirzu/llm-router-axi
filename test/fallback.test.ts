import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { planStepDown, resolveFallbacks } from "../src/fallback.js";
import { readDefaultPolicy } from "../src/policy/index.js";
import type { Policy } from "../src/policy/types.js";

function cloneDefault(): Policy {
  return JSON.parse(JSON.stringify(readDefaultPolicy())) as Policy;
}

describe("in-run step-down chain", () => {
  it("steps to the chain head when no model is recorded", () => {
    const step = planStepDown(cloneDefault(), "opencode", undefined);
    expect(step.action).toBe("harness-step");
    expect(step.toModel).toBe("opencode-go/deepseek-v4.1-flash");
    expect(step.fromModel).toBeUndefined();
  });

  it("steps to the entry after the recorded model", () => {
    const step = planStepDown(cloneDefault(), "opencode", "opencode-go/muse-spark-1.3-contributor");
    expect(step).toMatchObject({
      action: "harness-step",
      fromModel: "opencode-go/muse-spark-1.3-contributor",
      toModel: "opencode-go/qwen3.8-flash",
    });
  });

  it("steps a model outside its chain to the chain head", () => {
    const step = planStepDown(cloneDefault(), "claude", "opus-4");
    expect(step).toMatchObject({ action: "harness-step", toModel: "sonnet" });
  });

  it("wraps a cyclic lane from its last entry back to the head", () => {
    const policy = cloneDefault();
    const step = planStepDown(policy, "claude", "haiku");
    expect(policy.modelFallbackCycles).toContain("claude");
    expect(step).toMatchObject({ action: "harness-step", toModel: "sonnet" });
  });

  it("moves to the next fallback lane when a non-cyclic chain is walked out", () => {
    const policy = cloneDefault();
    policy.modelFallbackCycles = [];
    policy.fallbackLanes = ["opencode", "claude"];
    const step = planStepDown(
      policy,
      "opencode",
      "opencode/nemotron-3.5-lightning-free",
    );
    expect(step).toMatchObject({
      action: "lane-move",
      toHarness: "claude",
      toModel: "sonnet",
    });
  });

  it("moves a chainless lane to its successor's chain head", () => {
    const step = planStepDown(cloneDefault(), "grok", undefined);
    expect(step).toMatchObject({ action: "lane-move", toHarness: "cursor", toModel: "auto" });
  });

  it("moves to a chainless successor lane with an empty toModel", () => {
    const policy = cloneDefault();
    policy.modelFallbackCycles = [];
    policy.fallbackLanes = ["opencode", "grok"];
    const step = planStepDown(policy, "opencode", "opencode/nemotron-3.5-lightning-free");
    expect(step).toMatchObject({ action: "lane-move", toHarness: "grok", toModel: "" });
  });

  it("reports exhausted when no chain or lane successor is left", () => {
    const policy = cloneDefault();
    policy.modelFallbackCycles = [];
    policy.fallbackLanes = ["claude"];
    const step = planStepDown(policy, "claude", "haiku");
    expect(step.action).toBe("exhausted");
    expect(step.reason).toContain("no fallbackLanes successor exists");
  });

  it("honors the legacy _model_fallback alias when modelFallback is absent", () => {
    const policy = cloneDefault();
    delete policy.modelFallback;
    (policy as Policy & { _model_fallback: Record<string, string[]> })._model_fallback = {
      claude: ["a", "b"],
    };
    policy.modelFallbackCycles = [];
    policy.fallbackLanes = [];
    expect(resolveFallbacks(policy).modelFallback).toEqual({ claude: ["a", "b"] });
    expect(planStepDown(policy, "claude", "a")).toMatchObject({
      action: "harness-step",
      toModel: "b",
    });
  });
});

describe("route chain command", () => {
  let dir: string;
  let savedExitCode: number | undefined;
  let savedConfigHome: string | undefined;

  async function run(argv: string[]): Promise<{ output: string; exitCode: number }> {
    process.exitCode = 0;
    let output = "";
    await main({
      argv,
      stdout: { write: (chunk: string) => { output += chunk; return true; } },
    });
    return { output, exitCode: process.exitCode ?? 0 };
  }

  beforeEach(() => {
    savedExitCode = process.exitCode;
    savedConfigHome = process.env.XDG_CONFIG_HOME;
    process.exitCode = 0;
    dir = mkdtempSync(join(tmpdir(), "llm-router-chain-"));
    process.env.XDG_CONFIG_HOME = join(dir, "config");
    mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
  });

  afterEach(() => {
    process.exitCode = savedExitCode ?? 0;
    if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedConfigHome;
    rmSync(dir, { recursive: true, force: true });
  });

  function writePolicy(policy: Policy): void {
    mkdirSync(join(process.env.XDG_CONFIG_HOME as string, "llm-router-axi"), { recursive: true });
    writeFileSync(
      join(process.env.XDG_CONFIG_HOME as string, "llm-router-axi", "policy.json"),
      JSON.stringify(policy, null, 2),
    );
  }

  it("prints a harness-step as JSON", async () => {
    writePolicy(cloneDefault());
    const { output, exitCode } = await run([
      "route", "chain", "--harness", "opencode", "--model", "opencode-go/qwen3.8-flash", "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      action: "harness-step",
      toModel: "opencode-go/kimi-k2.7-code",
    });
  });

  it("prints chain help for `route chain --help`", async () => {
    const { output, exitCode } = await run(["route", "chain", "--help"]);
    expect(exitCode).toBe(0);
    expect(output).toContain("fallbackLanes");
    expect(output).toContain("harness-step");
  });

  it("refuses a missing --harness with exit 2", async () => {
    writePolicy(cloneDefault());
    const { output, exitCode } = await run(["route", "chain"]);
    expect(exitCode).toBe(2);
    expect(output).toContain("missing required flag: --harness");
  });
});
