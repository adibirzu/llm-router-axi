/**
 * Minimal fetch-based TypeSafe System One (Jev) client.
 *
 * Built ONLY from the documented HTTP contract
 * (https://docs.typesafe.ai/api.md plus the pages llms.txt points to):
 *
 * - `POST {base}/v1/systemone` with `Authorization: Bearer <API_KEY>`,
 *   body `{state, model, questions}`, response `{model, answers, usage}`.
 * - `GET {base}/v1/models` lists the models/aliases the account may use.
 * - Question types `choice` / `score` / `noul`; Choice and Score answers
 *   carry `probabilities` + `confidence` (0-1, derived from the spread);
 *   Noul answers carry only `noul` (0-1, no separate confidence).
 * - Error statuses `401` (bad key), `422` (bad request body),
 *   `429` / `529` (retry with backoff).
 * - Env names and defaults from the SDK reference: `TYPESAFE_API_KEY`,
 *   `TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`),
 *   `TYPESAFE_DEFAULT_MODEL` (default `jev-latest`), 10s default timeout.
 *
 * Gaps in the documented contract (also listed in the PR body):
 *
 * - There is NO documented health endpoint, so `doctor` probes the
 *   documented `GET /v1/models` listing as its minimal health request.
 * - The docs specify retry/backoff only for the official SDKs ("client SDKs
 *   handle this automatically"); for this raw-HTTP client we retry at most
 *   ONCE, only on 429/529, honoring `Retry-After` capped at 2s.
 * - The docs do not fix the exact validation-error body shape, so non-2xx
 *   responses are surfaced as `{status, message}` without echoing the key.
 *
 * Key hygiene: the key is read ONLY from `TYPESAFE_API_KEY` at call time.
 * It is never accepted as a flag, never printed, logged, cached, written to
 * a fixture, or interpolated into an error message. The HTTP layer (`fetch`)
 * is injectable so tests never touch the network.
 */

export const JEV_KEY_ENV = "TYPESAFE_API_KEY";
export const JEV_BASE_URL_ENV = "TYPESAFE_BASE_URL";
export const JEV_MODEL_ENV = "TYPESAFE_DEFAULT_MODEL";

export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const JEV_DEFAULT_MODEL = "jev-latest";

/** Per-attempt timeout in ms (the SDK default is 10s; no total retry budget). */
export const JEV_DEFAULT_TIMEOUT_MS = 10_000;

/** Upper bound for honoring a server `Retry-After` header. */
export const JEV_MAX_RETRY_AFTER_MS = 2_000;

/** The client retries at most this many extra attempts, 429/529 only. */
export const JEV_MAX_RETRIES = 1;

export interface ChoiceQuestion {
  type: "choice";
  instructions: string | object | Array<unknown>;
  /** Option -> rubric description; null when an option needs no detail. */
  criteria: Record<string, string | object | Array<unknown> | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string | object | Array<unknown>;
  /** Ordered level descriptions (documented: 2-10 levels accepted). */
  criteria: Array<string | object | Array<unknown>>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string | object | Array<unknown>;
  criteria?: { true?: string | object | Array<unknown>; false?: string | object | Array<unknown> };
}

export type JevQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export type JevAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface SystemOneResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface ModelCard {
  name: string;
  description: string;
  release_date: string;
}

export type JevErrorKind =
  | "missing-key"
  | "auth"
  | "validation"
  | "rate-limited"
  | "overloaded"
  | "network"
  | "timeout"
  | "protocol";

/** Typed client error. Never carries the API key. */
export class JevError extends Error {
  readonly kind: JevErrorKind;
  readonly status?: number;

  constructor(kind: JevErrorKind, message: string, status?: number) {
    super(message);
    this.name = "JevError";
    this.kind = kind;
    if (status !== undefined) {
      this.status = status;
    }
  }
}

export type FetchImpl = typeof fetch;

export interface JevCallOptions {
  /** Override for `TYPESAFE_DEFAULT_MODEL` / `jev-latest`. */
  model?: string;
  /** Override for `TYPESAFE_BASE_URL` (tests point this at a stub). */
  baseUrl?: string;
  /** Injected transport; defaults to global fetch. Tests inject a stub. */
  fetchImpl?: FetchImpl;
  /** Per-attempt timeout in ms; default {@link JEV_DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Extra attempts on 429/529 only; default {@link JEV_MAX_RETRIES}. */
  maxRetries?: number;
}

function readKey(): string {
  const key = process.env[JEV_KEY_ENV];
  if (!key) {
    throw new JevError(
      "missing-key",
      `no Jev key: set ${JEV_KEY_ENV} in the environment`,
    );
  }
  return key;
}

function readBaseUrl(override?: string): string {
  const raw = override ?? process.env[JEV_BASE_URL_ENV] ?? JEV_DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

function readModel(override?: string): string {
  return override ?? process.env[JEV_MODEL_ENV] ?? JEV_DEFAULT_MODEL;
}

function retryAfterMs(headers: Headers): number {
  const raw = headers.get("retry-after");
  if (!raw) {
    return 0;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return 0;
  }
  return Math.min(Math.round(seconds * 1000), JEV_MAX_RETRY_AFTER_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Minimal shape check on the documented response body. */
function parseSystemOneResponse(body: unknown): SystemOneResponse {
  if (!isRecord(body) || typeof body.model !== "string" || !isRecord(body.answers)) {
    throw new JevError("protocol", "unexpected Jev response shape: missing model/answers");
  }
  const answers: Record<string, JevAnswer> = {};
  for (const [id, answer] of Object.entries(body.answers)) {
    if (!isRecord(answer) || typeof answer.type !== "string") {
      throw new JevError("protocol", `unexpected Jev answer shape for question "${id}"`);
    }
    if (answer.type === "choice") {
      if (typeof answer.choice !== "string" || !isRecord(answer.probabilities)) {
        throw new JevError("protocol", `unexpected Jev choice answer for question "${id}"`);
      }
      answers[id] = {
        type: "choice",
        choice: answer.choice,
        probabilities: answer.probabilities as Record<string, number>,
        confidence: typeof answer.confidence === "number" ? answer.confidence : 0,
      };
    } else if (answer.type === "score") {
      if (typeof answer.score !== "number" || !isRecord(answer.probabilities)) {
        throw new JevError("protocol", `unexpected Jev score answer for question "${id}"`);
      }
      answers[id] = {
        type: "score",
        score: answer.score,
        legend: isRecord(answer.legend) ? (answer.legend as Record<string, string>) : {},
        probabilities: answer.probabilities as Record<string, number>,
        confidence: typeof answer.confidence === "number" ? answer.confidence : 0,
      };
    } else if (answer.type === "noul") {
      if (typeof answer.noul !== "number") {
        throw new JevError("protocol", `unexpected Jev noul answer for question "${id}"`);
      }
      answers[id] = { type: "noul", noul: answer.noul };
    } else {
      throw new JevError("protocol", `unknown Jev answer type for question "${id}"`);
    }
  }
  const usage = isRecord(body.usage) ? body.usage : {};
  return {
    model: body.model,
    answers,
    usage: {
      input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    },
  };
}

/**
 * Evaluate one `state` against a map of typed questions in a single request.
 * Questions run in parallel server-side; batch every question the caller
 * might need (speculative fan-out) rather than calling per question.
 */
export async function evaluateSystemOne(
  state: string | object | Array<unknown>,
  questions: Record<string, JevQuestion>,
  options: JevCallOptions = {},
): Promise<SystemOneResponse> {
  const key = readKey();
  const baseUrl = readBaseUrl(options.baseUrl);
  const model = readModel(options.model);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? JEV_MAX_RETRIES;

  const payload = JSON.stringify({ state, model, questions });
  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/v1/systemone`, {
        method: "POST",
        // The key travels ONLY in this Authorization header. It is never
        // copied into a message, log, fixture, or error below.
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: payload,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof Error && error.name === "AbortError") {
        throw new JevError("timeout", `Jev request timed out after ${timeoutMs}ms`);
      }
      throw new JevError(
        "network",
        `Jev request failed: ${error instanceof Error ? error.message : "unknown transport error"}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      return parseSystemOneResponse(body);
    }
    if ((response.status === 429 || response.status === 529) && attempt < maxRetries) {
      attempt += 1;
      await sleep(retryAfterMs(response.headers));
      continue;
    }
    if (response.status === 401) {
      throw new JevError("auth", "Jev rejected the request: missing or invalid API key", 401);
    }
    if (response.status === 422) {
      throw new JevError("validation", "Jev rejected the request body (validation failed)", 422);
    }
    if (response.status === 429) {
      throw new JevError("rate-limited", "Jev rate limit exceeded; back off and retry", 429);
    }
    if (response.status === 529) {
      throw new JevError("overloaded", "Jev is temporarily overloaded; retry shortly", 529);
    }
    throw new JevError("protocol", `Jev request failed with status ${response.status}`, response.status);
  }
}

/**
 * Minimal health probe: the documented `GET /v1/models` listing. The docs
 * define no dedicated health endpoint, so `doctor` uses this read-only call
 * (it spends no tokens) to prove the key works and measure latency.
 */
export async function listModels(options: JevCallOptions = {}): Promise<ModelCard[]> {
  const key = readKey();
  const baseUrl = readBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/models`, {
      method: "GET",
      // The key travels ONLY in this Authorization header; see above.
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      throw new JevError("timeout", `Jev models request timed out after ${timeoutMs}ms`);
    }
    throw new JevError(
      "network",
      `Jev models request failed: ${error instanceof Error ? error.message : "unknown transport error"}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new JevError("auth", "Jev rejected the request: missing or invalid API key", 401);
    }
    throw new JevError(
      "protocol",
      `Jev models request failed with status ${response.status}`,
      response.status,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!isRecord(body) || !Array.isArray(body.models)) {
    throw new JevError("protocol", "unexpected Jev models response shape: missing models[]");
  }
  return (body.models as unknown[]).map((entry) =>
    isRecord(entry)
      ? {
          name: typeof entry.name === "string" ? entry.name : "unknown",
          description: typeof entry.description === "string" ? entry.description : "",
          release_date: typeof entry.release_date === "string" ? entry.release_date : "",
        }
      : { name: "unknown", description: "", release_date: "" },
  );
}
