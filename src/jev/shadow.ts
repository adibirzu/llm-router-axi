/**
 * Slice 3: the shadow-mode classify hook in `route` and `record`.
 *
 * When the policy enables `jev.shadow` (and the kill switch is off), `route
 * --task <text>` additionally classifies the task text with the slice 1
 * `classify` client and appends one row to the shadow ledger: the
 * Jev-derived descriptor NEXT TO the supplied descriptor plus the
 * per-field agreement and a read-only preview of whether the Jev
 * descriptor would have picked the same harness/model/effort. The routing
 * decision is always computed from the SUPPLIED descriptor exactly as
 * before and is never changed by Jev output.
 *
 * Nothing here routes real traffic through Jev until the lab's
 * `docs/when-to-route.md` verdict exists and the captain says go.
 *
 * Key hygiene: this module never sees the key (the client reads it from
 * `TYPESAFE_API_KEY` at call time) and ledger rows never carry it.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { classifyTask, readTask } from "../commands/task-classify.js";
import { homeDir, loadState } from "../state.js";
import { stateDir } from "../policy/index.js";
import type { Difficulty, Kind, Policy } from "../policy/types.js";
import { routeLane } from "../router.js";
import { loadUsage } from "../usage.js";
import { JEV_DEFAULT_TIMEOUT_MS, type FetchImpl } from "./client.js";
import type { ClassifyResult } from "./schema.js";

/** Verbatim freeze sentence shared by every Jev --help block and the report. */
export const JEV_FREEZE =
  "Nothing routes real traffic through Jev until the lab docs/when-to-route.md verdict exists and the captain says go.";

/** Environment kill switch: any off-value always wins over the config. */
export const JEV_SHADOW_ENV = "LLM_ROUTER_JEV_SHADOW";

/** Ledger path override (tests point this at a temp file). */
export const SHADOW_FILE_ENV = "LLM_ROUTER_SHADOW_FILE";

/**
 * Hard total time budget for one shadow pass: shadow never adds more than
 * a single client timeout to `route` latency.
 */
export const SHADOW_BUDGET_MS = JEV_DEFAULT_TIMEOUT_MS;

const KILL_VALUES = new Set(["off", "0", "false", "no"]);

/** The kill switch always wins over the config and disables the hook instantly. */
export function shadowKilled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[JEV_SHADOW_ENV];
  if (raw === undefined) return false;
  return KILL_VALUES.has(raw.trim().toLowerCase());
}

/** Config flag, OFF by default: `jev.shadow.enabled` must be exactly true. */
export function shadowEnabled(policy: Policy, env: NodeJS.ProcessEnv = process.env): boolean {
  if (shadowKilled(env)) return false;
  return policy.jev?.shadow?.enabled === true;
}

export function shadowLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SHADOW_FILE_ENV];
  if (override && override.length > 0) return override;
  return join(stateDir(env), "shadow-ledger.jsonl");
}

export interface ShadowSupplied {
  kind: string;
  difficulty: string;
  /** Null when `route` ran without `--surface` (surface is optional there). */
  surface: string | null;
}

export interface ShadowJevDescriptor {
  source: "jev" | "fallback";
  model?: string;
  reason?: string;
  kind: string;
  difficulty: string;
  surface: string;
  reasoningClass: string;
  riskClass: string;
  toolAffinity: string;
}

export interface ShadowAgreement {
  kind: boolean;
  difficulty: boolean;
  /** Null when no surface was supplied, so there is nothing to agree with. */
  surface: boolean | null;
  all: boolean;
}

export interface ShadowDecision {
  harness: string;
  model?: string;
  effort?: string;
}

export type ShadowStatus = "recorded" | "fallback" | "skipped";

export interface ShadowRow {
  v: 1;
  kind: "shadow";
  at: number;
  supplied: ShadowSupplied;
  jev: ShadowJevDescriptor | null;
  agreement: ShadowAgreement | null;
  decision: ShadowDecision | null;
  jevDecision: ShadowDecision | null;
  routeAgreement: boolean | null;
  status: ShadowStatus;
  reason?: string;
}

export interface OutcomeRow {
  v: 1;
  kind: "outcome";
  at: number;
  task: string;
  provider: string;
  outcome: "rate_limit" | "ok";
}

export type ShadowLedgerRow = ShadowRow | OutcomeRow;

/**
 * Append one ledger row. Best-effort by design: the ledger is telemetry and
 * must never fail a `route` or `record` call, so write errors are swallowed.
 */
export function appendLedgerRow(row: ShadowLedgerRow, path: string = shadowLedgerPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch {
    // Telemetry only: a full disk or a read-only home never fails routing.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lenient row check: old entries (missing newer optional fields) still
 * parse, with the gaps normalized to null. Unknown kinds and malformed
 * lines are skipped by the reader, never fatal.
 */
function asLedgerRow(value: unknown): ShadowLedgerRow | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (value.kind === "outcome") {
    if (
      typeof value.at !== "number" ||
      typeof value.task !== "string" ||
      typeof value.provider !== "string" ||
      (value.outcome !== "rate_limit" && value.outcome !== "ok")
    ) {
      return null;
    }
    return {
      v: 1,
      kind: "outcome",
      at: value.at,
      task: value.task,
      provider: value.provider,
      outcome: value.outcome,
    };
  }
  if (value.kind === "shadow") {
    if (typeof value.at !== "number" || !isRecord(value.supplied)) {
      return null;
    }
    const { supplied } = value;
    if (typeof supplied.kind !== "string" || typeof supplied.difficulty !== "string") {
      return null;
    }
    const status =
      value.status === "recorded" || value.status === "fallback" || value.status === "skipped"
        ? value.status
        : "skipped";
    return {
      v: 1,
      kind: "shadow",
      at: value.at,
      supplied: {
        kind: supplied.kind,
        difficulty: supplied.difficulty,
        surface: typeof supplied.surface === "string" ? supplied.surface : null,
      },
      jev: isRecord(value.jev) ? (value.jev as unknown as ShadowJevDescriptor) : null,
      agreement: isRecord(value.agreement)
        ? (value.agreement as unknown as ShadowAgreement)
        : null,
      decision: isRecord(value.decision) ? (value.decision as unknown as ShadowDecision) : null,
      jevDecision: isRecord(value.jevDecision)
        ? (value.jevDecision as unknown as ShadowDecision)
        : null,
      routeAgreement: typeof value.routeAgreement === "boolean" ? value.routeAgreement : null,
      status,
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    };
  }
  return null;
}

/** Read every ledger row; a missing file is an empty window, not an error. */
export function readLedgerRows(path: string = shadowLedgerPath()): ShadowLedgerRow[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows: ShadowLedgerRow[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const row = asLedgerRow(JSON.parse(line) as unknown);
      if (row) rows.push(row);
    } catch {
      // Skip malformed lines: an old or concurrent writer never breaks readers.
    }
  }
  return rows;
}

export interface ShadowDeps {
  fetchImpl?: FetchImpl;
  /** Total shadow budget and per-attempt classify timeout in ms (test seam). */
  timeoutMs?: number;
}

export interface ShadowInput {
  policy: Policy;
  kind: string;
  difficulty: string;
  surface?: string;
  /** Raw `route --task` value (text, file path, or `-` for stdin). */
  taskRaw?: string;
  usageJson?: string;
  now: number;
  decision: ShadowDecision | null;
}

function raceBudget<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function agreementFor(supplied: ShadowSupplied, jev: ClassifyResult): ShadowAgreement {
  const kind = supplied.kind === jev.kind.value;
  const difficulty = supplied.difficulty === jev.difficulty.value;
  const surface =
    supplied.surface === null ? null : supplied.surface === jev.surface.value;
  return { kind, difficulty, surface, all: kind && difficulty && surface !== false };
}

function toJevDescriptor(result: ClassifyResult): ShadowJevDescriptor {
  return {
    source: result.source,
    ...(result.model ? { model: result.model } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    kind: result.kind.value,
    difficulty: result.difficulty.value,
    surface: result.surface.value,
    reasoningClass: result.reasoningClass.value,
    riskClass: result.riskClass.value,
    toolAffinity: result.toolAffinity.value,
  };
}

/**
 * Read-only preview: what would the Jev descriptor have routed to? Runs the
 * same `routeLane` engine over a freshly loaded (but never saved) state, so
 * the least-recent-use ledger and cooldowns are untouched. Any failure
 * degrades to null; it never affects the real decision.
 */
function previewJevDecision(
  policy: Policy,
  jev: ClassifyResult,
  usageJson: string | undefined,
  now: number,
): ShadowDecision | null {
  try {
    const quota = loadUsage({
      ...(usageJson ? { usageJson } : {}),
      maxAgeSeconds: policy.routing.telemetryMaxAgeSeconds,
      now,
    });
    const state = loadState();
    const preview = routeLane({
      policy,
      kind: jev.kind.value as Kind,
      difficulty: jev.difficulty.value as Difficulty,
      quota,
      state,
      now,
      home: homeDir(),
    });
    const decision = preview.decision;
    if (!decision) return null;
    return {
      harness: decision.harness,
      ...(decision.model ? { model: decision.model } : {}),
      ...(decision.effort ? { effort: decision.effort } : {}),
    };
  } catch {
    return null;
  }
}

function sameDecision(left: ShadowDecision | null, right: ShadowDecision | null): boolean | null {
  if (!left || !right) return null;
  return (
    left.harness === right.harness &&
    (left.model ?? null) === (right.model ?? null) &&
    (left.effort ?? null) === (right.effort ?? null)
  );
}

/**
 * One shadow pass for `route`. Bounded by {@link SHADOW_BUDGET_MS}, silent,
 * and infallible: every failure path (disabled, kill switch, no task text,
 * budget exceeded, Jev error, missing key, fallback answer) leaves the
 * route result and exit code exactly as they were. Makes zero network
 * calls unless the hook is enabled and a live classify runs.
 */
export async function runRouteShadow(input: ShadowInput, deps: ShadowDeps = {}): Promise<void> {
  try {
    if (!shadowEnabled(input.policy)) return;
    if (input.taskRaw === undefined) return;
    let task: string;
    try {
      task = readTask(input.taskRaw);
    } catch {
      return;
    }
    if (task.trim().length === 0) return;

    const supplied: ShadowSupplied = {
      kind: input.kind,
      difficulty: input.difficulty,
      surface: input.surface ?? null,
    };
    const budgetMs = deps.timeoutMs ?? SHADOW_BUDGET_MS;
    const result = await raceBudget(
      classifyTask(task, {
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        timeoutMs: budgetMs,
      }),
      budgetMs,
    );
    if (result === null) {
      appendLedgerRow({
        v: 1,
        kind: "shadow",
        at: input.now,
        supplied,
        jev: null,
        agreement: null,
        decision: input.decision,
        jevDecision: null,
        routeAgreement: null,
        status: "skipped",
        reason: "shadow budget exceeded before classify answered",
      });
      return;
    }
    const jev = toJevDescriptor(result);
    const agreement = agreementFor(supplied, result);
    const jevDecision = previewJevDecision(input.policy, result, input.usageJson, input.now);
    appendLedgerRow({
      v: 1,
      kind: "shadow",
      at: input.now,
      supplied,
      jev,
      agreement,
      decision: input.decision,
      jevDecision,
      routeAgreement: sameDecision(input.decision, jevDecision),
      status: result.source === "jev" ? "recorded" : "fallback",
      ...(result.source === "fallback" && result.reason ? { reason: result.reason } : {}),
    });
  } catch {
    // The shadow hook never fails a route: degrade silently.
  }
}

export interface AgreementStat {
  agree: number;
  total: number;
  /** Null when there is nothing to average over (never 0/0). */
  rate: number | null;
}

export interface GoCriterion {
  id: string;
  threshold: string;
  observed: number | null;
  tasks: number;
  /** Null when the window is too small (or undecidable) to call it. */
  met: boolean | null;
  detail: string;
}

export interface ShadowReport {
  window: {
    entries: number;
    shadow: number;
    outcomes: number;
    recorded: number;
    fallback: number;
    skipped: number;
    since: number | null;
    until: number | null;
  };
  descriptorAgreement: {
    /** Jev-sourced rows only; fallback rows are data, not evidence. */
    n: number;
    fallbackRows: number;
    kind: AgreementStat;
    difficulty: AgreementStat;
    surface: AgreementStat;
    all: AgreementStat;
  };
  routeAgreement: { n: number; agree: number; total: number; rate: number | null };
  outcomes: { ok: number; rate_limit: number; total: number; rateLimitRate: number | null };
  /** The proposed go criteria as data, not as a decision. */
  goCriteria: GoCriterion[];
  note: string;
}

function stat(agree: number, total: number): AgreementStat {
  return { agree, total, rate: total > 0 ? agree / total : null };
}

/**
 * Build the read-only shadow report. Pure function over ledger rows: no
 * network, no writes, and it never turns shadow into live routing — the go
 * criteria are reported as data with a human verdict still required.
 */
export function buildShadowReport(rows: ShadowLedgerRow[]): ShadowReport {
  const shadowRows = rows.filter((row): row is ShadowRow => row.kind === "shadow");
  const outcomeRows = rows.filter((row): row is OutcomeRow => row.kind === "outcome");
  const ats = rows.map((row) => row.at).filter((at) => Number.isFinite(at));

  const recorded = shadowRows.filter((row) => row.status === "recorded");
  const withAgreement = recorded.filter(
    (row): row is ShadowRow & { agreement: ShadowAgreement } => row.agreement !== null,
  );
  const surfaceRows = withAgreement.filter((row) => row.agreement.surface !== null);
  const kindAgree = withAgreement.filter((row) => row.agreement.kind).length;
  const difficultyAgree = withAgreement.filter((row) => row.agreement.difficulty).length;
  const surfaceAgree = surfaceRows.filter((row) => row.agreement.surface === true).length;
  const allAgree = withAgreement.filter((row) => row.agreement.all).length;

  const routed = recorded.filter((row) => row.routeAgreement !== null);
  const routeAgree = routed.filter((row) => row.routeAgreement === true).length;

  const ok = outcomeRows.filter((row) => row.outcome === "ok").length;
  const rateLimited = outcomeRows.filter((row) => row.outcome === "rate_limit").length;

  const descriptorAll = stat(allAgree, withAgreement.length);
  const route = stat(routeAgree, routed.length);
  const rateLimitRate = outcomeRows.length > 0 ? rateLimited / outcomeRows.length : null;

  return {
    window: {
      entries: rows.length,
      shadow: shadowRows.length,
      outcomes: outcomeRows.length,
      recorded: recorded.length,
      fallback: shadowRows.filter((row) => row.status === "fallback").length,
      skipped: shadowRows.filter((row) => row.status === "skipped").length,
      since: ats.length > 0 ? Math.min(...ats) : null,
      until: ats.length > 0 ? Math.max(...ats) : null,
    },
    descriptorAgreement: {
      n: withAgreement.length,
      fallbackRows: shadowRows.filter((row) => row.status === "fallback" && row.agreement !== null)
        .length,
      kind: stat(kindAgree, withAgreement.length),
      difficulty: stat(difficultyAgree, withAgreement.length),
      surface: stat(surfaceAgree, surfaceRows.length),
      all: descriptorAll,
    },
    routeAgreement: { n: routed.length, agree: routeAgree, total: routed.length, rate: route.rate },
    outcomes: { ok, rate_limit: rateLimited, total: outcomeRows.length, rateLimitRate },
    goCriteria: [
      {
        id: "descriptor-agreement",
        threshold: "descriptor agreement (all fields) >= 0.85",
        observed: descriptorAll.rate,
        tasks: withAgreement.length,
        met: withAgreement.length > 0 ? (descriptorAll.rate ?? 0) >= 0.85 : null,
        detail:
          withAgreement.length > 0
            ? "Jev-sourced shadow rows only; fallback rows are excluded"
            : "no Jev-sourced shadow rows recorded yet",
      },
      {
        id: "route-agreement",
        threshold: "route agreement (same harness/model/effort) >= 0.90",
        observed: route.rate,
        tasks: routed.length,
        met: routed.length > 0 ? (route.rate ?? 0) >= 0.9 : null,
        detail:
          routed.length > 0
            ? "read-only preview: the Jev descriptor never influenced a real decision"
            : "no shadow rows with a comparable Jev preview yet",
      },
      {
        id: "rate-limit-no-rise",
        threshold: "no rise in rate_limit outcomes over 100+ tasks",
        observed: rateLimitRate,
        tasks: outcomeRows.length,
        met: null,
        detail:
          outcomeRows.length >= 100
            ? "100+ outcomes recorded: compare this rate against the pre-shadow baseline; a human calls the verdict"
            : `needs 100+ recorded outcomes (have ${outcomeRows.length}); a human calls the verdict against the pre-shadow baseline`,
      },
    ],
    note: JEV_FREEZE,
  };
}
