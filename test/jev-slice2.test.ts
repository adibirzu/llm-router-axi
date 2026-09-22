/**
 * Slice 2 (Jev triage + pick) tests.
 *
 * No live key, no network: every Jev-path test injects a stub `fetch`
 * that replays the recorded documents in `test/fixtures/jev/`. Run this
 * suite on its own (`npx vitest run test/jev-slice2.test.ts`) like every
 * other suite on this host.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { pickCommand } from "../src/commands/pick.js";
import { triageCommand } from "../src/commands/triage.js";
import { type FetchImpl } from "../src/jev/client.js";
import {
  heuristicPick,
  isPickResult,
  PICK_REASON_VALUES,
  validatePickCandidates,
  type PickResult,
} from "../src/jev/pick.js";
import { classifyEvidence } from "../src/selector.js";
import {
  heuristicTriage,
  isTriageResult,
  TRIAGE_DEFECT_VALUES,
  type TriageResult,
} from "../src/jev/triage.js";

const SENTINEL_KEY = "SENTINEL-JEV-KEY-9f8e7d6c5b4a";
const CANDIDATES = ["opencode:opencode-go/qwen3.8-flash", "claude:claude-opus"];
const TRIAGE_EVIDENCE = "failed: request failed with status code 429";
const PICK_TASK = "Fix the login retry bug in api/auth.py: exponential backoff overshoots after 3 attempts";

function fixture(name: string): any {
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

function replay(body: unknown, status = 200): Response {
  return jsonResponse(status, body);
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

let savedKey: string | undefined;
let savedBaseUrl: string | undefined;

beforeEach(() => {
  savedKey = process.env.TYPESAFE_API_KEY;
  savedBaseUrl = process.env.TYPESAFE_BASE_URL;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_BASE_URL;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = savedKey;
  if (savedBaseUrl === undefined) delete process.env.TYPESAFE_BASE_URL;
  else process.env.TYPESAFE_BASE_URL = savedBaseUrl;
});

describe("triage (Jev path and fallback share one schema)", () => {
  it("returns source jev from the recorded fixture with typed booleans", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const recorded = fixture("triage-success.json");
    const calls: CapturedCall[] = [];
    const output = await triageCommand(["--evidence", TRIAGE_EVIDENCE, "--json"], {
      fetchImpl: stubFetch(calls, () => replay(recorded.response)),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((calls[0]?.init.headers as Record<string, string>)["Authorization"]).toBe(
      `Bearer ${SENTINEL_KEY}`,
    );
    const sent = JSON.parse(calls[0]?.init.body as string);
    expect(sent.state).toBe(TRIAGE_EVIDENCE);
    expect(Object.keys(sent.questions).sort()).toEqual(["defect", "needsHuman", "retryable"]);

    const parsed = JSON.parse(output) as TriageResult;
    expect(isTriageResult(parsed)).toBe(true);
    expect(parsed.source).toBe("jev");
    expect(parsed.model).toBe("jev-1.13.0");
    expect(parsed.reason).toBeUndefined();
    expect(parsed.defect).toMatchObject({ value: "rate_limit", heuristic: false });
    expect(parsed.retryable).toMatchObject({ value: true, probability: 0.85, heuristic: false });
    expect(parsed.needsHuman).toMatchObject({ value: false, probability: 0.88, heuristic: false });
    expect(output).not.toContain(SENTINEL_KEY);
  });

  it("proves fallback parity: both paths validate against the same schema", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const recorded = fixture("triage-success.json");
    const jevOutput = await triageCommand(["--evidence", TRIAGE_EVIDENCE, "--json"], {
      fetchImpl: stubFetch([], () => replay(recorded.response)),
    });
    delete process.env.TYPESAFE_API_KEY;
    const fallbackOutput = await triageCommand(["--evidence", TRIAGE_EVIDENCE, "--json"]);

    const jev = JSON.parse(jevOutput) as TriageResult;
    const fallback = JSON.parse(fallbackOutput) as TriageResult;
    expect(isTriageResult(jev)).toBe(true);
    expect(isTriageResult(fallback)).toBe(true);
    expect(jev.source).toBe("jev");
    expect(fallback.source).toBe("fallback");
    expect(typeof fallback.reason).toBe("string");
    expect(fallback.defect.heuristic).toBe(true);
    expect(fallback.retryable.heuristic).toBe(true);
    expect(fallback.needsHuman.heuristic).toBe(true);
  });

  it("falls back with a reason when there is no key, and makes no network call", async () => {
    let called = false;
    const output = await triageCommand(["--evidence", TRIAGE_EVIDENCE, "--json"], {
      fetchImpl: stubFetch([], () => {
        called = true;
        return replay({});
      }),
    });
    expect(called).toBe(false);
    const parsed = JSON.parse(output) as TriageResult;
    expect(parsed.source).toBe("fallback");
    expect(parsed.reason).toContain("TYPESAFE_API_KEY");
    expect(parsed.defect.value).toBe("rate_limit");
  });

  it("falls back with source fallback on 401, leaking no key", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const output = await triageCommand(["--evidence", TRIAGE_EVIDENCE, "--json"], {
      fetchImpl: stubFetch([], () => jsonResponse(401, { error: "bad key" })),
    });
    const parsed = JSON.parse(output) as TriageResult;
    expect(parsed.source).toBe("fallback");
    expect(parsed.reason).toContain("using heuristic fallback");
    expect(isTriageResult(parsed)).toBe(true);
    expect(output).not.toContain(SENTINEL_KEY);
  });

  it("falls back after the bounded retry on persistent 529", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const calls: CapturedCall[] = [];
    const output = await triageCommand(["--evidence", TRIAGE_EVIDENCE, "--json"], {
      fetchImpl: stubFetch(calls, () =>
        jsonResponse(529, { error: "overloaded" }, { "retry-after": "0" }),
      ),
    });
    expect(calls).toHaveLength(2);
    const parsed = JSON.parse(output) as TriageResult;
    expect(parsed.source).toBe("fallback");
    expect(parsed.reason).toContain("overloaded");
    expect(isTriageResult(parsed)).toBe(true);
    expect(output).not.toContain(SENTINEL_KEY);
  });

  it("falls back with source fallback on timeout", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const output = await triageCommand(["--evidence", TRIAGE_EVIDENCE, "--json"], {
      fetchImpl: hangingFetch(),
      timeoutMs: 15,
    });
    const parsed = JSON.parse(output) as TriageResult;
    expect(parsed.source).toBe("fallback");
    expect(parsed.reason).toContain("timed out");
    expect(isTriageResult(parsed)).toBe(true);
    expect(output).not.toContain(SENTINEL_KEY);
  });

  it("falls back with a confidence reason below the documented threshold", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const recorded = fixture("triage-low-confidence.json");
    const output = await triageCommand(["--evidence", "something odd happened", "--json"], {
      fetchImpl: stubFetch([], () => replay(recorded.response)),
    });
    const parsed = JSON.parse(output) as TriageResult;
    expect(parsed.source).toBe("fallback");
    expect(parsed.reason).toContain("confidence");
    expect(isTriageResult(parsed)).toBe(true);
  });

  it("reads evidence from a file and includes probabilities only with --full on the Jev path", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const recorded = fixture("triage-success.json");
    const dir = mkdtempSync(join(tmpdir(), "jev-triage-"));
    try {
      const file = join(dir, "worker.status");
      writeFileSync(file, TRIAGE_EVIDENCE);
      const stub = () => stubFetch([], () => replay(recorded.response));
      const plain = JSON.parse(
        await triageCommand(["--evidence", file, "--json"], { fetchImpl: stub() }),
      ) as TriageResult;
      expect(plain.defect).not.toHaveProperty("probabilities");
      expect(plain).not.toHaveProperty("latencyMs");

      const full = JSON.parse(
        await triageCommand(["--evidence", file, "--json", "--full"], { fetchImpl: stub() }),
      ) as Record<string, unknown>;
      expect(full).toHaveProperty("latencyMs");
      expect(full.defect as Record<string, unknown>).toHaveProperty("probabilities");

      delete process.env.TYPESAFE_API_KEY;
      const fallbackFull = JSON.parse(
        await triageCommand(["--evidence", file, "--json", "--full"]),
      ) as Record<string, unknown>;
      expect(fallbackFull).toHaveProperty("latencyMs");
      expect(fallbackFull.defect as Record<string, unknown>).not.toHaveProperty("probabilities");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints TOON by default with source and every field", async () => {
    const output = await triageCommand(["--evidence", TRIAGE_EVIDENCE]);
    expect(output).toContain("source: fallback");
    expect(output).toContain("defect");
    expect(output).toContain("retryable");
    expect(output).toContain("needsHuman");
  });
});

describe("triage fallback vocabulary (never contradicts classify-evidence)", () => {
  const cases: Array<{ evidence: string; defect: string }> = [
    { evidence: "failed: request failed with status code 429", defect: "rate_limit" },
    { evidence: "Rate limit exceeded, too many requests", defect: "rate_limit" },
    { evidence: "insufficient quota: monthly allowance exhausted", defect: "quota_exhausted" },
    { evidence: "RESOURCE_EXHAUSTED: credit balance is too low", defect: "quota_exhausted" },
    { evidence: "request failed with 401: invalid API key", defect: "auth" },
    { evidence: "region not supported: unavailable in your country", defect: "region_refused" },
    { evidence: "exit status 1: FAIL api/auth_test.go", defect: "test_failure" },
    { evidence: "request timed out after 30s: deadline exceeded", defect: "timeout" },
    { evidence: "tool failed with exit code 127: command not found", defect: "tool_error" },
    { evidence: "the widget sprocketed unexpectedly", defect: "unknown" },
  ];

  it.each(cases)("maps $evidence to $defect", ({ evidence, defect }) => {
    expect(heuristicTriage(evidence, "test").defect.value).toBe(defect);
  });

  it("maps every classify-evidence depletion to rate_limit|quota_exhausted", () => {
    const depleted = [
      "failed: request failed with status code 429",
      "rate limit hit on the cursor provider",
      "RESOURCE_EXHAUSTED for the project",
      "insufficient quota: out of credits",
      "subscription allowance exhausted for the week",
      "credit balance is too low",
    ];
    for (const evidence of depleted) {
      expect(classifyEvidence(evidence)).not.toBeNull();
      const defect = heuristicTriage(evidence, "test").defect.value;
      expect(["rate_limit", "quota_exhausted"]).toContain(defect);
    }
  });

  it("rejects out-of-schema results", () => {
    expect(isTriageResult({ source: "jev" })).toBe(false);
    expect(
      isTriageResult({
        source: "jev",
        defect: { value: "meltdown", confidence: 0.9, heuristic: false },
        retryable: { value: true, probability: 0.9, heuristic: false },
        needsHuman: { value: false, probability: 0.9, heuristic: false },
      }),
    ).toBe(false);
    expect(
      isTriageResult({
        source: "fallback",
        reason: "x",
        defect: { value: "timeout", confidence: 0.35, heuristic: true },
        retryable: { value: "yes", probability: 0.75, heuristic: true },
        needsHuman: { value: false, probability: 0.7, heuristic: true },
      }),
    ).toBe(false);
    for (const defect of TRIAGE_DEFECT_VALUES) {
      const result = heuristicTriage("failed: request failed with status code 429", "test");
      expect(isTriageResult({ ...result, defect: { ...result.defect, value: defect } })).toBe(true);
    }
  });
});

describe("pick (Jev path and fallback share one schema)", () => {
  function pickArgs(task: string = PICK_TASK): string[] {
    return ["--task", task, ...CANDIDATES.flatMap((name) => ["--candidate", name])];
  }

  it("returns source jev from the recorded fixture with a full ranking", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const recorded = fixture("pick-success.json");
    const calls: CapturedCall[] = [];
    const output = await pickCommand([...pickArgs(), "--json"], {
      fetchImpl: stubFetch(calls, () => replay(recorded.response)),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    const sent = JSON.parse(calls[0]?.init.body as string);
    expect(sent.state).toBe(PICK_TASK);
    expect(Object.keys(sent.questions).sort()).toEqual(["reason", "selection"]);

    const parsed = JSON.parse(output) as PickResult;
    expect(isPickResult(parsed)).toBe(true);
    expect(parsed.source).toBe("jev");
    expect(parsed.model).toBe("jev-1.13.0");
    expect(parsed.reason).toBeUndefined();
    expect(parsed.choice).toBe("opencode:opencode-go/qwen3.8-flash");
    expect(parsed.ranking.map((entry) => entry.candidate).sort()).toEqual([...CANDIDATES].sort());
    expect(parsed.ranking[0]?.candidate).toBe("opencode:opencode-go/qwen3.8-flash");
    const total = parsed.ranking.reduce((sum, entry) => sum + entry.probability, 0);
    expect(total).toBeCloseTo(1, 5);
    expect(parsed.reasons).toEqual(["model-judgment"]);
    expect(output).not.toContain(SENTINEL_KEY);
  });

  it("proves fallback parity: both paths validate against the same schema", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const recorded = fixture("pick-success.json");
    const jevOutput = await pickCommand([...pickArgs(), "--json"], {
      fetchImpl: stubFetch([], () => replay(recorded.response)),
    });
    delete process.env.TYPESAFE_API_KEY;
    const fallbackOutput = await pickCommand([...pickArgs(), "--json"]);

    const jev = JSON.parse(jevOutput) as PickResult;
    const fallback = JSON.parse(fallbackOutput) as PickResult;
    expect(isPickResult(jev)).toBe(true);
    expect(isPickResult(fallback)).toBe(true);
    expect(jev.source).toBe("jev");
    expect(fallback.source).toBe("fallback");
    expect(typeof fallback.reason).toBe("string");
  });

  it("falls back with a reason when there is no key, and makes no network call", async () => {
    let called = false;
    const output = await pickCommand([...pickArgs(), "--json"], {
      fetchImpl: stubFetch([], () => {
        called = true;
        return replay({});
      }),
    });
    expect(called).toBe(false);
    const parsed = JSON.parse(output) as PickResult;
    expect(parsed.source).toBe("fallback");
    expect(parsed.reason).toContain("TYPESAFE_API_KEY");
    expect(isPickResult(parsed)).toBe(true);
  });

  it("falls back with source fallback on 401, leaking no key", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const output = await pickCommand([...pickArgs(), "--json"], {
      fetchImpl: stubFetch([], () => jsonResponse(401, { error: "bad key" })),
    });
    const parsed = JSON.parse(output) as PickResult;
    expect(parsed.source).toBe("fallback");
    expect(parsed.reason).toContain("using heuristic fallback");
    expect(isPickResult(parsed)).toBe(true);
    expect(output).not.toContain(SENTINEL_KEY);
  });

  it("falls back after the bounded retry on persistent 529", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const calls: CapturedCall[] = [];
    const output = await pickCommand([...pickArgs(), "--json"], {
      fetchImpl: stubFetch(calls, () =>
        jsonResponse(529, { error: "overloaded" }, { "retry-after": "0" }),
      ),
    });
    expect(calls).toHaveLength(2);
    const parsed = JSON.parse(output) as PickResult;
    expect(parsed.source).toBe("fallback");
    expect(parsed.reason).toContain("overloaded");
    expect(isPickResult(parsed)).toBe(true);
    expect(output).not.toContain(SENTINEL_KEY);
  });

  it("falls back with source fallback on timeout", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const output = await pickCommand([...pickArgs(), "--json"], {
      fetchImpl: hangingFetch(),
      timeoutMs: 15,
    });
    const parsed = JSON.parse(output) as PickResult;
    expect(parsed.source).toBe("fallback");
    expect(parsed.reason).toContain("timed out");
    expect(isPickResult(parsed)).toBe(true);
    expect(output).not.toContain(SENTINEL_KEY);
  });

  it("falls back with a confidence reason below the documented threshold", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const recorded = fixture("pick-low-confidence.json");
    const output = await pickCommand([...pickArgs(), "--json"], {
      fetchImpl: stubFetch([], () => replay(recorded.response)),
    });
    const parsed = JSON.parse(output) as PickResult;
    expect(parsed.source).toBe("fallback");
    expect(parsed.reason).toContain("confidence");
    expect(isPickResult(parsed)).toBe(true);
  });

  it("prints TOON by default and latencyMs only with --full", async () => {
    const plain = JSON.parse(await pickCommand([...pickArgs(), "--json"])) as PickResult;
    expect(plain).not.toHaveProperty("latencyMs");
    const full = JSON.parse(await pickCommand([...pickArgs(), "--json", "--full"])) as Record<
      string,
      unknown
    >;
    expect(full).toHaveProperty("latencyMs");
    const toon = await pickCommand(pickArgs());
    expect(toon).toContain("source: fallback");
    expect(toon).toContain("choice");
  });
});

describe("pick candidates (validation and deterministic fallback)", () => {
  it("refuses unknown and duplicate candidates as validation errors", async () => {
    expect(validatePickCandidates([])).toEqual({
      error: "pick requires at least one --candidate <harness:model>",
    });
    expect(validatePickCandidates(["no-colon-here"])).toMatchObject({ error: expect.stringContaining("unknown candidate") });
    expect(validatePickCandidates([":model"])).toMatchObject({ error: expect.stringContaining("unknown candidate") });
    expect(validatePickCandidates(["harness:"])).toMatchObject({ error: expect.stringContaining("unknown candidate") });
    expect(validatePickCandidates(["a:m1", "a:m1"])).toMatchObject({
      error: expect.stringContaining("duplicate candidate"),
    });
    expect(validatePickCandidates(["a:m1", "b:m2"])).toEqual({ candidates: ["a:m1", "b:m2"] });

    for (const args of [
      ["--task", "x", "--candidate", "a:m1", "--candidate", "a:m1"],
      ["--task", "x", "--candidate", "bogus"],
      ["--task", "x"],
    ]) {
      await expect(pickCommand(args)).rejects.toThrow();
    }
  });

  it("picks by task-fit with ties broken by name, deterministically", () => {
    const keyword = heuristicPick("debug the opencode worker", ["zeta:zzz", "opencode:worker-x"], "test");
    expect(keyword.choice).toBe("opencode:worker-x");
    expect(keyword.reasons).toEqual(["keyword-match"]);

    const tie = heuristicPick("do the thing", ["b:m2", "a:m1"], "test");
    expect(tie.choice).toBe("a:m1");
    expect(tie.reasons).toEqual(["name-order"]);

    const single = heuristicPick("anything", ["solo:one"], "test");
    expect(single.choice).toBe("solo:one");
    expect(single.reasons).toEqual(["single-candidate"]);

    const again = heuristicPick("debug the opencode worker", ["zeta:zzz", "opencode:worker-x"], "test");
    expect(again).toEqual(keyword);
  });

  it("closed-enum reasons can never be free text", () => {
    const tasks = ["debug the opencode worker", "do the thing", "anything", "MIGRATE the DB with sql"];
    const lists = [["a:m1", "b:m2"], ["solo:one"], ["x:1", "y:2", "z:3"]];
    for (const task of tasks) {
      for (const list of lists) {
        const result = heuristicPick(task, list, "test");
        expect(result.reasons.length).toBeGreaterThan(0);
        for (const reason of result.reasons) {
          expect((PICK_REASON_VALUES as readonly string[])).toContain(reason);
        }
        expect(isPickResult(result)).toBe(true);
      }
    }
    const jevReasons = (fixture("pick-success.json").response.answers.reason as { choice: string }).choice;
    expect((PICK_REASON_VALUES as readonly string[])).toContain(jevReasons);
  });

  it("rejects out-of-schema results", () => {
    expect(isPickResult({ source: "jev" })).toBe(false);
    const base = heuristicPick("task", ["a:m1", "b:m2"], "test");
    expect(isPickResult({ ...base, choice: "c:m3" })).toBe(false);
    expect(isPickResult({ ...base, reasons: ["vibes"] })).toBe(false);
    expect(
      isPickResult({ ...base, ranking: base.ranking.map((entry) => ({ ...entry, probability: 0.9 })) }),
    ).toBe(false);
    expect(isPickResult({ ...base, ranking: [] })).toBe(false);
    expect(isPickResult(base)).toBe(true);
  });
});

describe("CLI surface (help, flags, key hygiene, read-only)", () => {
  let dir: string;
  let savedExitCode: number | undefined;
  let savedConfigHome: string | undefined;
  let savedStateHome: string | undefined;
  let savedStateFile: string | undefined;

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
    savedStateFile = process.env.LLM_ROUTER_STATE_FILE;
    process.exitCode = 0;
    dir = mkdtempSync(join(tmpdir(), "llm-router-axi-jev2-"));
    process.env.XDG_CONFIG_HOME = dir;
    process.env.XDG_STATE_HOME = join(dir, "state");
    process.env.LLM_ROUTER_USAGE_AXI = join(dir, "missing-usage-axi");
    process.env.LLM_ROUTER_STATE_FILE = join(dir, "state", "dispatch-routing.json");
  });

  afterEach(() => {
    process.exitCode = savedExitCode ?? 0;
    if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedConfigHome;
    if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedStateHome;
    if (savedStateFile === undefined) delete process.env.LLM_ROUTER_STATE_FILE;
    else process.env.LLM_ROUTER_STATE_FILE = savedStateFile;
    delete process.env.LLM_ROUTER_USAGE_AXI;
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists triage and pick in top-level help", async () => {
    const { output, exitCode } = await run(["--help"]);
    expect(exitCode).toBe(0);
    expect(output).toContain("triage");
    expect(output).toContain("pick");
  });

  it("triages and picks without a key through main (exit 0, no network)", async () => {
    const triage = await run(["triage", "--evidence", TRIAGE_EVIDENCE]);
    expect(triage.exitCode).toBe(0);
    expect(triage.output).toContain("source: fallback");

    const pick = await run([
      "pick",
      "--task",
      PICK_TASK,
      "--candidate",
      CANDIDATES[0] as string,
      "--candidate",
      CANDIDATES[1] as string,
    ]);
    expect(pick.exitCode).toBe(0);
    expect(pick.output).toContain("source: fallback");
  });

  it("triage and pick change no cooldown, record, or routing state", async () => {
    const stateFile = process.env.LLM_ROUTER_STATE_FILE as string;
    await run(["triage", "--evidence", TRIAGE_EVIDENCE]);
    await run([
      "pick",
      "--task",
      PICK_TASK,
      "--candidate",
      CANDIDATES[0] as string,
      "--candidate",
      CANDIDATES[1] as string,
    ]);
    expect(existsSync(stateFile)).toBe(false);
  });

  it("refuses unknown flags and missing inputs with exit 2", async () => {
    const unknown = await run(["triage", "--bogus"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.output).toContain("unknown flag --bogus");

    const missing = await run(["triage"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.output).toContain("--evidence");

    const pickMissing = await run(["pick", "--task", "x"]);
    expect(pickMissing.exitCode).toBe(2);
    expect(pickMissing.output).toContain("--candidate");

    const pickDuplicate = await run([
      "pick",
      "--task",
      "x",
      "--candidate",
      "a:m1",
      "--candidate",
      "a:m1",
    ]);
    expect(pickDuplicate.exitCode).toBe(2);
    expect(pickDuplicate.output).toContain("duplicate candidate");
  });

  it("never echoes an --api-key=<sentinel> value in triage or pick errors", async () => {
    const directTriage = await triageCommand([
      `--api-key=${SENTINEL_KEY}`,
      "--evidence",
      "x",
    ]).then(
      () => "no-throw",
      (error: unknown) => String((error as Error).message),
    );
    expect(directTriage).toContain("unknown flag --api-key ");
    expect(directTriage).not.toContain(SENTINEL_KEY);

    const directPick = await pickCommand([`--api-key=${SENTINEL_KEY}`, "--task", "x"]).then(
      () => "no-throw",
      (error: unknown) => String((error as Error).message),
    );
    expect(directPick).toContain("unknown flag --api-key ");
    expect(directPick).not.toContain(SENTINEL_KEY);

    const triage = await run(["triage", `--api-key=${SENTINEL_KEY}`, "--evidence", "x"]);
    expect(triage.exitCode).toBe(2);
    expect(triage.output).toContain("unknown flag --api-key ");
    expect(triage.output).not.toContain(SENTINEL_KEY);

    const pick = await run(["pick", `--api-key=${SENTINEL_KEY}`, "--task", "x"]);
    expect(pick.exitCode).toBe(2);
    expect(pick.output).toContain("unknown flag --api-key ");
    expect(pick.output).not.toContain(SENTINEL_KEY);
  });

  it("states the routing freeze verbatim in triage and pick --help", async () => {
    const freeze =
      "Nothing routes real traffic through Jev until the lab docs/when-to-route.md verdict exists and the captain says go";
    const triageHelp = await run(["triage", "--help"]);
    expect(triageHelp.exitCode).toBe(0);
    expect(triageHelp.output).toContain(freeze);

    const pickHelp = await run(["pick", "--help"]);
    expect(pickHelp.exitCode).toBe(0);
    expect(pickHelp.output).toContain(freeze);
  });
});
