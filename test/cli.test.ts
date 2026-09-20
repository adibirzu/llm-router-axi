import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";

let dir: string;
let savedExitCode: number | undefined;
let savedConfigHome: string | undefined;
let savedStateHome: string | undefined;

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

beforeEach(() => {
  savedExitCode = process.exitCode;
  savedConfigHome = process.env.XDG_CONFIG_HOME;
  savedStateHome = process.env.XDG_STATE_HOME;
  process.exitCode = 0;
  dir = mkdtempSync(join(tmpdir(), "llm-router-axi-test-"));
  process.env.XDG_CONFIG_HOME = dir;
  process.env.XDG_STATE_HOME = join(dir, "state");
  process.env.LLM_ROUTER_USAGE_AXI = join(dir, "missing-usage-axi");
});

afterEach(() => {
  process.exitCode = savedExitCode ?? 0;
  if (savedConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = savedConfigHome;
  }
  if (savedStateHome === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = savedStateHome;
  }
  delete process.env.LLM_ROUTER_USAGE_AXI;
  rmSync(dir, { recursive: true, force: true });
});

describe("policy lifecycle", () => {
  it("validates the built-in default when no file exists", async () => {
    const { output, exitCode } = await run(["policy", "validate"]);
    expect(exitCode).toBe(0);
    expect(output).toContain("valid: true");
    expect(output).toContain("source: built-in default");
  });

  it("writes the default on init and is idempotent on the second run", async () => {
    const first = await run(["policy", "init"]);
    expect(first.exitCode).toBe(0);
    const path = join(dir, "llm-router-axi", "policy.json");
    expect(readFileSync(path, "utf8")).toContain('"reservePercent": 20');

    const second = await run(["policy", "init"]);
    expect(second.exitCode).toBe(0);
    expect(second.output).toContain("no-op");
  });

  it("shows the effective policy as JSON", async () => {
    const { output, exitCode } = await run(["policy", "show", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as { version: number; routing: { reservePercent: number } };
    expect(parsed.version).toBe(1);
    expect(parsed.routing.reservePercent).toBe(20);
  });

  it("refuses a malformed policy file with exit 2", async () => {
    const bad = join(dir, "bad-policy.json");
    writeFileSync(
      bad,
      JSON.stringify({ version: 1, routing: { reservePercent: 150 }, bogus: true }),
    );
    const { output, exitCode } = await run(["policy", "validate", "--file", bad]);
    expect(exitCode).toBe(2);
    expect(output).toContain("VALIDATION_ERROR");
    expect(output).toContain("/routing/reservePercent");
  });

  it("rejects an unknown policy subcommand with exit 2", async () => {
    const { output, exitCode } = await run(["policy", "frobnicate"]);
    expect(exitCode).toBe(2);
    expect(output).toContain("unknown policy subcommand");
  });
});

describe("route/explain/record contract stubs", () => {
  it("exits 2 on an unknown route flag and lists the valid flags", async () => {
    const { output, exitCode } = await run(["route", "--bogus"]);
    expect(exitCode).toBe(2);
    expect(output).toContain("unknown flag --bogus");
    expect(output).toContain("--kind");
  });

  it("exits 2 on an invalid enum value", async () => {
    const { output, exitCode } = await run(["route", "--kind", "nope"]);
    expect(exitCode).toBe(2);
    expect(output).toContain("invalid value for --kind");
  });

  it("requires --kind and --difficulty on route", async () => {
    const missing = await run(["route", "--kind", "ship"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.output).toContain("--difficulty");
  });

  it("refuses a usable route call when no usage telemetry is available", async () => {
    const { output, exitCode } = await run([
      "route",
      "--kind",
      "ship",
      "--difficulty",
      "medium",
      "--surface",
      "backend",
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain("NO_ELIGIBLE_CANDIDATE");
  });

  it("accepts --flags for route but not for explain", async () => {
    const explain = await run(["explain", "--flags"]);
    expect(explain.exitCode).toBe(2);
    expect(explain.output).toContain("unknown flag --flags");
  });

  it("requires provider, outcome, and task on record", async () => {
    const { output, exitCode } = await run(["record", "--provider", "cursor"]);
    expect(exitCode).toBe(2);
    expect(output).toContain("--outcome");
    expect(output).toContain("--task");
  });

  it("persists a cooldown receipt for a valid record call", async () => {
    const { output, exitCode } = await run([
      "record",
      "--provider",
      "cursor",
      "--outcome",
      "rate_limit",
      "--task",
      "t-42",
    ]);
    expect(exitCode).toBe(0);
    expect(output).toContain("cooldownUntil");
    expect(output).toContain("t-42");
  });

  it("prints the route contract on --help without erroring", async () => {
    const { output, exitCode } = await run(["route", "--help"]);
    expect(exitCode).toBe(0);
    expect(output).toContain("fallbacks[]");
    expect(output).toContain("--usage-json");
  });
});

describe("top-level surface", () => {
  it("prints the version", async () => {
    const { output, exitCode } = await run(["--version"]);
    expect(exitCode).toBe(0);
    expect(output.trim()).toBe("0.1.0");
  });

  it("prints top-level help", async () => {
    const { output, exitCode } = await run(["--help"]);
    expect(exitCode).toBe(0);
    expect(output).toContain("llm-router-axi");
    expect(output).toContain("route");
  });

  it("exits 2 on an unknown command", async () => {
    const { output, exitCode } = await run(["frobnicate"]);
    expect(exitCode).toBe(2);
    expect(output).toContain("Unknown command");
  });

  it("shows the policy on the content-first home view", async () => {
    const { output, exitCode } = await run([]);
    expect(exitCode).toBe(0);
    expect(output).toContain("reservePercent");
    expect(output).toContain("agentCeiling");
  });

  it("lists the select, chain, capacity, and classify surfaces in help", async () => {
    const { output, exitCode } = await run(["--help"]);
    expect(exitCode).toBe(0);
    expect(output).toContain("select");
    expect(output).toContain("capacity");
    expect(output).toContain("route chain");

    const selectHelp = await run(["select", "--help"]);
    expect(selectHelp.output).toContain("--quota-json");
    expect(selectHelp.output).toContain("quotaWindow");

    const capacityHelp = await run(["capacity", "--help"]);
    expect(capacityHelp.output).toContain("memory pressure");
    expect(capacityHelp.output).toContain("--for <spawn|suite|local-llm>");
    expect(capacityHelp.output).toContain("suite");
    expect(capacityHelp.output).toContain("local-llm");

    const chainHelp = await run(["route", "chain", "--help"]);
    expect(chainHelp.output).toContain("fallbackLanes");
  });

  it("classifies depletion evidence from a file", async () => {
    const file = join(dir, "status");
    writeFileSync(file, "failed: request failed with status code 429\n");
    const depleted = await run(["classify-evidence", "--file", file]);
    expect(depleted.exitCode).toBe(0);
    expect(depleted.output).toContain("classification=depleted");

    writeFileSync(file, "working: context token limit reached\n");
    const benign = await run(["classify-evidence", "--file", file]);
    expect(benign.output).toContain("classification=none");
  });
});

describe("capacity admission purpose", () => {
  let savedMachine: string | undefined;

  function machineFixture(suiteSlotFree: boolean): string {
    const path = join(dir, `machine-${suiteSlotFree ? "free" : "occupied"}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        agents: 1,
        loadPerCore: 0.1,
        memoryFreePct: 60,
        memoryPressure: "normal",
        swapUsedPct: 5,
        swapouts: 0,
        suiteSlotFree,
      }),
    );
    return path;
  }

  beforeEach(() => {
    savedMachine = process.env.LLM_ROUTER_MACHINE_JSON;
  });

  afterEach(() => {
    if (savedMachine === undefined) delete process.env.LLM_ROUTER_MACHINE_JSON;
    else process.env.LLM_ROUTER_MACHINE_JSON = savedMachine;
  });

  it("admits a spawn while the suite slot is occupied but refuses a suite start", async () => {
    process.env.LLM_ROUTER_MACHINE_JSON = machineFixture(false);

    const report = await run(["capacity"]);
    expect(report.exitCode).toBe(0);
    expect(report.output).toContain("occupied");

    const check = await run(["capacity", "check"]);
    expect(check.exitCode).toBe(0);

    const suite = await run(["capacity", "--for", "suite"]);
    expect(suite.exitCode).toBe(1);
    expect(suite.output).toContain("one-suite-at-a-time slot is occupied");

    const suiteCheck = await run(["capacity", "check", "--for", "suite"]);
    expect(suiteCheck.exitCode).toBe(1);
  });

  it("admits both purposes when the suite slot is free", async () => {
    process.env.LLM_ROUTER_MACHINE_JSON = machineFixture(true);

    expect((await run(["capacity"])).exitCode).toBe(0);
    expect((await run(["capacity", "check"])).exitCode).toBe(0);
    expect((await run(["capacity", "--for", "suite"])).exitCode).toBe(0);
  });

  it("admits a spawn while every llama slot is busy but refuses --for local-llm", async () => {
    process.env.LLM_ROUTER_MACHINE_JSON = machineFixture(true);
    const savedBusy = process.env.LLM_ROUTER_LLAMA_SLOTS_BUSY;
    process.env.LLM_ROUTER_LLAMA_SLOTS_BUSY = "2";
    try {
      const spawn = await run(["capacity"]);
      expect(spawn.exitCode).toBe(0);

      const localLlm = await run(["capacity", "--for", "local-llm"]);
      expect(localLlm.exitCode).toBe(1);
      expect(localLlm.output).toContain("llama slots are full");

      process.env.LLM_ROUTER_LLAMA_SLOTS_BUSY = "0";
      expect((await run(["capacity", "--for", "local-llm"])).exitCode).toBe(0);
    } finally {
      if (savedBusy === undefined) delete process.env.LLM_ROUTER_LLAMA_SLOTS_BUSY;
      else process.env.LLM_ROUTER_LLAMA_SLOTS_BUSY = savedBusy;
    }
  });
});

describe("capacity worker-root audit trail", () => {
  let savedCommFile: string | undefined;
  let savedArgvFile: string | undefined;

  beforeEach(() => {
    savedCommFile = process.env.LLM_ROUTER_MACHINE_PS_COMM;
    savedArgvFile = process.env.LLM_ROUTER_MACHINE_PS_ARGV;
    // The codex-triple fixture (vendored from usage-axi) collapses a node
    // wrapper -> codex -> codex-code-mode-host into exactly one invocation
    // root, so `capacity` must report `agents: 1` with one auditable root.
    process.env.LLM_ROUTER_MACHINE_PS_COMM = join(
      process.cwd(),
      "test/fixtures/machine/codex-triple.comm.ps",
    );
    process.env.LLM_ROUTER_MACHINE_PS_ARGV = join(
      process.cwd(),
      "test/fixtures/machine/codex-triple.argv.ps",
    );
  });

  afterEach(() => {
    if (savedCommFile === undefined) delete process.env.LLM_ROUTER_MACHINE_PS_COMM;
    else process.env.LLM_ROUTER_MACHINE_PS_COMM = savedCommFile;
    if (savedArgvFile === undefined) delete process.env.LLM_ROUTER_MACHINE_PS_ARGV;
    else process.env.LLM_ROUTER_MACHINE_PS_ARGV = savedArgvFile;
  });

  it("lists the counted invocation root in --json", async () => {
    const { output, exitCode } = await run(["capacity", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as {
      measured: { agents: number };
      roots: Array<{ pid: number; comm: string; match: string; via: string }>;
    };
    expect(parsed.measured.agents).toBe(1);
    expect(parsed.roots).toEqual([{ pid: 100, comm: "node", match: "codex", via: "argv" }]);
  });

  it("prints a roots[] TOON block", async () => {
    const { output } = await run(["capacity"]);
    expect(output).toContain("roots[1]{pid,comm,match,via}:");
    expect(output).toContain("100,node,codex,argv");
  });
});
