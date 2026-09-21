/**
 * Slice 3 (shadow-mode classify hook in route + record) tests.
 *
 * No live key, no network: every Jev-path test injects a stub `fetch`.
 * CLI-level tests run with no key (heuristic fallback, zero network) or
 * with the kill switch set plus a stubbed global fetch that proves zero
 * network calls. Run this suite on its own
 * (`npx vitest run test/shadow.test.ts`) like every other suite on this host.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { recordCommand } from "../src/commands/record.js";
import { routeCommand } from "../src/commands/route.js";
import { shadowCommand } from "../src/commands/shadow.js";
import type { FetchImpl } from "../src/jev/client.js";
import {
  appendLedgerRow,
  buildShadowReport,
  JEV_FREEZE,
  JEV_SHADOW_ENV,
  readLedgerRows,
  runRouteShadow,
  SHADOW_FILE_ENV,
  shadowEnabled,
  shadowKilled,
  shadowLedgerPath,
  type ShadowReport,
} from "../src/jev/shadow.js";
import { configDir, readDefaultPolicy } from "../src/policy/index.js";
import type { Policy } from "../src/policy/types.js";
import { validatePolicy } from "../src/policy/index.js";

const SENTINEL_KEY = "SENTINEL-JEV-KEY-9f8e7d6c5b4a";
const FIXTURE_TASK = "Fix the login retry bug in api/auth.py: exponential backoff overshoots after 3 attempts";
const NOW = 1_786_000_000;

function jevFixture(name: string): any {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/jev/${name}`, import.meta.url)), "utf8"),
  );
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(
  calls: CapturedCall[],
  handler: (call: CapturedCall, index: number) => Response | Promise<Response>,
): FetchImpl {
  return (async (input: any, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as FetchImpl;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Build a minimal SystemOne body answering the three core fields. */
function jevResponse(kind: string, difficulty: string, surface: string): unknown {
  const choice = (value: string) => ({
    type: "choice",
    choice: value,
    probabilities: { [value]: 0.9 },
    confidence: 0.9,
  });
  return {
    model: "jev-1.13.0",
    answers: {
      kind: choice(kind),
      difficulty: choice(difficulty),
      surface: choice(surface),
      reasoningClass: choice("code-gen"),
      riskClass: choice("medium"),
      toolAffinity: choice("none"),
    },
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function hangingFetch(): FetchImpl {
  return ((_input: any, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })) as FetchImpl;
}

function cloneDefault(): Policy {
  return JSON.parse(JSON.stringify(readDefaultPolicy())) as Policy;
}

let dir: string;
let ledgerFile: string;
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

function writeJson(name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function usageFixture(): unknown {
  return {
    schemaVersion: 5,
    generatedAt: new Date(NOW * 1000).toISOString(),
    providers: [
      {
        provider: "claude",
        state: { status: "fresh", stale: false },
        windows: [{ id: "all", percentRemaining: 80 }],
      },
      {
        provider: "codex",
        state: { status: "fresh", stale: false },
        windows: [{ id: "all", percentRemaining: 70 }],
      },
    ],
  };
}

function singleCandidatePolicy(): Policy {
  const policy = cloneDefault();
  policy.kinds.ship.medium.candidates = [
    { harness: "claude", provider: "claude", model: "sonnet" },
  ];
  return policy;
}

/** Args for a direct routeCommand call (main() callers prepend "route"). */
function routeArgs(usageFile: string, extra: string[] = []): string[] {
  return [
    "--kind",
    "ship",
    "--difficulty",
    "medium",
    "--surface",
    "backend",
    "--usage-json",
    usageFile,
    "--now",
    String(NOW),
    "--json",
    ...extra,
  ];
}

beforeEach(() => {
  savedExitCode = process.exitCode;
  savedEnv = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    LLM_ROUTER_STATE_FILE: process.env.LLM_ROUTER_STATE_FILE,
    LLM_ROUTER_USAGE_AXI: process.env.LLM_ROUTER_USAGE_AXI,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    TYPESAFE_BASE_URL: process.env.TYPESAFE_BASE_URL,
    [JEV_SHADOW_ENV]: process.env[JEV_SHADOW_ENV],
    [SHADOW_FILE_ENV]: process.env[SHADOW_FILE_ENV],
  };
  process.exitCode = 0;
  dir = mkdtempSync(join(tmpdir(), "llm-router-axi-shadow-"));
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.XDG_STATE_HOME = join(dir, "state");
  delete process.env.LLM_ROUTER_STATE_FILE;
  process.env.LLM_ROUTER_USAGE_AXI = join(dir, "missing-usage-axi");
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_BASE_URL;
  delete process.env[JEV_SHADOW_ENV];
  ledgerFile = join(dir, "shadow-ledger.jsonl");
  process.env[SHADOW_FILE_ENV] = ledgerFile;
});

afterEach(() => {
  process.exitCode = savedExitCode ?? 0;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("policy surface (jev.shadow, off by default)", () => {
  it("ships disabled in the bundled seed", () => {
    expect(readDefaultPolicy().jev?.shadow?.enabled).toBe(false);
  });

  it("validates an enabled shadow block", () => {
    const policy = cloneDefault() as unknown as Record<string, unknown>;
    policy.jev = { shadow: { enabled: true } };
    expect(validatePolicy(policy).ok).toBe(true);
  });

  it("refuses a non-boolean shadow flag and unknown jev keys", () => {
    const badFlag = cloneDefault() as unknown as Record<string, unknown>;
    badFlag.jev = { shadow: { enabled: "yes" } };
    const refused = validatePolicy(badFlag);
    expect(refused.ok).toBe(false);

    const badKey = cloneDefault() as unknown as Record<string, unknown>;
    badKey.jev = { shadow: { enabled: false, budget: 5 } };
    expect(validatePolicy(badKey).ok).toBe(false);
  });

  it("keeps validating policies written before the jev block existed", () => {
    const policy = cloneDefault() as unknown as Record<string, unknown>;
    delete policy.jev;
    expect(validatePolicy(policy).ok).toBe(true);
  });

  it("writes the seed disabled on policy init", async () => {
    const { exitCode } = await run(["policy", "init"]);
    expect(exitCode).toBe(0);
    const written = JSON.parse(
      readFileSync(join(dir, "config", "llm-router-axi", "policy.json"), "utf8"),
    ) as Policy;
    expect(written.jev?.shadow?.enabled).toBe(false);
    expect(validatePolicy(written).ok).toBe(true);
  });
});

describe("kill switch and config gate", () => {
  it("kills on off-values only, case-insensitively", () => {
    expect(shadowKilled({})).toBe(false);
    for (const value of ["off", "OFF", "Off", "0", "false", "FALSE", "no", "NO", " off "]) {
      expect(shadowKilled({ [JEV_SHADOW_ENV]: value })).toBe(true);
    }
    for (const value of ["on", "true", "1", "yes", ""]) {
      expect(shadowKilled({ [JEV_SHADOW_ENV]: value })).toBe(false);
    }
  });

  it("enables only on an explicit true with no kill switch", () => {
    const enabled = cloneDefault();
    enabled.jev = { shadow: { enabled: true } };
    expect(shadowEnabled(enabled)).toBe(true);
    expect(shadowEnabled(enabled, { [JEV_SHADOW_ENV]: "off" })).toBe(false);

    expect(shadowEnabled(cloneDefault())).toBe(false);
    const missing = cloneDefault() as unknown as Record<string, unknown>;
    delete missing.jev;
    expect(shadowEnabled(missing as Policy)).toBe(false);
  });

  it("defaults the ledger under the state dir with a file override", () => {
    delete process.env[SHADOW_FILE_ENV];
    expect(shadowLedgerPath({ XDG_STATE_HOME: "/tmp/x" })).toBe(
      "/tmp/x/llm-router-axi/shadow-ledger.jsonl",
    );
    expect(shadowLedgerPath({ [SHADOW_FILE_ENV]: "/tmp/custom.jsonl" })).toBe("/tmp/custom.jsonl");
  });
});

describe("shadow off: byte-identical output, zero network", () => {
  it("ignores --task when disabled and writes no ledger", async () => {
    writePolicy(singleCandidatePolicy());
    const usageFile = writeJson("usage.json", usageFixture());
    const calls: CapturedCall[] = [];
    const guard = stubFetch(calls, () => jsonResponse(200, jevFixture("classify-success.json").response));

    const first = await routeCommand(routeArgs(usageFile, ["--task", FIXTURE_TASK]), {
      fetchImpl: guard,
    });
    const second = await routeCommand(routeArgs(usageFile, ["--task", FIXTURE_TASK]), {
      fetchImpl: guard,
    });
    expect(first).toBe(second);
    expect(calls).toHaveLength(0);
    expect(readLedgerRows()).toEqual([]);
    const decision = JSON.parse(first) as { harness: string; model: string };
    expect(decision.harness).toBe("claude");
    expect(decision.model).toBe("sonnet");
  });

  it("stays byte-identical under the kill switch with a key set", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    process.env[JEV_SHADOW_ENV] = "off";
    const policy = singleCandidatePolicy();
    policy.jev = { shadow: { enabled: true } };
    writePolicy(policy);
    const usageFile = writeJson("usage.json", usageFixture());
    const calls: CapturedCall[] = [];

    const output = await routeCommand(routeArgs(usageFile, ["--task", FIXTURE_TASK]), {
      fetchImpl: stubFetch(calls, () => jsonResponse(200, jevResponse("ship", "medium", "backend"))),
    });

    delete process.env[JEV_SHADOW_ENV];
    delete process.env.TYPESAFE_API_KEY;
    const plain = singleCandidatePolicy();
    writePolicy(plain);
    const expected = await routeCommand(routeArgs(usageFile, ["--task", FIXTURE_TASK]), {
      fetchImpl: stubFetch([], () => {
        throw new Error("must not be called");
      }),
    });

    expect(output).toBe(expected);
    expect(calls).toHaveLength(0);
    expect(readLedgerRows()).toEqual([]);
    expect(output).not.toContain(SENTINEL_KEY);
  });

  it("proves zero network through main with a stubbed global fetch", async () => {
    writePolicy(singleCandidatePolicy());
    const savedFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      calls.push(String(input));
      throw new Error("network must not be touched");
    }) as typeof fetch;
    try {
      const disabled = await run(["route", ...routeArgs(usageFile0(), ["--task", FIXTURE_TASK])]);
      expect(disabled.exitCode).toBe(0);
      expect(calls).toHaveLength(0);

      const policy = singleCandidatePolicy();
      policy.jev = { shadow: { enabled: true } };
      writePolicy(policy);
      process.env[JEV_SHADOW_ENV] = "off";
      const killed = await run(["route", ...routeArgs(usageFile0(), ["--task", FIXTURE_TASK])]);
      expect(killed.exitCode).toBe(0);
      expect(killed.output).toBe(disabled.output);
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = savedFetch;
    }
    function usageFile0(): string {
      return writeJson("usage0.json", usageFixture());
    }
  });
});

describe("shadow on: records descriptors, never changes the decision", () => {
  it("records the Jev descriptor beside the supplied one (recorded)", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const policy = cloneDefault();
    policy.jev = { shadow: { enabled: true } };
    policy.kinds.ship.medium.candidates = [
      { harness: "claude", provider: "claude", model: "sonnet" },
    ];
    policy.kinds.ship.easy.candidates = [
      { harness: "codex", provider: "codex", model: "gpt" },
    ];
    writePolicy(policy);
    const usageFile = writeJson("usage.json", usageFixture());
    const recorded = jevFixture("classify-success.json");
    const calls: CapturedCall[] = [];

    const withShadow = await routeCommand(routeArgs(usageFile, ["--task", FIXTURE_TASK]), {
      fetchImpl: stubFetch(calls, () => jsonResponse(200, recorded.response)),
    });
    expect(calls).toHaveLength(1);

    rmSync(join(dir, "state"), { recursive: true, force: true });
    const withoutShadow = await routeCommand(routeArgs(usageFile), {
      fetchImpl: stubFetch([], () => {
        throw new Error("must not be called");
      }),
    });
    expect(withShadow).toBe(withoutShadow);

    const rows = readLedgerRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.kind).toBe("shadow");
    if (row?.kind !== "shadow") throw new Error("expected a shadow row");
    expect(row.status).toBe("recorded");
    expect(row.supplied).toEqual({ kind: "ship", difficulty: "medium", surface: "backend" });
    expect(row.jev).toMatchObject({
      source: "jev",
      model: "jev-1.13.0",
      kind: "ship",
      difficulty: "easy",
      surface: "backend",
    });
    expect(row.agreement).toEqual({ kind: true, difficulty: false, surface: true, all: false });
    expect(row.decision).toEqual({ harness: "claude", model: "sonnet", effort: "medium" });
    expect(row.jevDecision).toEqual({ harness: "codex", model: "gpt", effort: "low" });
    expect(row.routeAgreement).toBe(false);
    expect(JSON.stringify(row)).not.toContain(SENTINEL_KEY);
  });

  it("reports route agreement true when the Jev descriptor picks the same lane winner", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const policy = singleCandidatePolicy();
    policy.jev = { shadow: { enabled: true } };
    writePolicy(policy);
    const usageFile = writeJson("usage.json", usageFixture());
    const calls: CapturedCall[] = [];

    await routeCommand(routeArgs(usageFile, ["--task", FIXTURE_TASK]), {
      fetchImpl: stubFetch(calls, () => jsonResponse(200, jevResponse("ship", "medium", "backend"))),
    });
    const rows = readLedgerRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row?.kind !== "shadow") throw new Error("expected a shadow row");
    expect(row.status).toBe("recorded");
    expect(row.agreement).toEqual({ kind: true, difficulty: true, surface: true, all: true });
    expect(row.routeAgreement).toBe(true);
  });

  it("keeps --flags byte-identical with shadow on", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const policy = singleCandidatePolicy();
    policy.jev = { shadow: { enabled: true } };
    writePolicy(policy);
    const usageFile = writeJson("usage.json", usageFixture());

    const flags = await routeCommand(
      ["--kind", "ship", "--difficulty", "medium", "--usage-json", usageFile, "--now", String(NOW), "--flags", "--task", FIXTURE_TASK],
      { fetchImpl: stubFetch([], () => jsonResponse(200, jevResponse("ship", "medium", "backend"))) },
    );
    expect(flags).toBe("--harness claude --model sonnet --effort medium");
    expect(readLedgerRows()).toHaveLength(1);
  });

  it("leaves the persisted routing state untouched by the Jev preview", async () => {
    const policy = singleCandidatePolicy();
    policy.jev = { shadow: { enabled: true } };
    const usageFile = writeJson("usage.json", usageFixture());
    const stateFile = join(dir, "state", "llm-router-axi", "dispatch-routing.json");
    mkdirSync(join(dir, "state", "llm-router-axi"), { recursive: true });
    const seed = {
      version: 1,
      sequence: 7,
      lastSelected: { claude: NOW - 10 },
      profileLastSelected: {},
      cooldowns: {},
    };
    writeFileSync(stateFile, JSON.stringify(seed));
    process.env.LLM_ROUTER_STATE_FILE = stateFile;
    const before = readFileSync(stateFile, "utf8");

    await runRouteShadow(
      {
        policy,
        kind: "ship",
        difficulty: "medium",
        surface: "backend",
        taskRaw: FIXTURE_TASK,
        usageJson: usageFile,
        now: NOW,
        decision: { harness: "claude", model: "sonnet", effort: "medium" },
      },
      {},
    );

    expect(readFileSync(stateFile, "utf8")).toBe(before);
    const rows = readLedgerRows();
    expect(rows).toHaveLength(1);
    if (rows[0]?.kind !== "shadow") throw new Error("expected a shadow row");
    expect(rows[0].status).toBe("fallback");
  });
});

describe("shadow on: silent degradation (401, timeout, 529, no key)", () => {
  async function baseline(): Promise<string> {
    writePolicy(singleCandidatePolicy());
    const usageFile = writeJson("usage-base.json", usageFixture());
    return routeCommand(routeArgs(usageFile), {
      fetchImpl: stubFetch([], () => {
        throw new Error("must not be called");
      }),
    });
  }

  async function enableShadow(): Promise<string> {
    const policy = singleCandidatePolicy();
    policy.jev = { shadow: { enabled: true } };
    writePolicy(policy);
    return writeJson("usage.json", usageFixture());
  }

  it("degrades to fallback on 401 with no key leak", async () => {
    const expected = await baseline();
    const usageFile = await enableShadow();
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const calls: CapturedCall[] = [];

    const output = await routeCommand(routeArgs(usageFile, ["--task", FIXTURE_TASK]), {
      fetchImpl: stubFetch(calls, () => jsonResponse(401, { error: "bad key" })),
    });
    expect(calls).toHaveLength(1);
    expect(output).toBe(expected);
    expect(process.exitCode ?? 0).toBe(0);

    const rows = readLedgerRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row?.kind !== "shadow") throw new Error("expected a shadow row");
    expect(row.status).toBe("fallback");
    expect(row.jev?.source).toBe("fallback");
    expect(row.agreement).not.toBeNull();
    expect(output).not.toContain(SENTINEL_KEY);
    expect(readFileSync(ledgerFile, "utf8")).not.toContain(SENTINEL_KEY);
  });

  it("degrades to fallback on timeout within the caller's budget", async () => {
    const expected = await baseline();
    const usageFile = await enableShadow();
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;

    const started = Date.now();
    const output = await routeCommand(routeArgs(usageFile, ["--task", FIXTURE_TASK]), {
      fetchImpl: hangingFetch(),
      timeoutMs: 20,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(output).toBe(expected);

    const rows = readLedgerRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row?.kind !== "shadow") throw new Error("expected a shadow row");
    expect(row.status).toBe("fallback");
    expect(row.reason).toContain("timed out");
  });

  it("degrades to fallback after the bounded retry on persistent 529", async () => {
    const expected = await baseline();
    const usageFile = await enableShadow();
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const calls: CapturedCall[] = [];

    const output = await routeCommand(routeArgs(usageFile, ["--task", FIXTURE_TASK]), {
      fetchImpl: stubFetch(calls, () =>
        jsonResponse(529, { error: "overloaded" }, { "retry-after": "0" }),
      ),
    });
    expect(calls).toHaveLength(2);
    expect(output).toBe(expected);

    const rows = readLedgerRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row?.kind !== "shadow") throw new Error("expected a shadow row");
    expect(row.status).toBe("fallback");
    expect(row.jev?.source).toBe("fallback");
  });

  it("uses the heuristic fallback with no key and makes zero network calls", async () => {
    const expected = await baseline();
    const usageFile = await enableShadow();
    const calls: CapturedCall[] = [];

    const output = await routeCommand(routeArgs(usageFile, ["--task", FIXTURE_TASK]), {
      fetchImpl: stubFetch(calls, () => jsonResponse(200, jevResponse("ship", "medium", "backend"))),
    });
    expect(calls).toHaveLength(0);
    expect(output).toBe(expected);

    const rows = readLedgerRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row?.kind !== "shadow") throw new Error("expected a shadow row");
    expect(row.status).toBe("fallback");
    expect(row.reason).toContain("TYPESAFE_API_KEY");
  });

  it("records a refusal without changing its exit code", async () => {
    writePolicy(singleCandidatePolicy());
    process.env.LLM_ROUTER_USAGE_AXI = join(dir, "missing-usage-axi");
    const policy = singleCandidatePolicy();
    policy.jev = { shadow: { enabled: true } };
    writePolicy(policy);
    process.exitCode = 0;
    let output = "";
    await main({
      argv: ["route", "--kind", "ship", "--difficulty", "medium", "--task", FIXTURE_TASK],
      stdout: {
        write: (chunk: string) => {
          output += chunk;
          return true;
        },
      },
    });
    expect(process.exitCode).toBe(1);
    expect(output).toContain("NO_ELIGIBLE_CANDIDATE");
    const rows = readLedgerRows();
    expect(rows).toHaveLength(1);
    if (rows[0]?.kind !== "shadow") throw new Error("expected a shadow row");
    expect(rows[0].status).toBe("fallback");
    expect(rows[0].decision).toBeNull();
    expect(rows[0].routeAgreement).toBeNull();
  });
});

describe("record ledger", () => {
  it("appends the outcome without changing the receipt", async () => {
    const receipt = await recordCommand([
      "--provider",
      "cursor",
      "--outcome",
      "rate_limit",
      "--task",
      "t-42",
      "--json",
    ]);
    const parsed = JSON.parse(receipt) as { provider: string; outcome: string; task: string };
    expect(parsed.provider).toBe("cursor");
    expect(parsed.outcome).toBe("rate_limit");
    expect(parsed.task).toBe("t-42");

    const rows = readLedgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      v: 1,
      kind: "outcome",
      at: expect.any(Number),
      task: "t-42",
      provider: "cursor",
      outcome: "rate_limit",
    });
  });

  it("reads old entries: skips malformed, unknown, and future rows", async () => {
    writeFileSync(
      ledgerFile,
      [
        JSON.stringify({ v: 1, kind: "outcome", at: 10, task: "old", provider: "cursor", outcome: "ok" }),
        JSON.stringify({ v: 1, kind: "shadow", at: 11, supplied: { kind: "ship", difficulty: "medium" }, status: "recorded" }),
        "not json at all",
        JSON.stringify({ v: 1, kind: "mystery", at: 12 }),
        JSON.stringify({ v: 2, kind: "outcome", at: 13, task: "new", provider: "x", outcome: "ok" }),
        "",
      ].join("\n"),
    );

    await recordCommand(["--provider", "cursor", "--outcome", "rate_limit", "--task", "t-42"]);
    const rows = readLedgerRows();
    expect(rows).toHaveLength(3);

    const report = buildShadowReport(rows);
    expect(report.window).toMatchObject({ entries: 3, shadow: 1, outcomes: 2 });
    expect(report.descriptorAgreement.n).toBe(0);
    expect(report.outcomes).toMatchObject({ ok: 1, rate_limit: 1, total: 2, rateLimitRate: 0.5 });
    for (const criterion of report.goCriteria) {
      expect(criterion.met).toBeNull();
    }
  });

  it("never fails when the ledger is unwritable", async () => {
    process.env[SHADOW_FILE_ENV] = dir;
    const receipt = await recordCommand([
      "--provider",
      "cursor",
      "--outcome",
      "ok",
      "--task",
      "t-1",
      "--json",
    ]);
    expect(JSON.parse(receipt).outcome).toBe("ok");

    const policy = singleCandidatePolicy();
    policy.jev = { shadow: { enabled: true } };
    writePolicy(policy);
    const usageFile = writeJson("usage.json", usageFixture());
    const output = await routeCommand(routeArgs(usageFile, ["--task", FIXTURE_TASK]));
    expect(JSON.parse(output).harness).toBe("claude");
  });
});

describe("shadow report", () => {
  function seedReportLedger(): void {
    for (let i = 0; i < 9; i++) {
      appendLedgerRow({
        v: 1,
        kind: "shadow",
        at: 100 + i,
        supplied: { kind: "ship", difficulty: "medium", surface: "backend" },
        jev: {
          source: "jev",
          kind: "ship",
          difficulty: "medium",
          surface: "backend",
          reasoningClass: "code-gen",
          riskClass: "medium",
          toolAffinity: "none",
        },
        agreement: { kind: true, difficulty: true, surface: true, all: true },
        decision: { harness: "claude", model: "sonnet", effort: "medium" },
        jevDecision: { harness: "claude", model: "sonnet", effort: "medium" },
        routeAgreement: true,
        status: "recorded",
      });
    }
    appendLedgerRow({
      v: 1,
      kind: "shadow",
      at: 200,
      supplied: { kind: "ship", difficulty: "medium", surface: "backend" },
      jev: {
        source: "jev",
        kind: "review",
        difficulty: "hard",
        surface: "docs",
        reasoningClass: "review",
        riskClass: "low",
        toolAffinity: "none",
      },
      agreement: { kind: false, difficulty: false, surface: false, all: false },
      decision: { harness: "claude", model: "sonnet", effort: "medium" },
      jevDecision: { harness: "grok", effort: "high" },
      routeAgreement: false,
      status: "recorded",
    });
    appendLedgerRow({
      v: 1,
      kind: "shadow",
      at: 201,
      supplied: { kind: "ship", difficulty: "medium", surface: null },
      jev: {
        source: "fallback",
        reason: "no key; using heuristic fallback",
        kind: "ship",
        difficulty: "medium",
        surface: "mixed",
        reasoningClass: "code-gen",
        riskClass: "medium",
        toolAffinity: "none",
      },
      agreement: { kind: true, difficulty: true, surface: null, all: true },
      decision: { harness: "claude", model: "sonnet", effort: "medium" },
      jevDecision: { harness: "claude", model: "sonnet", effort: "medium" },
      routeAgreement: true,
      status: "fallback",
    });
    for (let i = 0; i < 95; i++) {
      appendLedgerRow({ v: 1, kind: "outcome", at: 300 + i, task: `t-${i}`, provider: "cursor", outcome: "ok" });
    }
    for (let i = 0; i < 5; i++) {
      appendLedgerRow({ v: 1, kind: "outcome", at: 400 + i, task: `r-${i}`, provider: "cursor", outcome: "rate_limit" });
    }
  }

  it("summarises agreement and outcomes with the go criteria as data", async () => {
    seedReportLedger();
    const output = await shadowCommand(["report", "--json"]);
    const report = JSON.parse(output) as ShadowReport;

    expect(Object.keys(report).sort()).toEqual(
      ["descriptorAgreement", "goCriteria", "note", "outcomes", "routeAgreement", "window"].sort(),
    );
    expect(report.window).toMatchObject({
      entries: 111,
      shadow: 11,
      outcomes: 100,
      recorded: 10,
      fallback: 1,
      skipped: 0,
    });
    expect(report.window.since).toBe(100);
    expect(report.window.until).toBe(404);
    expect(report.descriptorAgreement.n).toBe(10);
    expect(report.descriptorAgreement.fallbackRows).toBe(1);
    expect(report.descriptorAgreement.all).toEqual({ agree: 9, total: 10, rate: 0.9 });
    expect(report.descriptorAgreement.surface).toEqual({ agree: 9, total: 10, rate: 0.9 });
    expect(report.routeAgreement).toEqual({ n: 10, agree: 9, total: 10, rate: 0.9 });
    expect(report.outcomes).toEqual({ ok: 95, rate_limit: 5, total: 100, rateLimitRate: 0.05 });

    const [descriptor, route, rate] = report.goCriteria;
    expect(descriptor?.threshold).toContain("0.85");
    expect(descriptor).toMatchObject({ observed: 0.9, tasks: 10, met: true });
    expect(route?.threshold).toContain("0.90");
    expect(route).toMatchObject({ observed: 0.9, tasks: 10, met: true });
    expect(rate?.threshold).toContain("100+");
    expect(rate).toMatchObject({ observed: 0.05, tasks: 100, met: null });
    expect(report.note).toBe(JEV_FREEZE);
    expect(output).not.toContain(SENTINEL_KEY);
  });

  it("reports an empty window with zeros and undecided criteria (exit 0)", async () => {
    const { output, exitCode } = await run(["shadow", "report", "--json"]);
    expect(exitCode).toBe(0);
    const report = JSON.parse(output) as ShadowReport;
    expect(report.window).toMatchObject({ entries: 0, shadow: 0, outcomes: 0 });
    expect(report.window.since).toBeNull();
    expect(report.descriptorAgreement.all.rate).toBeNull();
    expect(report.routeAgreement.rate).toBeNull();
    expect(report.outcomes.rateLimitRate).toBeNull();
    for (const criterion of report.goCriteria) {
      expect(criterion.met).toBeNull();
      expect(criterion.observed).toBeNull();
    }
    expect(report.note).toContain("captain says go");
  });

  it("prints TOON by default and lists shadow in top-level help", async () => {
    seedReportLedger();
    const { output, exitCode } = await run(["shadow", "report"]);
    expect(exitCode).toBe(0);
    expect(output).toContain("shadow");

    const help = await run(["--help"]);
    expect(help.output).toContain("shadow report");
  });

  it("refuses unknown subcommands and flags without leaking values", async () => {
    const unknown = await run(["shadow", "bogus"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.output).toContain("unknown shadow subcommand");

    const flag = await run(["shadow", "report", `--api-key=${SENTINEL_KEY}`]);
    expect(flag.exitCode).toBe(2);
    expect(flag.output).toContain("unknown flag --api-key ");
    expect(flag.output).not.toContain(SENTINEL_KEY);
  });
});

describe("help freeze and key hygiene", () => {
  it("states the routing freeze in route, record, and shadow help", async () => {
    for (const argv of [["route", "--help"], ["record", "--help"], ["shadow", "--help"], ["shadow", "report", "--help"]]) {
      const { output, exitCode } = await run(argv);
      expect(exitCode).toBe(0);
      expect(output).toContain(JEV_FREEZE);
    }
  });

  it("never echoes a --api-key value in route or record errors", async () => {
    const routed = await run(["route", `--api-key=${SENTINEL_KEY}`, "--kind", "ship"]);
    expect(routed.exitCode).toBe(2);
    expect(routed.output).toContain("unknown flag --api-key ");
    expect(routed.output).not.toContain(SENTINEL_KEY);

    const recorded = await run(["record", `--api-key=${SENTINEL_KEY}`]);
    expect(recorded.exitCode).toBe(2);
    expect(recorded.output).toContain("unknown flag --api-key ");
    expect(recorded.output).not.toContain(SENTINEL_KEY);
  });
});
