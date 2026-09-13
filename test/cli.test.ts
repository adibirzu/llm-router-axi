import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";

let dir: string;
let savedExitCode: number | undefined;
let savedConfigHome: string | undefined;

async function run(argv: string[]): Promise<{ output: string; exitCode: number }> {
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
  process.exitCode = 0;
  dir = mkdtempSync(join(tmpdir(), "llm-router-axi-test-"));
  process.env.XDG_CONFIG_HOME = dir;
});

afterEach(() => {
  process.exitCode = savedExitCode ?? 0;
  if (savedConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = savedConfigHome;
  }
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

  it("refuses to choose a harness for a valid route call", async () => {
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
    expect(output).toContain("NOT_IMPLEMENTED");
    expect(output).not.toContain("harness:");
  });

  it("accepts --flags for route but not for explain", async () => {
    const route = await run(["route", "--kind", "ship", "--flags"]);
    expect(route.exitCode).toBe(1);
    expect(route.output).toContain("NOT_IMPLEMENTED");

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

  it("refuses to persist cooldown state for a valid record call", async () => {
    const { output, exitCode } = await run([
      "record",
      "--provider",
      "cursor",
      "--outcome",
      "rate_limit",
      "--task",
      "t-42",
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain("NOT_IMPLEMENTED");
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
});
