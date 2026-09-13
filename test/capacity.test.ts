import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { evaluateGauges, mergeGauges } from "../src/capacity.js";
import {
  countWorkerRoots,
  measureMachine,
  pressureFromLevel,
  pressureFromPsiAvg10,
  pressureFromText,
  suiteSlotFromArgv,
  swapPercent,
  type MachineGauges,
} from "../src/machine.js";
import { readDefaultPolicy } from "../src/policy/index.js";
import type { Policy } from "../src/policy/types.js";
import type { QuotaRead } from "../src/selector.js";

function cloneDefault(): Policy {
  return JSON.parse(JSON.stringify(readDefaultPolicy())) as Policy;
}

function gauges(overrides: Partial<MachineGauges> = {}): MachineGauges {
  return {
    agents: 1,
    loadPerCore: 0.1,
    memoryFreePct: 60,
    memoryPressure: "normal",
    swapUsedPct: 5,
    swapouts: 0,
    suiteSlotFree: true,
    ...overrides,
  };
}

describe("capacity doctrine", () => {
  it("keeps the captain's memory reserve at 10 percent, not 20", () => {
    expect(readDefaultPolicy().capacity.memoryFreeReservePercent).toBe(10);
  });

  it("routes on the captain's 13-22 percent free Mac", () => {
    const policy = cloneDefault();
    for (const memoryFreePct of [13, 15, 22]) {
      const verdict = evaluateGauges(policy, gauges({ memoryFreePct }));
      expect(verdict.ok, `${memoryFreePct}% free should route`).toBe(true);
    }
  });

  it("refuses below the 10 percent reserve", () => {
    const verdict = evaluateGauges(cloneDefault(), gauges({ memoryFreePct: 9 }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("under the 10% reserve");
  });

  it("admits warn pressure by default but refuses critical", () => {
    const policy = cloneDefault();
    expect(evaluateGauges(policy, gauges({ memoryPressure: "warn" })).ok).toBe(true);
    const critical = evaluateGauges(policy, gauges({ memoryPressure: "critical" }));
    expect(critical.ok).toBe(false);
    expect(critical.reasons.join(" ")).toContain("memory pressure is critical");
  });

  it("honors a stricter memoryPressureMax and an ignore", () => {
    const strict = cloneDefault();
    strict.capacity.memoryPressureMax = "normal";
    expect(evaluateGauges(strict, gauges({ memoryPressure: "warn" })).ok).toBe(false);

    const off = cloneDefault();
    off.capacity.memoryPressureMax = "ignore";
    expect(evaluateGauges(off, gauges({ memoryPressure: "critical" })).ok).toBe(true);
  });

  it("does not refuse on swap by default but honors a configured ceiling", () => {
    const policy = cloneDefault();
    expect(policy.capacity.maxSwapUsedPercent).toBeNull();
    expect(evaluateGauges(policy, gauges({ swapUsedPct: 90 })).ok).toBe(true);

    const bounded = cloneDefault();
    bounded.capacity.maxSwapUsedPercent = 50;
    expect(evaluateGauges(bounded, gauges({ swapUsedPct: 60 })).ok).toBe(false);
    expect(evaluateGauges(bounded, gauges({ swapUsedPct: 40 })).ok).toBe(true);
  });

  it("refuses at the worker-root agent ceiling and on an occupied suite slot", () => {
    const policy = cloneDefault();
    expect(evaluateGauges(policy, gauges({ agents: 10 })).ok).toBe(false);
    expect(evaluateGauges(policy, gauges({ suiteSlotFree: false })).ok).toBe(false);
  });

  it("lets usage-axi machine{} override the local probe", () => {
    const quota: QuotaRead = {
      available: true,
      data: {
        providers: [],
        machine: { agents: 2, loadPerCore: 0.2, memoryFreePct: 70, suiteSlotFree: true },
      },
    };
    const merged = mergeGauges(quota, gauges({ agents: 99, memoryFreePct: 1 }));
    expect(merged.agents).toBe(2);
    expect(merged.memoryFreePct).toBe(70);
  });
});

describe("machine probes (Linux correctness)", () => {
  it("maps macOS pressure codes", () => {
    expect(pressureFromLevel("1")).toBe("normal");
    expect(pressureFromLevel("2")).toBe("warn");
    expect(pressureFromLevel("4")).toBe("critical");
    expect(pressureFromLevel("9")).toBeNull();
  });

  it("maps Linux PSI avg10 to normal/warn/critical", () => {
    expect(pressureFromPsiAvg10(0)).toBe("normal");
    expect(pressureFromPsiAvg10(4.99)).toBe("normal");
    expect(pressureFromPsiAvg10(5)).toBe("warn");
    expect(pressureFromPsiAvg10(19.9)).toBe("warn");
    expect(pressureFromPsiAvg10(20)).toBe("critical");
    expect(pressureFromPsiAvg10(null)).toBeNull();
  });

  it("parses a real /proc/pressure/memory line", () => {
    const line = "some avg10=0.00 avg60=1.50 avg300=3.20 total=1973478395";
    expect(pressureFromText(line)).toBe("normal");
    expect(pressureFromText("some avg10=7.00 avg60=2.00 avg300=1.00")).toBe("warn");
    expect(pressureFromText("nonsense")).toBeNull();
  });

  it("computes swap used percent and treats no-swap as unmeasured", () => {
    expect(swapPercent(16384, 8192)).toBe(50);
    expect(swapPercent(0, 0)).toBeNull();
    expect(swapPercent(null, 10)).toBeNull();
  });

  it("counts interpreter-launched worker roots and never reads pip as pi", () => {
    const comm = [
      "1 0 4000 /sbin/launchd",
      "100 1 300000 /opt/homebrew/bin/node",
      "101 100 200000 /usr/bin/python3",
      "200 1 150000 /Users/op/Library/Application Support/my tools/claude",
      "300 1 90000 /usr/bin/pip",
    ].join("\n");
    const argv = [
      "100 node /Users/op/.npm/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      "101 python3 /usr/local/lib/agent/tool-server.py",
      "300 pip install something",
    ].join("\n");
    expect(countWorkerRoots(comm, argv)).toBe(2);
  });

  it("detects a running test runner as a busy suite slot", () => {
    const argv = "12 node /x/node_modules/.bin/vitest run\n13 bash -c sleep";
    expect(suiteSlotFromArgv(argv)).toBe(false);
    expect(suiteSlotFromArgv("12 node /usr/bin/serve\n")).toBe(true);
    expect(suiteSlotFromArgv(null)).toBeNull();
  });
});

describe("machine fixture seam", () => {
  let dir: string;
  let savedFixture: string | undefined;

  beforeEach(() => {
    savedFixture = process.env.LLM_ROUTER_MACHINE_JSON;
    dir = mkdtempSync(join(tmpdir(), "llm-router-machine-"));
  });

  afterEach(() => {
    if (savedFixture === undefined) delete process.env.LLM_ROUTER_MACHINE_JSON;
    else process.env.LLM_ROUTER_MACHINE_JSON = savedFixture;
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads gauges from LLM_ROUTER_MACHINE_JSON", () => {
    const path = join(dir, "machine.json");
    writeFileSync(
      path,
      JSON.stringify({
        agents: 3,
        loadPerCore: 1.5,
        memoryFreePct: 33,
        memoryPressure: "warn",
        swapUsedPct: 12,
        swapouts: 42,
        suiteSlotFree: false,
      }),
    );
    process.env.LLM_ROUTER_MACHINE_JSON = path;
    expect(measureMachine()).toMatchObject({
      agents: 3,
      loadPerCore: 1.5,
      memoryFreePct: 33,
      memoryPressure: "warn",
      swapUsedPct: 12,
      swapouts: 42,
      suiteSlotFree: false,
    });
  });
});
