import { readFileSync } from "node:fs";

import { AxiError } from "axi-sdk-js";

import { cleanDispatchProfile, parseDispatchProfiles } from "../dispatch-profiles.js";
import { loadEffectivePolicy } from "../policy/index.js";
import { loadUsage } from "../usage.js";
import { selectProfiles } from "../selector.js";
import { homeDir, loadState, saveState, withStateLock } from "../state.js";

/**
 * `llm-router-axi select` — the arbitrary-profile compatibility surface.
 *
 * firstmate's `fm-dispatch-select.mjs select` is handed a rule/profile array
 * (`harness`/`provider`/`model`/`effort`/`quotaWindow`) and prints exactly one
 * compact launch profile. This command accepts that same input shape and runs
 * the same eligibility and ranking engine as `route` (`src/selector.ts`), so the
 * fork's script can become a thin shim in P3 while the strings stay byte-equal.
 */

const KNOWN_FLAGS = new Map<string, "value" | "boolean">([
  ["--quota-json", "value"],
  ["--now", "value"],
  ["--reserve-percent", "value"],
  ["--telemetry-max-age-seconds", "value"],
  ["--cooldown-seconds", "value"],
  ["--home", "value"],
  ["--json", "boolean"],
]);

export const SELECT_HELP = `usage: llm-router-axi select [--quota-json <file>] [--now <epoch>] [<json>]
description: Choose one concrete profile from the fork's rule/profile-array input.
  Accepts a rule object with "use", one profile, or a non-empty profile array on
  the command line or stdin. Prints one compact launch profile JSON on stdout and
  the per-candidate diagnostics on stderr, exactly like fm-dispatch-select.mjs.
inputs:
  <json>                       a profile, {use:[...]}, or a profile array (default stdin)
  --quota-json <file>          read quota telemetry from a fixture instead of usage-axi
  --now <epoch>                fix the current epoch second (test seam)
  --reserve-percent <n>        override the policy routing.reservePercent
  --telemetry-max-age-seconds <n>  override the policy telemetry max age
  --cooldown-seconds <n>       override the policy cooldown
  --home <dir>                 home for least-recent-use tie-breaking
  --json                       pretty-print the selected profile
outputs:
  stdout: {harness, provider, model?, effort?}  (quotaWindow never reaches stdout)
  stderr: candidate diagnostics reusing the frozen selector rejection strings
exit:
  0  selected one profile
  2  configuration error (unknown option, bad profile, bad settings)
  3  no candidate has current dispatch capacity evidence
examples:
  echo '[{"harness":"claude"},{"harness":"codex"}]' | llm-router-axi select --quota-json usage.json
  llm-router-axi select '{"use":[{"harness":"cursor","quotaWindow":"auto_usage"}]}' --usage-json usage.json
`;

interface SelectArgs {
  quotaJson?: string;
  now?: number;
  reservePercent?: number;
  telemetryMaxAgeSeconds?: number;
  cooldownSeconds?: number;
  home?: string;
  json: boolean;
  positional: string[];
}

function selectError(message: string): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", [
    "Input is a single profile, a {use:[...]} rule, or a non-empty array",
    "Run `llm-router-axi select --help` for the contract",
  ]);
}

function parseSelectArgs(args: string[]): SelectArgs {
  const parsed: SelectArgs = { json: false, positional: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === "--") {
      parsed.positional.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-")) {
      parsed.positional.push(arg);
      continue;
    }
    let name = arg;
    let inlineValue: string | undefined;
    if (arg.includes("=")) {
      const equals = arg.indexOf("=");
      name = arg.slice(0, equals);
      inlineValue = arg.slice(equals + 1);
    }
    const kind = KNOWN_FLAGS.get(name);
    if (kind === undefined) throw selectError(`unknown option ${arg}`);
    if (kind === "boolean") {
      if (name === "--json") parsed.json = true;
      continue;
    }
    const value = inlineValue ?? args[++index];
    if (value === undefined) throw selectError(`${name} requires a value`);
    switch (name) {
      case "--quota-json":
        parsed.quotaJson = value;
        break;
      case "--now":
        parsed.now = boundedInteger(value, name, 0, Number.MAX_SAFE_INTEGER, "--now", "a non-negative epoch second");
        break;
      case "--reserve-percent":
        parsed.reservePercent = boundedInteger(value, name, 0, 99, "reservePercent");
        break;
      case "--telemetry-max-age-seconds":
        parsed.telemetryMaxAgeSeconds = boundedInteger(value, name, 1, 3600, "telemetryMaxAgeSeconds");
        break;
      case "--cooldown-seconds":
        parsed.cooldownSeconds = boundedInteger(value, name, 60, 86400, "cooldownSeconds");
        break;
      case "--home":
        parsed.home = value;
        break;
      default:
        break;
    }
  }
  if (parsed.positional.length > 1) throw selectError("expected at most one JSON argument");
  return parsed;
}

function boundedInteger(
  value: string,
  flag: string,
  minimum: number,
  maximum: number,
  label: string,
  description?: string,
): number {
  if (!/^\d+$/.test(value)) {
    throw selectError(
      description
        ? `${flag} must be ${description}`
        : `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw selectError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function inputText(parsed: SelectArgs): string {
  if (parsed.positional.length === 1) return parsed.positional[0] as string;
  return readFileSync(0, "utf8");
}

export async function selectCommand(args: string[]): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) {
    return SELECT_HELP;
  }
  const parsed = parseSelectArgs(args);
  const candidates = parseDispatchProfiles(inputText(parsed));

  const read = loadEffectivePolicy();
  if (!read.ok) {
    throw new AxiError(read.message, "VALIDATION_ERROR", [
      ...read.issues.map((issue) => `${issue.path}: ${issue.message}`),
      "Run `llm-router-axi policy validate` for the full issue list",
    ]);
  }
  const routing = read.policy.routing;
  const settings = {
    reservePercent: parsed.reservePercent ?? routing.reservePercent,
    telemetryMaxAgeSeconds: parsed.telemetryMaxAgeSeconds ?? routing.telemetryMaxAgeSeconds,
    cooldownSeconds: parsed.cooldownSeconds ?? routing.cooldownSeconds,
  };
  const now = parsed.now ?? Math.floor(Date.now() / 1000);
  const quota = loadUsage({
    ...(parsed.quotaJson ? { usageJson: parsed.quotaJson } : {}),
  });

  const report = withStateLock(() => {
    const state = loadState();
    const result = selectProfiles({
      profiles: candidates.map((candidate) => candidate.profile),
      quota,
      settings,
      now,
      state,
      home: parsed.home ?? homeDir(),
    });
    saveState(result.state);
    return result;
  });

  if (!report.ok || !report.selected) {
    for (const evaluation of report.evaluations) {
      process.stderr.write(`llm-router-axi select: ${evaluation.reason}\n`);
    }
    process.stderr.write(
      `llm-router-axi select: ${report.reason ?? "no subscription candidate has current dispatch capacity evidence"}\n`,
    );
    process.exitCode = report.exitCode || 3;
    return "";
  }

  const launch = cleanDispatchProfile(report.selected);
  return parsed.json ? JSON.stringify(launch, null, 2) : JSON.stringify(launch);
}
