import { runAxiCli } from "axi-sdk-js";

import { explainCommand, EXPLAIN_HELP } from "./commands/explain.js";
import { policyCommand } from "./commands/policy.js";
import { recordCommand, RECORD_HELP } from "./commands/record.js";
import { routeCommand, ROUTE_HELP } from "./commands/route.js";
import { DESCRIPTION } from "./description.js";
import { loadEffectivePolicy } from "./policy/index.js";
import { collapseHome, helpBlock, toon } from "./render.js";
import { VERSION } from "./version.js";

export { DESCRIPTION };

const LANE_COUNT = 15;

export const TOP_HELP = `usage: llm-router-axi <route|explain|policy|record> [flags]
commands[4]:
  policy=<init|show|validate>, route, explain, record
flags[2]:
  --help, -v/--version
examples:
  llm-router-axi policy show
  llm-router-axi route --kind ship --difficulty medium --surface backend
  llm-router-axi explain --kind review --difficulty hard --surface docs
  llm-router-axi record --provider cursor --outcome rate_limit --task t-42
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
      explain: (args) => explainCommand(args),
      record: (args) => recordCommand(args),
      policy: (args) => policyCommand(args),
    },
    home: () => homeView(),
    getCommandHelp: (command) => {
      switch (command) {
        case "route":
          return ROUTE_HELP;
        case "explain":
          return EXPLAIN_HELP;
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
      "Run `llm-router-axi route --kind ship --difficulty medium --surface backend` to route a task (P2)",
      "Run `llm-router-axi policy validate` to check the active policy",
    ]),
  );
}
