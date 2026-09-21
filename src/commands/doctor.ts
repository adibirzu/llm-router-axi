/**
 * `doctor`: report the health of the optional Jev path.
 *
 * There is no pre-existing doctor in this repo, so this command IS the
 * doctor and its first (and currently only) check is `jev`. The check
 * reports key presence yes/no (never the value), performs ONE minimal
 * health request (`GET /v1/models`, a documented read-only listing that
 * spends no tokens) when a key is present, and reports latency in ms plus
 * which path is active (`jev` when the probe succeeds, `fallback`
 * otherwise — the same vocabulary `classify` uses for its `source`).
 *
 * Without a key it exits 0 with a structured message and makes NO network
 * call. Doctor is a diagnostic, not a gate, so it exits 0 in every case;
 * callers branch on the reported `status`, not the exit code.
 */

import { AxiError } from "axi-sdk-js";

import { parseArgs, type FlagSpec } from "../args.js";
import { helpBlock, toon } from "../render.js";
import {
  JEV_BASE_URL_ENV,
  JEV_DEFAULT_BASE_URL,
  JEV_KEY_ENV,
  JevError,
  listModels,
  type FetchImpl,
} from "../jev/client.js";

const DOCTOR_FLAGS: FlagSpec[] = [
  { name: "--json", description: "Emit the check results as JSON" },
];

export const DOCTOR_HELP = `usage: llm-router-axi doctor [--json]
description:
  Report the health of the optional Jev path. The jev check reports key
  presence yes/no (never the value), performs ONE minimal health request
  (GET /v1/models, a documented read-only listing that spends no tokens)
  when a key is present, and reports latency in ms plus which path is
  active (jev|fallback). Without a key it exits cleanly with a structured
  message and makes no network call. Doctor is a diagnostic, not a gate:
  it exits 0 in every case; branch on status, not the exit code.
  Nothing routes real traffic through Jev until the lab docs/when-to-route.md verdict exists and the captain says go.
  The docs define no dedicated health endpoint, so the models listing IS
  the health probe (see the gap list in src/jev/client.ts).
checks[1]{name,status}:
  jev=ok|disabled|error  ok: probe succeeded, path=jev. disabled: no key,
                         path=fallback. error: key present but the probe
                         failed, path=fallback with a reason.
outputs:
  TOON report: path, jev{keyPresent, status, latencyMs, modelCount, reason?}
  --json  the same report as JSON
  The key comes ONLY from ${JEV_KEY_ENV}; it is never a flag and never
  appears in any output or error.
flags[${DOCTOR_FLAGS.length + 1}]:
${DOCTOR_FLAGS.map((flag) => `  ${flag.name}${flag.value ? ` <${flag.value}>` : ""}`).join(", ")}, --help
examples:
  llm-router-axi doctor
  llm-router-axi doctor --json
`;

export interface DoctorDeps {
  fetchImpl?: FetchImpl;
}

interface JevCheck {
  keyPresent: boolean;
  status: "ok" | "disabled" | "error";
  /** Which path classify would take right now. */
  path: "jev" | "fallback";
  /** Probe latency; present only when a probe ran. */
  latencyMs?: number;
  /** Models the account may use; present only when the probe ran ok. */
  modelCount?: number;
  /** Why the path is fallback; present only on disabled/error. */
  reason?: string;
  baseUrl: string;
}

export async function doctorCommand(
  args: string[],
  deps: DoctorDeps = {},
): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) {
    return DOCTOR_HELP;
  }
  const { booleans } = parseArgs("doctor", args, DOCTOR_FLAGS);

  const check = await checkJev(deps.fetchImpl);
  const report = { path: check.path, jev: check };

  if (booleans.has("--json")) {
    return JSON.stringify(report, null, 2);
  }
  return toon(
    { doctor: report },
    helpBlock([
      check.path === "jev"
        ? "Jev path is live: `classify` will call Jev first, heuristic fallback stays armed"
        : "Jev path is off: `classify` uses the heuristic fallback (no key, no network needed)",
      "Slice 1 only classifies: nothing routes traffic through Jev",
    ]),
  );
}

async function checkJev(fetchImpl?: FetchImpl): Promise<JevCheck> {
  const baseUrl = (process.env[JEV_BASE_URL_ENV] ?? JEV_DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!process.env[JEV_KEY_ENV]) {
    return {
      keyPresent: false,
      status: "disabled",
      path: "fallback",
      reason: `no ${JEV_KEY_ENV} in the environment; no network call made`,
      baseUrl,
    };
  }
  const started = Date.now();
  try {
    const models = await listModels({ ...(fetchImpl ? { fetchImpl } : {}) });
    return {
      keyPresent: true,
      status: "ok",
      path: "jev",
      latencyMs: Date.now() - started,
      modelCount: models.length,
      baseUrl,
    };
  } catch (error) {
    if (error instanceof AxiError) {
      throw error;
    }
    const reason = error instanceof JevError ? error.message : "Jev health probe failed";
    return {
      keyPresent: true,
      status: "error",
      path: "fallback",
      latencyMs: Date.now() - started,
      reason: `${reason}; classify uses the heuristic fallback`,
      baseUrl,
    };
  }
}
