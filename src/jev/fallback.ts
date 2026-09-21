/**
 * Deterministic no-network fallback for `classify`.
 *
 * Extension/keyword/length heuristics over the task text. Returns the SAME
 * {@link ClassifyResult} schema as the Jev path, with every field marked
 * `heuristic: true` and a fixed {@link HEURISTIC_CONFIDENCE} weight, so a
 * reader can never mistake a guess for a calibrated Jev decision.
 *
 * Used when there is no key, no network, a timeout, a client error, or a
 * low-confidence Jev answer. The fleet keeps working with no key and no
 * network because this path needs neither.
 */

import type {
  Difficulty,
  Kind,
  ReasoningClass,
  RiskClass,
  Surface,
  ToolAffinity,
  ClassifyResult,
} from "./schema.js";

/** Fixed weight on every fallback field: a guess, not a calibration. */
export const HEURISTIC_CONFIDENCE = 0.35;

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function countHits(text: string, patterns: RegExp[]): number {
  return patterns.filter((pattern) => pattern.test(text)).length;
}

const KIND_RULES: Array<{ kind: Kind; patterns: RegExp[] }> = [
  {
    kind: "review",
    patterns: [/\breview\b/i, /\bapprove\b/i, /\bpr\b/i, /\bfeedback\b/i, /\blgtm\b/i],
  },
  {
    kind: "architecture",
    patterns: [/\barchitect/i, /\bdesign doc\b/i, /\brfc\b/i, /\badr\b/i, /\btrade-?off/i, /\bproposal\b/i],
  },
  {
    kind: "scout",
    patterns: [/\bexplor/i, /\binvestigat/i, /\bresearch\b/i, /\bsurvey\b/i, /\bspike\b/i, /\bfind out\b/i],
  },
  {
    kind: "admin",
    patterns: [/\bchore\b/i, /\bcleanup\b/i, /\bclean up\b/i, /\brelease\b/i, /\bdependenc/i, /\brenovate\b/i, /\bupgrade\b.*\bdep/i],
  },
];

const SURFACE_SIGNALS: Array<{ surface: Surface; patterns: RegExp[] }> = [
  {
    surface: "frontend",
    patterns: [
      /\.([mc]?tsx?|jsx|css|scss|html|vue|svelte)\b/i,
      /\b(ui|page|component|button|css|stylesheet|rendering|layout)\b/i,
    ],
  },
  {
    surface: "backend",
    patterns: [
      /\.(py|go|rs|java|rb|php)\b/i,
      /\b(api|server|endpoint|handler|middleware|controller|service)\b/i,
    ],
  },
  {
    surface: "docs",
    patterns: [/\.(md|mdx|txt|rst)\b/i, /\b(readme|docs|documentation|guide|changelog)\b/i],
  },
  {
    surface: "infra",
    patterns: [
      /\b(dockerfile|terraform|\.tf\b|kubernetes|k8s|helm|deploy|ci\b|cd\b|pipeline|infra)\b/i,
      /\.(ya?ml|toml)\b.*\b(ci|deploy|workflow)\b/i,
    ],
  },
];

const HIGH_RISK = [/\bprod(uction)?\b/i, /\bmigrat/i, /\bauth\b/i, /\bpayment\b/i, /\bsecur/i, /\bdelet/i, /\bdrop\b.*\btable\b/i, /\birrevers/i, /\bdata loss\b/i];
const LOW_RISK = [/\btypo\b/i, /\bcomment\b/i, /\brename\b/i, /\bwhitespace\b/i, /\bformatting\b/i];

/**
 * Classify without any network call. `cause` names why the Jev path was
 * not used and becomes the result's `reason`.
 */
export function heuristicClassify(task: string, cause: string): ClassifyResult {
  const text = task;
  const lower = text.toLowerCase();

  let kind: Kind = "ship";
  for (const rule of KIND_RULES) {
    if (hasAny(lower, rule.patterns)) {
      kind = rule.kind;
      break;
    }
  }

  const surfaceScores = SURFACE_SIGNALS.map(({ surface, patterns }) => ({
    surface,
    hits: countHits(lower, patterns),
  }));
  const best = Math.max(...surfaceScores.map((entry) => entry.hits));
  const winners = surfaceScores.filter((entry) => entry.hits === best && best > 0);
  const surface: Surface = winners.length === 1 && winners[0] ? winners[0].surface : "mixed";

  const lines = text.split("\n").length;
  const words = text.split(/\s+/).filter(Boolean).length;
  let difficulty: Difficulty = "medium";
  if (lines <= 15 && words <= 150) {
    difficulty = "easy";
  } else if (
    lines > 120 ||
    words > 1500 ||
    hasAny(lower, [/\bmigrat/i, /\brewrite\b/i, /\brefactor\b.*\bacross\b/i, /\bmultiple services\b/i])
  ) {
    difficulty = "hard";
  }

  let reasoningClass: ReasoningClass = "code-gen";
  if (hasAny(lower, [/\berror\b/i, /\bbug\b/i, /\bfail/i, /\bstack ?trace\b/i, /\bpanic\b/i, /\bcrash\b/i])) {
    reasoningClass = "debug";
  } else if (kind === "review") {
    reasoningClass = "review";
  } else if (kind === "architecture") {
    reasoningClass = "architecture";
  } else if (surface === "docs") {
    reasoningClass = "docs";
  }

  let riskClass: RiskClass = "medium";
  if (hasAny(lower, HIGH_RISK)) {
    riskClass = "high";
  } else if (difficulty === "easy" && hasAny(lower, LOW_RISK)) {
    riskClass = "low";
  }

  let toolAffinity: ToolAffinity = "none";
  if (hasAny(lower, [/\bbrowser\b/i, /\bpage\b/i, /\bclick\b/i, /\bcss\b/i, /\bui render/i])) {
    toolAffinity = "browser";
  } else if (hasAny(lower, [/\bsql\b/i, /\bdatabase\b/i, /\bquery\b/i, /\bmigration\b/i])) {
    toolAffinity = "db";
  } else if (hasAny(lower, [/\bmerge\b/i, /\brebase\b/i, /\bbranch\b/i, /\bpull request\b/i])) {
    toolAffinity = "git";
  } else if (hasAny(lower, [/\bscript\b/i, /\bdeploy/i, /\bci\b/i, /\bserver\b/i, /\bcli\b/i, /\bshell\b/i])) {
    toolAffinity = "shell";
  }

  const field = <T>(value: T) => ({ value, confidence: HEURISTIC_CONFIDENCE, heuristic: true });
  return {
    source: "fallback",
    reason: cause,
    kind: field(kind),
    difficulty: field(difficulty),
    surface: field(surface),
    reasoningClass: field(reasoningClass),
    riskClass: field(riskClass),
    toolAffinity: field(toolAffinity),
  };
}
