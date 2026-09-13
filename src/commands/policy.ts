import { existsSync, readFileSync } from "node:fs";

import { AxiError } from "axi-sdk-js";

import { parseArgs, type FlagSpec } from "../args.js";
import {
  configPath,
  defaultPolicyJson,
  loadEffectivePolicy,
  readPolicyFile,
  resolveLaneCandidates,
  stateDir,
  writePolicyFile,
} from "../policy/index.js";
import type { Policy } from "../policy/types.js";
import { collapseHome, helpBlock, toon } from "../render.js";

const KINDS = ["ship", "scout", "review", "architecture", "admin"] as const;
const DIFFICULTIES = ["easy", "medium", "hard"] as const;

const INIT_FLAGS: FlagSpec[] = [
  { name: "--force", description: "Overwrite an existing policy file" },
  { name: "--json", description: "Emit JSON instead of TOON" },
];

const SHOW_FLAGS: FlagSpec[] = [
  { name: "--full", description: "Expand every candidate chain" },
  { name: "--json", description: "Emit the effective policy as JSON" },
];

const VALIDATE_FLAGS: FlagSpec[] = [
  { name: "--file", value: "path", description: "Validate this file instead of the active policy" },
  { name: "--json", description: "Emit JSON instead of TOON" },
];

export const POLICY_HELP = `usage: llm-router-axi policy <init|show|validate> [flags]
description: Inspect and validate the routing doctrine policy file.
subcommands[3]:
  init      write the bundled default policy to the config path (idempotent)
  show      print the effective policy and its lanes
  validate  check a policy file against policy.schema.json
flags[1]:
  --help
examples:
  llm-router-axi policy init
  llm-router-axi policy show --full
  llm-router-axi policy validate --file ./policy.json
config path: ${configPath()}
state path:  ${stateDir()}
`;

const INIT_HELP = `usage: llm-router-axi policy init [--force] [--json]
description: Write the bundled default policy to the config path.
  Idempotent: an existing byte-identical file is a silent no-op.
flags[3]:
${INIT_FLAGS.map((flag) => `  ${flag.name}${flag.value ? ` <${flag.value}>` : ""}  ${flag.description}`).join("\n")}
  --help
examples:
  llm-router-axi policy init
  llm-router-axi policy init --force
`;

const SHOW_HELP = `usage: llm-router-axi policy show [--full] [--json]
description: Print the effective policy (the config file, else the bundled default).
flags[3]:
${SHOW_FLAGS.map((flag) => `  ${flag.name}${flag.value ? ` <${flag.value}>` : ""}  ${flag.description}`).join("\n")}
  --help
examples:
  llm-router-axi policy show
  llm-router-axi policy show --full
  llm-router-axi policy show --json
`;

const VALIDATE_HELP = `usage: llm-router-axi policy validate [--file <path>] [--json]
description: Validate a policy against policy.schema.json; malformed files are refused (exit 2).
flags[3]:
${VALIDATE_FLAGS.map((flag) => `  ${flag.name}${flag.value ? ` <${flag.value}>` : ""}  ${flag.description}`).join("\n")}
  --help
examples:
  llm-router-axi policy validate
  llm-router-axi policy validate --file ./policy.json
`;

export async function policyCommand(args: string[]): Promise<string> {
  const sub = args[0];
  if (sub === undefined || sub === "--help" || sub === "-h") {
    return POLICY_HELP;
  }
  const rest = args.slice(1);
  switch (sub) {
    case "init":
      return policyInit(rest);
    case "show":
      return policyShow(rest);
    case "validate":
      return policyValidate(rest);
    default:
      throw new AxiError(`unknown policy subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Valid subcommands: init, show, validate",
        "Run `llm-router-axi policy --help`",
      ]);
  }
}

function policyInit(args: string[]): string {
  if (args.includes("--help") || args.includes("-h")) {
    return INIT_HELP;
  }
  const { booleans } = parseArgs("policy init", args, INIT_FLAGS);
  const force = booleans.has("--force");
  const json = booleans.has("--json");
  const path = configPath();
  const defaultJson = defaultPolicyJson();

  const outcome = writeDefault(path, defaultJson, force);
  const rendered = collapseHome(path);

  if (json) {
    return JSON.stringify(
      {
        action: outcome.action,
        path,
        version: 1,
        force,
      },
      null,
      2,
    );
  }

  const messages: Record<"written" | "unchanged" | "differs", string> = {
    written: `policy: wrote the bundled default to ${rendered}`,
    unchanged: `policy: already initialized at ${rendered} (no-op)`,
    differs: `policy: already initialized at ${rendered}, differs from the bundled default`,
  };
  const message = messages[outcome.action];

  return toon(
    {
      policy: {
        action: outcome.action,
        path: rendered,
        version: 1,
      },
    },
    helpBlock([
      outcome.action === "differs"
        ? "Run `llm-router-axi policy init --force` to overwrite with the bundled default"
        : "Run `llm-router-axi policy show` to inspect the effective policy",
      "Run `llm-router-axi policy validate` to check the file",
    ]),
  ) + `\n${message}`;
}

function writeDefault(
  path: string,
  contents: string,
  force: boolean,
): { action: "written" | "unchanged" | "differs" } {
  if (existsSync(path)) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      // unreadable file is treated as "differs" and rewritten only with --force
    }
    if (current === contents) {
      return { action: "unchanged" };
    }
    if (!force) {
      return { action: "differs" };
    }
  }
  writePolicyFile(path, contents);
  return { action: "written" };
}

function policyShow(args: string[]): string {
  if (args.includes("--help") || args.includes("-h")) {
    return SHOW_HELP;
  }
  const { booleans } = parseArgs("policy show", args, SHOW_FLAGS);
  const full = booleans.has("--full");
  const json = booleans.has("--json");

  const read = loadEffectivePolicy();
  if (!read.ok) {
    throwPolicyError(read.message, read.issues);
  }

  const { policy } = read;
  if (json) {
    return JSON.stringify(policy, null, 2);
  }

  const source = read.source === "file" ? "file" : "built-in default";
  const laneRows = laneSummary(policy);

  const blocks: Array<Record<string, unknown> | string> = [
    {
      policy: {
        source,
        path: collapseHome(read.path),
        version: policy.version,
        reservePercent: policy.routing.reservePercent,
        cooldownSeconds: policy.routing.cooldownSeconds,
        telemetryMaxAgeSeconds: policy.routing.telemetryMaxAgeSeconds,
        maxFallbacks: policy.routing.maxFallbacks,
        agentCeiling: policy.capacity.agentCeiling,
        oneSuiteAtATime: policy.capacity.oneSuiteAtATime,
        memoryFreeReservePercent: policy.capacity.memoryFreeReservePercent,
        maxLoadPerCore: policy.capacity.maxLoadPerCore,
        cursorDefault: policy.pools.cursor.default,
        agyDefault: policy.pools.agy.default,
        opencodeDefault: policy.pools.opencode.default,
        spendPriorityWeight: policy.spendPriority.weight,
        tieBreaker: policy.spendPriority.tieBreaker,
        candidateGroups: Object.keys(policy.candidateGroups).length,
      },
    },
    { lanes: laneRows },
  ];

  if (full) {
    blocks.push({ chain: chainRows(policy) });
  }

  blocks.push(
    helpBlock([
      full
        ? "Run `llm-router-axi policy validate` to verify the file"
        : "Run `llm-router-axi policy show --full` for every candidate chain",
      read.source === "file"
        ? "Run `llm-router-axi policy init --force` to reset to the bundled default"
        : "Run `llm-router-axi policy init` to write this default to disk",
    ]),
  );

  return toon(...blocks);
}

function policyValidate(args: string[]): string {
  if (args.includes("--help") || args.includes("-h")) {
    return VALIDATE_HELP;
  }
  const { values, booleans } = parseArgs("policy validate", args, VALIDATE_FLAGS);
  const json = booleans.has("--json");
  const file = values.get("--file");

  const read = file ? readPolicyFile(file) : loadEffectivePolicy();
  if (!read.ok) {
    throwPolicyError(read.message, read.issues);
  }

  const source = read.source === "file" ? "file" : "built-in default";
  if (json) {
    return JSON.stringify(
      {
        valid: true,
        source,
        path: read.path,
        version: read.policy.version,
        lanes: laneCount(),
        candidateGroups: Object.keys(read.policy.candidateGroups),
      },
      null,
      2,
    );
  }

  return toon(
    {
      policy: {
        valid: true,
        source,
        path: collapseHome(read.path),
        version: read.policy.version,
        lanes: laneCount(),
        candidateGroups: Object.keys(read.policy.candidateGroups).join(", "),
      },
    },
    helpBlock([
      "Run `llm-router-axi policy show --full` to inspect every lane",
      "Run `llm-router-axi route --kind ship --difficulty medium --surface backend` to route a task",
    ]),
  );
}

function throwPolicyError(
  message: string,
  issues: Array<{ path: string; message: string }>,
): never {
  const label = issues.length === 1 ? "issue" : "issues";
  throw new AxiError(
    issues.length > 0 ? `${message} (${issues.length} ${label})` : message,
    "VALIDATION_ERROR",
    [
      ...issues.map((issue) => `${issue.path}: ${issue.message}`),
      "Run `llm-router-axi policy init --force` to restore the bundled default",
      "Run `llm-router-axi policy validate --file <path>` to re-check a file",
    ],
  );
}

function laneCount(): number {
  return KINDS.length * DIFFICULTIES.length;
}

function laneSummary(policy: Policy): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const kind of KINDS) {
    for (const difficulty of DIFFICULTIES) {
      const lane = policy.kinds[kind][difficulty];
      const candidates = resolveLaneCandidates(policy, lane);
      const first = candidates[0];
      rows.push({
        kind,
        difficulty,
        effort: lane.effort,
        candidates: candidates.length,
        first: first ? (first.model ?? first.harness) : "none",
      });
    }
  }
  return rows;
}

function chainRows(policy: Policy): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const kind of KINDS) {
    for (const difficulty of DIFFICULTIES) {
      const lane = policy.kinds[kind][difficulty];
      const candidates = resolveLaneCandidates(policy, lane);
      candidates.forEach((candidate, index) => {
        rows.push({
          kind,
          difficulty,
          order: index + 1,
          harness: candidate.harness,
          provider: candidate.provider,
          pool: candidate.pool ?? "default",
          model: candidate.model ?? "harness-default",
          effort: candidate.effort ?? lane.effort,
        });
      });
    }
  }
  return rows;
}
