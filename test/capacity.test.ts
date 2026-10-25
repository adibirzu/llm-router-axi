import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { evaluateGauges, mergeGauges, runningSuites, suiteLimit } from "../src/capacity.js";
import {
  countSuiteRoots,
  countWorkerRoots,
  foldLlamaSlots,
  llamaParallelCeiling,
  measureMachine,
  pressureFromLevel,
  pressureFromPsiAvg10,
  pressureFromText,
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
    suiteCount: 0,
    llamaParallel: 2,
    llamaSlotsTotal: 2,
    llamaSlotsBusy: 0,
    llamaSlotFree: true,
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

  it("refuses at the worker-root agent ceiling", () => {
    const policy = cloneDefault();
    expect(evaluateGauges(policy, gauges({ agents: 10 })).ok).toBe(false);
  });

  it("keeps the occupied suite slot as spawn context but refuses a suite start", () => {
    const policy = cloneDefault();
    const occupied = gauges({ suiteSlotFree: false, suiteCount: 1 });
    const spawn = evaluateGauges(policy, occupied);
    expect(spawn.ok).toBe(true);
    expect(spawn.reasons).toHaveLength(0);
    expect(spawn.measured).toMatchObject({ suiteSlotFree: false, purpose: "spawn" });

    const suite = evaluateGauges(policy, occupied, "suite");
    expect(suite.ok).toBe(false);
    expect(suite.reasons.join(" ")).toContain("test-suite slots are full (1 running, limit 1)");
    expect(suite.measured).toMatchObject({ purpose: "suite", suiteSlotEnforced: true });
  });

  it("admits both purposes when the suite slot is free or the rule is off", () => {
    const policy = cloneDefault();
    expect(evaluateGauges(policy, gauges({ suiteSlotFree: true })).ok).toBe(true);
    expect(evaluateGauges(policy, gauges({ suiteSlotFree: true }), "suite").ok).toBe(true);

    const off = cloneDefault();
    off.capacity.oneSuiteAtATime = false;
    delete off.capacity.maxConcurrentSuites;
    expect(evaluateGauges(off, gauges({ suiteSlotFree: false, suiteCount: 4 }), "suite").ok).toBe(true);
  });

  describe("maxConcurrentSuites", () => {
    function withLimit(limit: number): Policy {
      const policy = cloneDefault();
      policy.capacity.maxConcurrentSuites = limit;
      return policy;
    }

    it("admits a suite start below the limit and refuses at and above it", () => {
      const policy = withLimit(3);
      for (const running of [0, 1, 2]) {
        const verdict = evaluateGauges(policy, gauges({ suiteCount: running, suiteSlotFree: running === 0 }), "suite");
        expect(verdict.ok).toBe(true);
        expect(verdict.measured).toMatchObject({ suiteCount: running, maxConcurrentSuites: 3 });
      }
      for (const running of [3, 4]) {
        const verdict = evaluateGauges(policy, gauges({ suiteCount: running, suiteSlotFree: false }), "suite");
        expect(verdict.ok).toBe(false);
        expect(verdict.reasons.join(" ")).toContain(`(${running} running, limit 3)`);
        expect(verdict.measured).toMatchObject({ suiteCount: running, maxConcurrentSuites: 3, suiteSlotEnforced: true });
      }
    });

    it("never refuses a spawn or a local-llm start on running suites", () => {
      const busy = gauges({ suiteCount: 5, suiteSlotFree: false });
      expect(evaluateGauges(withLimit(3), busy).ok).toBe(true);
      expect(evaluateGauges(withLimit(3), busy, "local-llm").ok).toBe(true);
      expect(evaluateGauges(withLimit(3), busy).measured).toMatchObject({ suiteCount: 5, suiteSlotEnforced: false });
    });

    it("does not refuse when the running count is unreadable", () => {
      const unknown = gauges({ suiteCount: null, suiteSlotFree: null });
      expect(runningSuites(unknown)).toBeNull();
      expect(evaluateGauges(withLimit(1), unknown, "suite").ok).toBe(true);
    });

    it("treats an occupied legacy suiteSlotFree reading as at least one suite", () => {
      const legacyBusy = gauges({ suiteCount: null, suiteSlotFree: false });
      expect(runningSuites(legacyBusy)).toBe(1);
      expect(evaluateGauges(withLimit(1), legacyBusy, "suite").ok).toBe(false);
      expect(evaluateGauges(withLimit(2), legacyBusy, "suite").ok).toBe(true);
      expect(runningSuites(gauges({ suiteCount: null, suiteSlotFree: true }))).toBe(0);
      // A conflicting boolean never lowers a measured count, nor the reverse.
      expect(runningSuites(gauges({ suiteCount: 0, suiteSlotFree: false }))).toBe(1);
      expect(runningSuites(gauges({ suiteCount: 2, suiteSlotFree: true }))).toBe(2);
    });

    it("keeps oneSuiteAtATime as the alias when maxConcurrentSuites is absent", () => {
      const legacyOn = cloneDefault();
      delete legacyOn.capacity.maxConcurrentSuites;
      legacyOn.capacity.oneSuiteAtATime = true;
      expect(suiteLimit(legacyOn.capacity)).toBe(1);
      expect(evaluateGauges(legacyOn, gauges({ suiteCount: 1 }), "suite").ok).toBe(false);
      expect(evaluateGauges(legacyOn, gauges({ suiteCount: 0 }), "suite").ok).toBe(true);

      const legacyOff = cloneDefault();
      delete legacyOff.capacity.maxConcurrentSuites;
      legacyOff.capacity.oneSuiteAtATime = false;
      expect(suiteLimit(legacyOff.capacity)).toBeNull();
      const uncapped = evaluateGauges(legacyOff, gauges({ suiteCount: 8 }), "suite");
      expect(uncapped.ok).toBe(true);
      expect(uncapped.measured).toMatchObject({ maxConcurrentSuites: null, suiteSlotEnforced: false });
    });

    it("lets maxConcurrentSuites win over the legacy alias", () => {
      const raised = withLimit(3);
      raised.capacity.oneSuiteAtATime = true;
      expect(suiteLimit(raised.capacity)).toBe(3);
      expect(evaluateGauges(raised, gauges({ suiteCount: 2 }), "suite").ok).toBe(true);

      const capped = withLimit(2);
      capped.capacity.oneSuiteAtATime = false;
      expect(suiteLimit(capped.capacity)).toBe(2);
      expect(evaluateGauges(capped, gauges({ suiteCount: 2 }), "suite").ok).toBe(false);
    });

    it("defaults to a limit of 1 in the built-in policy", () => {
      expect(suiteLimit(cloneDefault().capacity)).toBe(1);
    });
  });

  it("refuses local-llm when every llama slot is busy and admits when one is free", () => {
    const policy = cloneDefault();
    const full = gauges({ llamaSlotsBusy: 2, llamaSlotsTotal: 2, llamaSlotFree: false });
    const refused = evaluateGauges(policy, full, "local-llm");
    expect(refused.ok).toBe(false);
    expect(refused.reasons.join(" ")).toContain("llama slots are full");

    const spawnStillOk = evaluateGauges(policy, full, "spawn");
    expect(spawnStillOk.ok).toBe(true);

    const free = gauges({ llamaSlotsBusy: 1, llamaSlotsTotal: 2, llamaSlotFree: true });
    expect(evaluateGauges(policy, free, "local-llm").ok).toBe(true);
  });

  it("does not refuse local-llm on an unreadable llama probe", () => {
    const policy = cloneDefault();
    const unknown = gauges({
      llamaSlotsBusy: null,
      llamaSlotsTotal: null,
      llamaSlotFree: null,
    });
    expect(evaluateGauges(policy, unknown, "local-llm").ok).toBe(true);
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

  it("counts running test runners, and zero when none run", () => {
    const argv = "12 node /x/node_modules/.bin/vitest run\n13 bash -c sleep";
    expect(countSuiteRoots(null, argv)).toBe(1);
    expect(countSuiteRoots(null, "12 node /usr/bin/serve\n")).toBe(0);
    expect(countSuiteRoots(null, null)).toBeNull();
  });

  it("counts one suite per root and collapses a run's own wrapper chain and workers", () => {
    // Run A: npm test -> sh -c vitest -> node vitest -> vitest-matching worker.
    // Run B: a standalone pytest. Run C: cargo test with a child test binary.
    const comm = [
      "1 0 100 /sbin/init",
      "100 1 100 npm",
      "101 100 100 sh",
      "102 101 100 node",
      "103 102 100 node",
      "200 1 100 pytest",
      "300 1 100 cargo",
      "301 300 100 cargo",
    ].join("\n");
    const argv = [
      "100 npm test",
      "101 sh -c vitest run",
      "102 node /x/node_modules/.bin/vitest run",
      "103 node /x/node_modules/.bin/vitest run --pool forks",
      "200 /usr/bin/pytest tests/",
      "300 cargo test --release",
      "301 cargo test --release -p inner",
    ].join("\n");
    expect(countSuiteRoots(comm, argv)).toBe(3);
    // Without a parent map every matching process stands alone.
    expect(countSuiteRoots(null, argv)).toBe(7);
  });

  it("does not count a non-matching ancestor against its suite child, and excludes the probe tree", () => {
    const comm = ["1 0 1 /sbin/init", "50 1 1 bash", "51 50 1 node", "60 1 1 node"].join("\n");
    const argv = ["50 bash fm-test-run.sh", "51 node vitest run", "60 node vitest run"].join("\n");
    expect(countSuiteRoots(comm, argv)).toBe(2);
    expect(countSuiteRoots(comm, argv, new Set([60]))).toBe(1);
  });

  it("promotes a suite child to a root when its matching ancestor is excluded", () => {
    const comm = ["1 0 1 /sbin/init", "70 1 1 npm", "71 70 1 node"].join("\n");
    const argv = ["70 npm test", "71 node vitest run"].join("\n");
    expect(countSuiteRoots(comm, argv)).toBe(1);
    expect(countSuiteRoots(comm, argv, new Set([70]))).toBe(1);
  });
});

describe("llama slots gauge", () => {
  it("folds a /slots payload into busy/total/free from is_processing", () => {
    const idle = foldLlamaSlots(2, [{ id: 0, is_processing: false }, { id: 1, is_processing: false }]);
    expect(idle).toEqual({ llamaSlotsTotal: 2, llamaSlotsBusy: 0, llamaSlotFree: true });

    const oneBusy = foldLlamaSlots(2, [{ id: 0, is_processing: true }, { id: 1, is_processing: false }]);
    expect(oneBusy).toEqual({ llamaSlotsTotal: 2, llamaSlotsBusy: 1, llamaSlotFree: true });

    const allBusy = foldLlamaSlots(2, [{ id: 0, is_processing: true }, { id: 1, is_processing: true }]);
    expect(allBusy).toEqual({ llamaSlotsTotal: 2, llamaSlotsBusy: 2, llamaSlotFree: false });
  });

  it("treats a malformed or empty /slots payload as unreadable, not free", () => {
    expect(foldLlamaSlots(2, [])).toEqual({
      llamaSlotsTotal: null,
      llamaSlotsBusy: null,
      llamaSlotFree: null,
    });
    expect(foldLlamaSlots(2, null)).toEqual({
      llamaSlotsTotal: null,
      llamaSlotsBusy: null,
      llamaSlotFree: null,
    });
    expect(foldLlamaSlots(2, { not: "an array" })).toEqual({
      llamaSlotsTotal: null,
      llamaSlotsBusy: null,
      llamaSlotFree: null,
    });
  });

  it("defaults the --parallel ceiling to 2 and honors LLM_ROUTER_LLAMA_PARALLEL", () => {
    const saved = process.env.LLM_ROUTER_LLAMA_PARALLEL;
    try {
      delete process.env.LLM_ROUTER_LLAMA_PARALLEL;
      expect(llamaParallelCeiling()).toBe(2);
      process.env.LLM_ROUTER_LLAMA_PARALLEL = "4";
      expect(llamaParallelCeiling()).toBe(4);
    } finally {
      if (saved === undefined) delete process.env.LLM_ROUTER_LLAMA_PARALLEL;
      else process.env.LLM_ROUTER_LLAMA_PARALLEL = saved;
    }
  });

  describe("measureMachine probe seam", () => {
    const savedEnv: Record<string, string | undefined> = {};
    let dir: string;
    const KEYS = ["LLM_ROUTER_MACHINE_PS_COMM", "LLM_ROUTER_MACHINE_PS_ARGV", "LLM_ROUTER_SUITE_COUNT", "LLM_ROUTER_MACHINE_JSON", "LLM_ROUTER_LLAMA_SLOTS_URL", "LLM_ROUTER_LLAMA_SLOTS_BUSY", "LLM_ROUTER_LLAMA_PARALLEL"];

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "llm-router-probe-"));
      for (const key of KEYS) savedEnv[key] = process.env[key];
      // Drop the suite-wide gauge fixture so these assertions see the raw probe.
      delete process.env.LLM_ROUTER_MACHINE_JSON;
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      for (const key of KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    });

    it("derives suiteCount and suiteSlotFree from a replayed ps snapshot", () => {
      const comm = join(dir, "suites.comm.ps");
      const argv = join(dir, "suites.argv.ps");
      writeFileSync(
        comm,
        ["1 0 1 /sbin/init", "10 1 1 npm", "11 10 1 node", "20 1 1 pytest", "30 1 1 node"].join("\n"),
      );
      writeFileSync(
        argv,
        ["10 npm test", "11 node vitest run", "20 pytest -q", "30 node /usr/bin/serve"].join("\n"),
      );
      process.env.LLM_ROUTER_MACHINE_PS_COMM = comm;
      process.env.LLM_ROUTER_MACHINE_PS_ARGV = argv;
      expect(measureMachine()).toMatchObject({ suiteCount: 2, suiteSlotFree: false });

      writeFileSync(argv, "30 node /usr/bin/serve\n");
      expect(measureMachine()).toMatchObject({ suiteCount: 0, suiteSlotFree: true });
    });

    it("pins the suite count from LLM_ROUTER_SUITE_COUNT without reading ps", () => {
      process.env.LLM_ROUTER_SUITE_COUNT = "3";
      expect(measureMachine()).toMatchObject({ suiteCount: 3 });
    });

    it("keeps a boolean-only fixture from inheriting the live suite count", () => {
      const path = join(dir, "bool-only.json");
      writeFileSync(path, JSON.stringify({ suiteSlotFree: true }));
      process.env.LLM_ROUTER_MACHINE_JSON = path;
      process.env.LLM_ROUTER_SUITE_COUNT = "3";
      expect(measureMachine()).toMatchObject({ suiteSlotFree: true, suiteCount: null });
    });

    it("reports unknown, not free, when the llama server is unreachable", () => {
      process.env.LLM_ROUTER_LLAMA_SLOTS_URL = "off";
      const gaugesRead = measureMachine();
      expect(gaugesRead.llamaSlotsTotal).toBeNull();
      expect(gaugesRead.llamaSlotsBusy).toBeNull();
      expect(gaugesRead.llamaSlotFree).toBeNull();
      expect(gaugesRead.llamaParallel).toBe(2);
    });

    it("reads a busy count from LLM_ROUTER_LLAMA_SLOTS_BUSY without a network probe", () => {
      process.env.LLM_ROUTER_LLAMA_PARALLEL = "2";
      process.env.LLM_ROUTER_LLAMA_SLOTS_BUSY = "2";
      expect(measureMachine()).toMatchObject({
        llamaParallel: 2,
        llamaSlotsTotal: 2,
        llamaSlotsBusy: 2,
        llamaSlotFree: false,
      });

      process.env.LLM_ROUTER_LLAMA_SLOTS_BUSY = "1";
      expect(measureMachine()).toMatchObject({
        llamaSlotsBusy: 1,
        llamaSlotFree: true,
      });
    });

    it("reports unknown when LLM_ROUTER_LLAMA_SLOTS_BUSY is explicitly unknown", () => {
      process.env.LLM_ROUTER_LLAMA_SLOTS_BUSY = "unknown";
      const gaugesRead = measureMachine();
      expect(gaugesRead.llamaSlotsTotal).toBeNull();
      expect(gaugesRead.llamaSlotsBusy).toBeNull();
      expect(gaugesRead.llamaSlotFree).toBeNull();
    });
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
