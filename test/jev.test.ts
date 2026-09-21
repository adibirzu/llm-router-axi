/**
 * Slice 1 (Jev client + doctor + classify) tests.
 *
 * No live key, no network: every Jev-path test injects a stub `fetch`
 * that replays the recorded documents in `test/fixtures/jev/`. Run this
 * suite on its own (`npx vitest run test/jev.test.ts`) like every other
 * suite on this host.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { doctorCommand } from "../src/commands/doctor.js";
import { taskClassifyCommand } from "../src/commands/task-classify.js";
import {
  evaluateSystemOne,
  JevError,
  listModels,
  type FetchImpl,
} from "../src/jev/client.js";
import { isClassifyResult, type ClassifyResult } from "../src/jev/schema.js";

const SENTINEL_KEY = "SENTINEL-JEV-KEY-9f8e7d6c5b4a";
const FIXTURE_TASK = "Fix the login retry bug in api/auth.py: exponential backoff overshoots after 3 attempts";

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

describe("Jev client (documented HTTP contract)", () => {
  it("POSTs state/model/questions to /v1/systemone with a Bearer key", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const recorded = fixture("classify-success.json");
    const calls: CapturedCall[] = [];
    const fetchImpl = stubFetch(calls, () => replay(recorded.response));

    const response = await evaluateSystemOne(FIXTURE_TASK, recorded.request.questions, { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>)["Authorization"]).toBe(
      `Bearer ${SENTINEL_KEY}`,
    );
    const sent = JSON.parse(calls[0]?.init.body as string);
    expect(sent.state).toBe(FIXTURE_TASK);
    expect(sent.model).toBe("jev-latest");
    expect(sent.questions).toEqual(recorded.request.questions);
    expect(response.model).toBe("jev-1.13.0");
    expect(response.answers.kind).toMatchObject({ type: "choice", choice: "ship" });
    expect(response.usage).toEqual({ input_tokens: 512, output_tokens: 60 });
  });

  it("respects the TYPESAFE_BASE_URL override", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    process.env.TYPESAFE_BASE_URL = "https://stub.internal:8443/";
    const recorded = fixture("classify-success.json");
    const calls: CapturedCall[] = [];
    await evaluateSystemOne(FIXTURE_TASK, recorded.request.questions, {
      fetchImpl: stubFetch(calls, () => replay(recorded.response)),
    });
    expect(calls[0]?.url).toBe("https://stub.internal:8443/v1/systemone");
  });

  it("retries once on 429, then succeeds", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const recorded = fixture("classify-success.json");
    const calls: CapturedCall[] = [];
    const fetchImpl = stubFetch(calls, (_call, index) =>
      index === 0
        ? jsonResponse(429, { error: "rate limited" }, { "retry-after": "0" })
        : replay(recorded.response),
    );
    const response = await evaluateSystemOne(FIXTURE_TASK, recorded.request.questions, { fetchImpl });
    expect(calls).toHaveLength(2);
    expect(response.model).toBe("jev-1.13.0");
  });

  it("surfaces rate-limited after the bounded retry is spent", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const calls: CapturedCall[] = [];
    const fetchImpl = stubFetch(calls, () => jsonResponse(429, { error: "slow down" }));
    const error = await evaluateSystemOne("task", {
      kind: { type: "choice", instructions: "k?", criteria: { a: "A", b: "B" } },
    }, { fetchImpl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JevError);
    expect((error as JevError).kind).toBe("rate-limited");
    expect(calls).toHaveLength(2);
    expect(String((error as Error).message)).not.toContain(SENTINEL_KEY);
  });

  it("maps 401/422/timeout/network to typed errors that never carry the key", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const question = { kind: { type: "choice", instructions: "k?", criteria: { a: "A", b: "B" } } } as const;

    const auth = await evaluateSystemOne("t", { ...question }, {
      fetchImpl: stubFetch([], () => jsonResponse(401, { error: "bad key" })),
    }).catch((e: unknown) => e);
    expect((auth as JevError).kind).toBe("auth");

    const invalid = await evaluateSystemOne("t", { ...question }, {
      fetchImpl: stubFetch([], () => jsonResponse(422, { error: "bad body" })),
    }).catch((e: unknown) => e);
    expect((invalid as JevError).kind).toBe("validation");

    const hanging: FetchImpl = ((_input: any, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as FetchImpl;
    const timedOut = await evaluateSystemOne("t", { ...question }, {
      fetchImpl: hanging,
      timeoutMs: 15,
    }).catch((e: unknown) => e);
    expect((timedOut as JevError).kind).toBe("timeout");

    const unreachable = await evaluateSystemOne("t", { ...question }, {
      fetchImpl: (async () => {
        throw new Error("socket hang up");
      }) as FetchImpl,
    }).catch((e: unknown) => e);
    expect((unreachable as JevError).kind).toBe("network");

    for (const error of [auth, invalid, timedOut, unreachable]) {
      expect(String((error as Error).message)).not.toContain(SENTINEL_KEY);
      expect(JSON.stringify(error)).not.toContain(SENTINEL_KEY);
    }
  });

  it("refuses without a key before any network call", async () => {
    let called = false;
    const fetchImpl = stubFetch([], () => {
      called = true;
      return replay({});
    });
    const error = await evaluateSystemOne("t", {
      kind: { type: "choice", instructions: "k?", criteria: { a: "A", b: "B" } },
    }, { fetchImpl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JevError);
    expect((error as JevError).kind).toBe("missing-key");
    expect(called).toBe(false);
  });

  it("lists models with one GET to /v1/models", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const recorded = fixture("models-list.json");
    const calls: CapturedCall[] = [];
    const models = await listModels({
      fetchImpl: stubFetch(calls, () => replay(recorded.response)),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/models");
    expect(calls[0]?.init.method).toBe("GET");
    expect(models.map((m) => m.name)).toEqual(["jev-latest", "jev-preview"]);
  });
});

describe("classify (Jev path and fallback share one schema)", () => {
  function classifyFetch(responseBody: unknown, calls: CapturedCall[]): FetchImpl {
    return stubFetch(calls, () => replay(responseBody));
  }

  it("returns source jev from the recorded fixture", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const recorded = fixture("classify-success.json");
    const calls: CapturedCall[] = [];
    const output = await taskClassifyCommand(["--task", FIXTURE_TASK, "--json"], {
      fetchImpl: classifyFetch(recorded.response, calls),
    });
    expect(calls).toHaveLength(1);
    const parsed = JSON.parse(output) as ClassifyResult;
    expect(isClassifyResult(parsed)).toBe(true);
    expect(parsed.source).toBe("jev");
    expect(parsed.model).toBe("jev-1.13.0");
    expect(parsed.reason).toBeUndefined();
    expect(parsed.kind).toMatchObject({ value: "ship", heuristic: false });
    expect(parsed.difficulty).toMatchObject({ value: "easy", heuristic: false });
    expect(parsed.surface).toMatchObject({ value: "backend", heuristic: false });
    expect(parsed.reasoningClass.value).toBe("debug");
    expect(output).not.toContain(SENTINEL_KEY);
  });

  it("proves fallback parity: both paths validate against the same schema", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const recorded = fixture("classify-success.json");
    const jevOutput = await taskClassifyCommand(["--task", FIXTURE_TASK, "--json"], {
      fetchImpl: classifyFetch(recorded.response, []),
    });
    delete process.env.TYPESAFE_API_KEY;
    const fallbackOutput = await taskClassifyCommand(["--task", FIXTURE_TASK, "--json"]);

    const jev = JSON.parse(jevOutput) as ClassifyResult;
    const fallback = JSON.parse(fallbackOutput) as ClassifyResult;
    expect(isClassifyResult(jev)).toBe(true);
    expect(isClassifyResult(fallback)).toBe(true);
    expect(jev.source).toBe("jev");
    expect(fallback.source).toBe("fallback");
    expect(typeof fallback.reason).toBe("string");
    for (const field of [fallback.kind, fallback.difficulty, fallback.surface]) {
      expect(field.heuristic).toBe(true);
    }
  });

  it("falls back with a reason when there is no key, and makes no network call", async () => {
    let called = false;
    const output = await taskClassifyCommand(["--task", "Review the payments PR", "--json"], {
      fetchImpl: stubFetch([], () => {
        called = true;
        return replay({});
      }),
    });
    expect(called).toBe(false);
    const parsed = JSON.parse(output) as ClassifyResult;
    expect(parsed.source).toBe("fallback");
    expect(parsed.reason).toContain("TYPESAFE_API_KEY");
    expect(parsed.kind.value).toBe("review");
  });

  it("falls back with source fallback on 401, leaking no key", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const output = await taskClassifyCommand(["--task", FIXTURE_TASK, "--json"], {
      fetchImpl: stubFetch([], () => jsonResponse(401, { error: "bad key" })),
    });
    const parsed = JSON.parse(output) as ClassifyResult;
    expect(parsed.source).toBe("fallback");
    expect(parsed.reason).toContain("using heuristic fallback");
    expect(isClassifyResult(parsed)).toBe(true);
    expect(output).not.toContain(SENTINEL_KEY);
  });

  it("falls back after the bounded retry on persistent 529", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const calls: CapturedCall[] = [];
    const output = await taskClassifyCommand(["--task", FIXTURE_TASK, "--json"], {
      fetchImpl: stubFetch(calls, () =>
        jsonResponse(529, { error: "overloaded" }, { "retry-after": "0" }),
      ),
    });
    expect(calls).toHaveLength(2);
    const parsed = JSON.parse(output) as ClassifyResult;
    expect(parsed.source).toBe("fallback");
    expect(parsed.reason).toContain("overloaded");
    expect(isClassifyResult(parsed)).toBe(true);
    expect(output).not.toContain(SENTINEL_KEY);
  });

  it("falls back with source fallback on timeout", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const hanging: FetchImpl = ((_input: any, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as FetchImpl;
    const output = await taskClassifyCommand(["--task", FIXTURE_TASK, "--json"], {
      fetchImpl: hanging,
      timeoutMs: 15,
    });
    const parsed = JSON.parse(output) as ClassifyResult;
    expect(parsed.source).toBe("fallback");
    expect(parsed.reason).toContain("timed out");
    expect(isClassifyResult(parsed)).toBe(true);
    expect(output).not.toContain(SENTINEL_KEY);
  });

  it("falls back with a reason on transport failure, leaking no key", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const output = await taskClassifyCommand(["--task", FIXTURE_TASK, "--json"], {
      fetchImpl: (async () => {
        throw new Error("socket hang up");
      }) as FetchImpl,
    });
    const parsed = JSON.parse(output) as ClassifyResult;
    expect(parsed.source).toBe("fallback");
    expect(typeof parsed.reason).toBe("string");
    expect(output).not.toContain(SENTINEL_KEY);
  });

  it("falls back with a confidence reason below the documented threshold", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const recorded = fixture("classify-low-confidence.json");
    const output = await taskClassifyCommand(["--task", "do the thing with stuff", "--json"], {
      fetchImpl: classifyFetch(recorded.response, []),
    });
    const parsed = JSON.parse(output) as ClassifyResult;
    expect(parsed.source).toBe("fallback");
    expect(parsed.reason).toContain("confidence");
    expect(isClassifyResult(parsed)).toBe(true);
  });

  it("reads the task from a file and includes probabilities only with --full on the Jev path", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const recorded = fixture("classify-success.json");
    const dir = mkdtempSync(join(tmpdir(), "jev-classify-"));
    try {
      const file = join(dir, "TASK.md");
      writeFileSync(file, FIXTURE_TASK);
      const stub = () => classifyFetch(recorded.response, []);
      const plain = JSON.parse(
        await taskClassifyCommand(["--task", file, "--json"], { fetchImpl: stub() }),
      ) as ClassifyResult;
      expect(plain.kind).not.toHaveProperty("probabilities");
      expect(plain).not.toHaveProperty("latencyMs");

      const full = JSON.parse(
        await taskClassifyCommand(["--task", file, "--json", "--full"], { fetchImpl: stub() }),
      ) as Record<string, unknown>;
      expect(full).toHaveProperty("latencyMs");
      expect(full.kind as Record<string, unknown>).toHaveProperty("probabilities");

      // The fallback has no distribution to report: --full adds latencyMs
      // only, and every field stays heuristic.
      delete process.env.TYPESAFE_API_KEY;
      const fallbackFull = JSON.parse(
        await taskClassifyCommand(["--task", file, "--json", "--full"]),
      ) as Record<string, unknown>;
      expect(fallbackFull).toHaveProperty("latencyMs");
      expect(fallbackFull.kind as Record<string, unknown>).not.toHaveProperty("probabilities");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints TOON by default with source and every field", async () => {
    const output = await taskClassifyCommand(["--task", "Update the README typo"]);
    expect(output).toContain("source: fallback");
    expect(output).toContain("kind");
    expect(output).toContain("toolAffinity");
  });
});

describe("doctor (jev check)", () => {
  it("exits cleanly with no key and makes no network call", async () => {
    let called = false;
    const output = await doctorCommand(["--json"], {
      fetchImpl: stubFetch([], () => {
        called = true;
        return replay({});
      }),
    });
    expect(called).toBe(false);
    const parsed = JSON.parse(output) as {
      path: string;
      jev: { keyPresent: boolean; status: string; path: string; reason: string };
    };
    expect(parsed.path).toBe("fallback");
    expect(parsed.jev.keyPresent).toBe(false);
    expect(parsed.jev.status).toBe("disabled");
    expect(parsed.jev.reason).toContain("TYPESAFE_API_KEY");
    expect(output).not.toContain("Bearer");
  });

  it("reports key present, latency, and the live path from the recorded listing", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const recorded = fixture("models-list.json");
    const calls: CapturedCall[] = [];
    const output = await doctorCommand(["--json"], {
      fetchImpl: stubFetch(calls, () => replay(recorded.response)),
    });
    expect(calls).toHaveLength(1);
    const parsed = JSON.parse(output) as {
      path: string;
      jev: { keyPresent: boolean; status: string; path: string; latencyMs: number; modelCount: number };
    };
    expect(parsed.path).toBe("jev");
    expect(parsed.jev.keyPresent).toBe(true);
    expect(parsed.jev.status).toBe("ok");
    expect(typeof parsed.jev.latencyMs).toBe("number");
    expect(parsed.jev.modelCount).toBe(2);
    expect(output).not.toContain(SENTINEL_KEY);
  });

  it("reports error with a reason when the probe fails, leaking no key", async () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;
    const output = await doctorCommand(["--json"], {
      fetchImpl: stubFetch([], () => jsonResponse(401, { error: "bad key" })),
    });
    const parsed = JSON.parse(output) as {
      path: string;
      jev: { keyPresent: boolean; status: string; path: string; reason: string };
    };
    expect(parsed.path).toBe("fallback");
    expect(parsed.jev.status).toBe("error");
    expect(typeof parsed.jev.reason).toBe("string");
    expect(output).not.toContain(SENTINEL_KEY);
  });

  it("prints TOON by default and documents the jev check on --help", async () => {
    const output = await doctorCommand([]);
    expect(output).toContain("path: fallback");
    const help = await doctorCommand(["--help"]);
    expect(help).toContain("never the value");
    expect(help).toContain("no network call");
  });
});

describe("CLI surface (help, flags, key hygiene)", () => {
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
    dir = mkdtempSync(join(tmpdir(), "llm-router-axi-jev-"));
    process.env.XDG_CONFIG_HOME = dir;
    process.env.XDG_STATE_HOME = join(dir, "state");
    process.env.LLM_ROUTER_USAGE_AXI = join(dir, "missing-usage-axi");
  });

  afterEach(() => {
    process.exitCode = savedExitCode ?? 0;
    if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedConfigHome;
    if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedStateHome;
    delete process.env.LLM_ROUTER_USAGE_AXI;
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists classify and doctor in top-level help", async () => {
    const { output, exitCode } = await run(["--help"]);
    expect(exitCode).toBe(0);
    expect(output).toContain("classify");
    expect(output).toContain("doctor");
  });

  it("classifies without a key through main (exit 0, no network)", async () => {
    const { output, exitCode } = await run(["classify", "--task", "Update the README typo"]);
    expect(exitCode).toBe(0);
    expect(output).toContain("source: fallback");
  });

  it("reports doctor disabled without a key through main (exit 0)", async () => {
    const { output, exitCode } = await run(["doctor"]);
    expect(exitCode).toBe(0);
    expect(output).toContain("path: fallback");
    expect(output).not.toContain("Bearer");
  });

  it("refuses unknown classify flags and a missing --task with exit 2", async () => {
    const unknown = await run(["classify", "--bogus"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.output).toContain("unknown flag --bogus");

    const missing = await run(["classify"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.output).toContain("--task");
  });

  it("never echoes an --api-key=<sentinel> value in classify or doctor errors", async () => {
    // Direct command level: the AxiError itself must carry the name only.
    const direct = await taskClassifyCommand([
      `--api-key=${SENTINEL_KEY}`,
      "--task",
      "x",
    ]).then(
      () => "no-throw",
      (error: unknown) => String((error as Error).message),
    );
    expect(direct).toContain("unknown flag --api-key ");
    expect(direct).not.toContain(SENTINEL_KEY);

    // Full CLI level: neither stdout nor the rendered error may leak it.
    const classify = await run(["classify", `--api-key=${SENTINEL_KEY}`, "--task", "x"]);
    expect(classify.exitCode).toBe(2);
    expect(classify.output).toContain("unknown flag --api-key ");
    expect(classify.output).not.toContain(SENTINEL_KEY);

    const doctor = await run(["doctor", `--api-key=${SENTINEL_KEY}`]);
    expect(doctor.exitCode).toBe(2);
    expect(doctor.output).toContain("unknown flag --api-key ");
    expect(doctor.output).not.toContain(SENTINEL_KEY);
  });

  it("states the routing freeze verbatim in classify and doctor --help", async () => {
    const freeze =
      "Nothing routes real traffic through Jev until the lab docs/when-to-route.md verdict exists and the captain says go";
    const classifyHelp = await run(["classify", "--help"]);
    expect(classifyHelp.exitCode).toBe(0);
    expect(classifyHelp.output).toContain(freeze);

    const doctorHelp = await run(["doctor", "--help"]);
    expect(doctorHelp.exitCode).toBe(0);
    expect(doctorHelp.output).toContain(freeze);
  });

  it("keeps classify-evidence on its depletion contract", async () => {
    const file = join(dir, "status");
    writeFileSync(file, "failed: request failed with status code 429\n");
    const { output, exitCode } = await run(["classify-evidence", "--file", file]);
    expect(exitCode).toBe(0);
    expect(output).toContain("classification=depleted");
  });
});
