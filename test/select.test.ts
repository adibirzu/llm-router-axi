import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";

/**
 * `llm-router-axi select` is the arbitrary-profile surface firstmate's
 * fm-dispatch-select.mjs can shim onto. These tests run the pinned fork
 * selector and the router on the same quota document, profiles, `--now`, and
 * least-recent-use home, then assert the chosen launch profile, the exit class,
 * and the frozen rejection strings are identical.
 */

const FORK = fileURLToPath(new URL("./fixtures/selector/fm-dispatch-select.mjs", import.meta.url));

const NOW = 1000;
const STAMP = "1970-01-01T00:16:40.000Z";
const OLD_STAMP = "1970-01-01T00:00:00.000Z";

interface Scenario {
  name: string;
  quota: unknown;
  profiles: unknown[];
  seedState?: unknown;
  expect: "select" | "refuse";
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function quota(providers: unknown[], generatedAt = STAMP): unknown {
  return { schemaVersion: 5, generatedAt, providers };
}

function window(id: string, percentRemaining: number): unknown {
  return { id, percentRemaining };
}

function provider(name: string, windows: unknown[], status = "fresh"): unknown {
  return { provider: name, state: { status, stale: false }, windows };
}

function splitPool(apiRemaining: number): unknown {
  return quota([
    {
      provider: "cursor",
      state: { status: "fresh", stale: false },
      windows: [
        window("included_usage", 84),
        window("auto_usage", 97),
        window("api_usage", apiRemaining),
      ],
      quotaSemantics: {
        effectiveAvailability: [
          { scope: "all_models", status: "known", effectivePercentRemaining: apiRemaining },
        ],
      },
    },
  ]);
}

function spend(name: string, headroom: number, priority: number): unknown {
  return {
    provider: name,
    state: { status: "fresh", stale: false },
    windows: [window("all", headroom)],
    quotaSemantics: {
      status: "known",
      effectiveAvailability: [
        {
          scope: "all_models",
          status: "known",
          effectivePercentRemaining: headroom,
          selection: { status: "known", spendPriority: priority },
        },
      ],
    },
  };
}

function prepare(scenario: Scenario): {
  home: string;
  quotaFile: string;
  forkState: string;
  routerState: string;
  configHome: string;
} {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "llm-router-select-")));
  tempDirs.push(home);
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(join(home, "config"), { recursive: true });
  const configHome = join(home, "xdg");
  mkdirSync(configHome, { recursive: true });
  const quotaFile = join(home, "quota.json");
  writeFileSync(
    quotaFile,
    typeof scenario.quota === "string" ? scenario.quota : JSON.stringify(scenario.quota),
  );
  // Separate least-recent-use ledgers, seeded identically: the fork must not
  // advance the state the router then reads (or the comparison rotates).
  const forkState = join(home, "state", "fork-routing.json");
  const routerState = join(home, "state", "router-routing.json");
  if (scenario.seedState !== undefined) {
    writeFileSync(forkState, JSON.stringify(scenario.seedState));
    writeFileSync(routerState, JSON.stringify(scenario.seedState));
  }
  return { home, quotaFile, forkState, routerState, configHome };
}

function runFork(scenario: Scenario, env: ReturnType<typeof prepare>): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [FORK, "select", "--quota-json", env.quotaFile, "--now", String(NOW), JSON.stringify(scenario.profiles)],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FM_HOME: env.home,
        FM_STATE_OVERRIDE: join(env.home, "state"),
        FM_CONFIG_OVERRIDE: join(env.home, "config"),
        FM_DISPATCH_STATE_FILE: env.forkState,
      },
    },
  );
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const savedEnv: Record<string, string | undefined> = {};

async function runRouter(
  scenario: Scenario,
  env: ReturnType<typeof prepare>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  savedEnv["FM_HOME"] = process.env.FM_HOME;
  savedEnv["XDG_CONFIG_HOME"] = process.env.XDG_CONFIG_HOME;
  savedEnv["LLM_ROUTER_STATE_FILE"] = process.env.LLM_ROUTER_STATE_FILE;
  process.env.FM_HOME = env.home;
  process.env.XDG_CONFIG_HOME = env.configHome;
  process.env.LLM_ROUTER_STATE_FILE = env.routerState;

  const originalStderr = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  process.exitCode = 0;
  let stdout = "";
  try {
    await main({
      argv: [
        "select",
        "--quota-json",
        env.quotaFile,
        "--now",
        String(NOW),
        JSON.stringify(scenario.profiles),
      ],
      stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
    });
  } finally {
    process.stderr.write = originalStderr;
    for (const key of ["FM_HOME", "XDG_CONFIG_HOME", "LLM_ROUTER_STATE_FILE"]) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { code: process.exitCode ?? 0, stdout, stderr };
}

async function assertParity(scenario: Scenario): Promise<void> {
  const env = prepare(scenario);
  const fork = runFork(scenario, env);
  const router = await runRouter(scenario, env);

  if (scenario.expect === "refuse") {
    expect(router.code, `${scenario.name}: router should refuse`).not.toBe(0);
    expect(router.code, `${scenario.name}: exit class must match`).toBe(fork.code);
    const forkReasons = fork.stderr
      .split("\n")
      .map((line) => line.replace(/^fm-dispatch-select: /, "").trim())
      .filter((line) => line.startsWith("candidate "));
    for (const reason of forkReasons) {
      expect(router.stderr, `${scenario.name}: missing selector reason`).toContain(reason);
    }
    return;
  }

  expect(fork.code, `${scenario.name}: fork failed: ${fork.stderr}`).toBe(0);
  expect(router.code, `${scenario.name}: router refused: ${router.stderr}`).toBe(0);
  expect(JSON.parse(router.stdout), `${scenario.name}: chosen profile`).toEqual(
    JSON.parse(fork.stdout),
  );
}

/** Config errors: the router must refuse the same malformed input with exit 2. */
async function assertConfigError(profiles: unknown[], message: string): Promise<void> {
  const scenario: Scenario = { name: "config", quota: quota([provider("claude", [window("all", 80)])]), profiles, expect: "refuse" };
  const env = prepare(scenario);
  const fork = runFork(scenario, env);
  const router = await runRouter(scenario, env);
  expect(fork.code, `fork should reject: ${message}`).toBe(2);
  expect(router.code, `router should reject: ${message}`).toBe(2);
  expect(router.stdout).toContain(message);
}

describe("select: parity with the pinned firstmate selector", () => {
  it("1/11. distributes deterministically and array-order independently", async () => {
    const base: Scenario = {
      name: "distribution",
      quota: quota([provider("claude", [window("all", 80)]), provider("codex", [window("all", 80)])]),
      profiles: [
        { harness: "claude", model: "sonnet" },
        { harness: "codex", model: "gpt" },
      ],
      expect: "select",
    };
    await assertParity(base);
    await assertParity({ ...base, name: "distribution-reversed", profiles: [...base.profiles].reverse() });
    await assertParity({
      name: "spend-tie",
      quota: quota([spend("claude", 80, 0), spend("codex", 80, 0)]),
      profiles: [
        { harness: "claude" },
        { harness: "codex" },
      ],
      expect: "select",
    });
  });

  it("2. fails closed on stale, unavailable, and windowless telemetry", async () => {
    await assertParity({
      name: "stale",
      quota: quota(
        [provider("claude", [window("all", 90)]), provider("codex", [window("all", 90)])],
        OLD_STAMP,
      ),
      profiles: [{ harness: "claude" }, { harness: "codex" }],
      expect: "refuse",
    });
    await assertParity({
      name: "reserve",
      quota: quota([provider("claude", [window("all", 20)]), provider("codex", [window("all", 21)])]),
      profiles: [{ harness: "claude" }, { harness: "codex" }],
      expect: "select",
    });
    await assertParity({
      name: "unavailable",
      quota: quota([
        provider("claude", [window("all", 99)], "auth_required"),
        provider("codex", [window("all", 75)]),
      ]),
      profiles: [{ harness: "claude" }, { harness: "codex" }],
      expect: "select",
    });
    await assertParity({
      name: "windowless",
      quota: quota([
        {
          provider: "claude",
          state: { status: "fresh", stale: false },
          quotaSemantics: { effectiveAvailability: [{ status: "known", effectivePercentRemaining: 90 }] },
        },
      ]),
      profiles: [{ harness: "claude" }],
      expect: "refuse",
    });
  });

  it("3. applies a seeded cooldown and fails over", async () => {
    await assertParity({
      name: "cooldown",
      quota: quota([provider("claude", [window("all", 80)]), provider("codex", [window("all", 80)])]),
      profiles: [{ harness: "claude" }, { harness: "codex" }],
      seedState: {
        version: 1,
        sequence: 1,
        lastSelected: {},
        profileLastSelected: {},
        cooldowns: { codex: { until: 2800, reason: "verified", recordedAt: 1000 } },
      },
      expect: "select",
    });
  });

  it("5/6. keeps wrapper-provider routes and does not price windowless grok", async () => {
    await assertParity({
      name: "wrapper-grok",
      quota: quota([provider("claude", [window("all", 70)]), provider("grok", [window("all", 70)])]),
      profiles: [
        { harness: "pi", provider: "claude", model: "anthropic/example" },
        { harness: "grok" },
      ],
      expect: "select",
    });
    await assertParity({
      name: "grok-no-window",
      quota: quota([
        provider("claude", [window("all", 80)]),
        {
          provider: "grok",
          source: "unavailable",
          windows: [],
          state: { status: "error", stale: false, error: "Grok quota unavailable", authStatus: "usable" },
        },
      ]),
      profiles: [{ harness: "grok" }],
      expect: "refuse",
    });
  });

  it("7. selects new verified adapters with explicit providers", async () => {
    await assertParity({
      name: "new-adapters",
      quota: quota([
        provider("claude", [window("all", 80)]),
        provider("codex", [window("all", 80)]),
        provider("cursor", [window("all", 80)]),
      ]),
      profiles: [
        { harness: "cline", provider: "claude", model: "claude-sonnet-5", effort: "high" },
        { harness: "cursor" },
        { harness: "copilot", provider: "claude", model: "gpt-5.6", effort: "max" },
      ],
      expect: "select",
    });
    await assertParity({
      name: "cursor-exhausted",
      quota: quota([provider("codex", [window("all", 80)]), provider("cursor", [window("all", 0)])]),
      profiles: [{ harness: "cursor" }, { harness: "codex" }],
      expect: "select",
    });
  });

  it("8. prices a declared quota window instead of the provider minimum", async () => {
    await assertParity({
      name: "cursor-undeclared",
      quota: splitPool(0),
      profiles: [{ harness: "cursor", model: "cursor-grok-4.6-high" }],
      expect: "refuse",
    });
    await assertParity({
      name: "cursor-auto",
      quota: splitPool(0),
      profiles: [{ harness: "cursor", model: "cursor-grok-4.6-high", quotaWindow: "auto_usage" }],
      expect: "select",
    });
    await assertParity({
      name: "cursor-api",
      quota: splitPool(0),
      profiles: [{ harness: "cursor", quotaWindow: "api_usage" }],
      expect: "refuse",
    });
  });

  it("9. fails closed on a declared window absent from telemetry", async () => {
    await assertParity({
      name: "missing-window",
      quota: splitPool(0),
      profiles: [{ harness: "cursor", quotaWindow: "renamed_usage" }],
      expect: "refuse",
    });
    await assertParity({
      name: "unusable-window",
      quota: quota([
        {
          provider: "cursor",
          state: { status: "fresh", stale: false },
          windows: [{ id: "auto_usage" }, window("included_usage", 90)],
        },
      ]),
      profiles: [{ harness: "cursor", quotaWindow: "auto_usage" }],
      expect: "refuse",
    });
  });

  it("10. ranks a known spendPriority above headroom", async () => {
    await assertParity({
      name: "spend-priority",
      quota: quota([spend("claude", 80, -1.1111), spend("codex", 40, -0.8333)]),
      profiles: [
        { harness: "claude", model: "sonnet" },
        { harness: "codex", model: "gpt" },
      ],
      expect: "select",
    });
  });

  it("12/13. prices agy pools separately and restores eligibility after a cooldown", async () => {
    const agyQuota = quota([
      {
        provider: "agy",
        state: { status: "fresh", stale: false },
        windows: [
          window("gemini_5h", 100),
          window("gemini_weekly", 93),
          window("claude_gpt_5h", 0),
          window("claude_gpt_weekly", 32),
        ],
        quotaSemantics: { effectiveAvailability: [] },
      },
    ]);
    await assertParity({
      name: "agy-undeclared",
      quota: agyQuota,
      profiles: [{ harness: "agy", model: "gemini-3.7-flash-high" }],
      expect: "refuse",
    });
    await assertParity({
      name: "agy-gemini",
      quota: agyQuota,
      profiles: [{ harness: "agy", model: "gemini-3.7-flash-high", quotaWindow: "gemini_5h" }],
      expect: "select",
    });
    await assertParity({
      name: "agy-claude",
      quota: agyQuota,
      profiles: [{ harness: "agy", model: "claude-sonnet-4-6", quotaWindow: "claude_gpt_5h" }],
      expect: "refuse",
    });
    await assertParity({
      name: "agy-cooldown",
      quota: quota([
        {
          provider: "agy",
          state: { status: "fresh", stale: false },
          windows: [window("gemini_5h", 100)],
        },
        provider("codex", [window("all", 90)]),
      ]),
      profiles: [
        { harness: "agy", model: "gemini-3.7-flash-high", quotaWindow: "gemini_5h" },
        { harness: "codex", model: "gpt" },
      ],
      seedState: {
        version: 1,
        sequence: 1,
        lastSelected: {},
        profileLastSelected: {},
        cooldowns: { agy: { until: 2800, reason: "verified", recordedAt: 1000 } },
      },
      expect: "select",
    });
  });
});

describe("select: configuration refusals (fork parity)", () => {
  it("refuses Kimi, native mismatches, raw harnesses, and malformed input", async () => {
    await assertConfigError([{ harness: "kimi", model: "kimi-code/k3" }], "Kimi is unsupported for subscription dispatch");
    await assertConfigError([{ harness: "codex", provider: "claude" }], "native harness codex requires provider codex");
    await assertConfigError(
      [{ harness: "env X=1 kimi --auto", provider: "claude" }],
      "subscription dispatch requires a verified harness",
    );
    await assertConfigError([{ harness: "cursor", quotaWindow: "" }], "quotaWindow must be a non-empty string when present");
    await assertConfigError([{ harness: "codex" }, { harness: "codex" }], "dispatch profile array contains a duplicate concrete profile");
    await assertConfigError([], "dispatch profile array must not be empty");
    await assertConfigError([{ model: "sonnet" }], "each dispatch profile needs a non-empty harness");
  });

  it("refuses out-of-range settings overrides with exit 2", async () => {
    const scenario: Scenario = {
      name: "settings",
      quota: quota([provider("claude", [window("all", 80)])]),
      profiles: [{ harness: "claude" }],
      expect: "select",
    };
    const env = prepare(scenario);
    process.exitCode = 0;
    let stdout = "";
    savedEnv["FM_HOME"] = process.env.FM_HOME;
    savedEnv["XDG_CONFIG_HOME"] = process.env.XDG_CONFIG_HOME;
    savedEnv["LLM_ROUTER_STATE_FILE"] = process.env.LLM_ROUTER_STATE_FILE;
    process.env.FM_HOME = env.home;
    process.env.XDG_CONFIG_HOME = env.configHome;
    process.env.LLM_ROUTER_STATE_FILE = env.routerState;
    try {
      await main({
        argv: ["select", "--quota-json", env.quotaFile, "--reserve-percent", "100", JSON.stringify(scenario.profiles)],
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
      });
    } finally {
      for (const key of ["FM_HOME", "XDG_CONFIG_HOME", "LLM_ROUTER_STATE_FILE"]) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(process.exitCode).toBe(2);
    expect(stdout).toContain("reservePercent must be an integer from 0 to 99");
  });
});
