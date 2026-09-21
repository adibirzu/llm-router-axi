import { runAxiCli } from "axi-sdk-js";

import { capacityCommand, CAPACITY_HELP } from "./commands/capacity.js";
import { classifyCommand, CLASSIFY_HELP } from "./commands/classify.js";
import { doctorCommand, DOCTOR_HELP } from "./commands/doctor.js";
import { explainCommand, EXPLAIN_HELP } from "./commands/explain.js";
import { policyCommand } from "./commands/policy.js";
import { recordCommand, RECORD_HELP } from "./commands/record.js";
import { routeCommand } from "./commands/route.js";
import { selectCommand, SELECT_HELP } from "./commands/select.js";
import { taskClassifyCommand, TASK_CLASSIFY_HELP } from "./commands/task-classify.js";
import { DESCRIPTION } from "./description.js";
import { loadEffectivePolicy } from "./policy/index.js";
import { collapseHome, helpBlock, toon } from "./render.js";
import { VERSION } from "./version.js";

export { DESCRIPTION };

const LANE_COUNT = 15;

export const TOP_HELP = `usage: llm-router-axi <route|select|explain|capacity|policy|record|classify|doctor> [flags]
commands[8]:
  policy=<init|show|validate>, route, select, explain, capacity, record, classify, doctor
  route chain=<harness step-down walk>
flags[2]:
  --help, -v/--version
examples:
  llm-router-axi policy show
  llm-router-axi route --kind ship --difficulty medium --surface backend --flags
  llm-router-axi select '{"use":[{"harness":"claude"},{"harness":"codex"}]}' --quota-json usage.json
  llm-router-axi route chain --harness opencode --model opencode-go/qwen3.8-flash
  llm-router-axi explain --kind review --difficulty hard --surface docs
  llm-router-axi capacity check
  llm-router-axi capacity --for suite
  llm-router-axi record --provider cursor --outcome rate_limit --task t-42
  llm-router-axi classify --task "Fix the login retry bug" --json
  llm-router-axi doctor
`;

export type MainOptions = {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
};

export async function main(options: MainOptions = {}): Promise<void> {
  await runAxiCli({
    argv: options.argv ?? process.argv.slice(2),
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    ...(options.stdout ? { stdout: options.stdout } : {}),
    commands: {
      route: (args) => routeCommand(args),
      select: (args) => selectCommand(args),
      explain: (args) => explainCommand(args),
      capacity: (args) => capacityCommand(args),
      "classify-evidence": (args) => classifyCommand(args),
      classify: (args) => taskClassifyCommand(args),
      doctor: (args) => doctorCommand(args),
      record: (args) => recordCommand(args),
      policy: (args) => policyCommand(args),
    },
    home: () => homeView(),
    getCommandHelp: (command) => {
      switch (command) {
        case "route":
          // `route` and its `chain` subcommand own their help so `route chain
          // --help` is not shadowed by the parent help.
          return undefined;
        case "select":
          return SELECT_HELP;
        case "explain":
          return EXPLAIN_HELP;
        case "capacity":
          return CAPACITY_HELP;
        case "classify":
          return TASK_CLASSIFY_HELP;
        case "classify-evidence":
          return CLASSIFY_HELP;
        case "doctor":
          return DOCTOR_HELP;
        case "record":
          return RECORD_HELP;
        default:
          // `policy` owns per-subcommand help inside its handler.
          return undefined;
      }
    },
  });
}

/**
 * Content-first home view: the active policy and its routing constants, so an
 * agent sees the doctrine immediately instead of reading a manual.
 */
function homeView(): string {
  const read = loadEffectivePolicy();
  if (!read.ok) {
    process.exitCode = 1;
    return toon(
      {
        policy: { valid: false, path: collapseHome(read.path) },
        error: read.message,
        code: "VALIDATION_ERROR",
      },
      {
        issues: read.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
      helpBlock([
        "Run `llm-router-axi policy validate` for the full issue list",
        "Run `llm-router-axi policy init --force` to restore the bundled default",
      ]),
    );
  }

  const { policy } = read;
  const source = read.source === "file" ? "file" : "built-in default";
  return toon(
    {
      policy: {
        source,
        path: collapseHome(read.path),
        version: policy.version,
        lanes: LANE_COUNT,
        candidateGroups: Object.keys(policy.candidateGroups).length,
        reservePercent: policy.routing.reservePercent,
        cooldownSeconds: policy.routing.cooldownSeconds,
        telemetryMaxAgeSeconds: policy.routing.telemetryMaxAgeSeconds,
        agentCeiling: policy.capacity.agentCeiling,
        oneSuiteAtATime: policy.capacity.oneSuiteAtATime,
      },
    },
    helpBlock([
      read.source === "file"
        ? "Run `llm-router-axi policy show --full` for every lane"
        : "Run `llm-router-axi policy init` to write the default policy to disk",
      "Run `llm-router-axi route --kind ship --difficulty medium --surface backend` to route a task",
      "Run `llm-router-axi policy validate` to check the active policy",
    ]),
  );
}
