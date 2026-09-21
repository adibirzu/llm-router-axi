/**
 * The Jev question set for task classification (Slice 1).
 *
 * One request, six `Choice` questions against the task text as `state`
 * (the documented speculative fan-out pattern: every question sees the
 * same state, is evaluated in parallel, and extra questions cost only
 * tokens). The three core fields reuse the exact enums `route` accepts
 * (`src/commands/descriptor.ts`); the three enrichments are
 * classifier-only and `route` ignores them in this slice.
 */

import {
  DIFFICULTY_VALUES,
  KIND_VALUES,
  SURFACE_VALUES,
} from "../commands/descriptor.js";
import type { JevQuestion } from "./client.js";
import {
  REASONING_CLASS_VALUES,
  RISK_CLASS_VALUES,
  TOOL_AFFINITY_VALUES,
  type Difficulty,
  type Kind,
  type ReasoningClass,
  type RiskClass,
  type Surface,
  type ToolAffinity,
} from "./schema.js";

function criteriaOf(
  values: readonly string[],
  blurbs: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    values.map((value) => [value, blurbs[value] ?? value]),
  );
}

export const CLASSIFY_QUESTIONS: Record<string, JevQuestion> = {
  kind: {
    type: "choice",
    instructions: "What kind of work does this task describe?",
    criteria: criteriaOf(KIND_VALUES, {
      ship: "Implement, fix, or change code to deliver something.",
      scout: "Explore, investigate, or research without changing code yet.",
      review: "Review someone else's change and give feedback.",
      architecture: "Design a system, decide trade-offs, write an RFC or proposal.",
      admin: "Chores: cleanup, releases, dependencies, routine maintenance.",
    }),
  },
  difficulty: {
    type: "choice",
    instructions: "How difficult is this task for a capable engineer?",
    criteria: criteriaOf(DIFFICULTY_VALUES, {
      easy: "Small, well-scoped, under an hour: typo, rename, single-file tweak.",
      medium: "A focused change touching a few files, normal feature or fix.",
      hard: "Large, ambiguous, or risky: migration, rewrite, cross-service refactor.",
    }),
  },
  surface: {
    type: "choice",
    instructions: "Which part of the codebase does this task touch?",
    criteria: criteriaOf(SURFACE_VALUES, {
      backend: "Server-side code, APIs, services, CLIs.",
      frontend: "UI, pages, components, styles, client rendering.",
      docs: "Prose documentation, READMEs, guides.",
      infra: "Deploy, CI/CD, containers, IaC, pipelines.",
      mixed: "More than one of the above, or no clear single surface.",
    }),
  },
  reasoningClass: {
    type: "choice",
    instructions: "What kind of reasoning does this task need?",
    criteria: criteriaOf(REASONING_CLASS_VALUES, {
      "code-gen": "Write new code or extend existing code.",
      debug: "Diagnose a failure: error, bug, crash, failing test.",
      review: "Read and judge a change made by someone else.",
      architecture: "Make structural or design decisions.",
      docs: "Write or restructure prose.",
    }),
  },
  riskClass: {
    type: "choice",
    instructions: "What is the blast radius if this task is done wrong?",
    criteria: criteriaOf(RISK_CLASS_VALUES, {
      low: "Cosmetic or fully reversible: typo, comment, rename.",
      medium: "Normal change with tests and review as the safety net.",
      high: "Production data, auth, payments, migrations, irreversible actions.",
    }),
  },
  toolAffinity: {
    type: "choice",
    instructions: "Which tool family would do most of this task?",
    criteria: criteriaOf(TOOL_AFFINITY_VALUES, {
      browser: "Needs a browser: pages, clicks, visual checks.",
      shell: "Needs a shell: scripts, servers, deploys, CI, CLIs.",
      git: "Mostly version control: merges, rebases, branches, PRs.",
      db: "Mostly data: SQL, queries, migrations.",
      none: "No tool family dominates; plain reasoning or prose.",
    }),
  },
};

export interface MappedField<T> {
  value: T;
  confidence: number;
  probabilities: Record<string, number>;
}

function mapChoice<T extends string>(
  id: string,
  raw: unknown,
  allowed: readonly T[],
): MappedField<T> | { error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: `question "${id}" has no answer` };
  }
  const answer = raw as Record<string, unknown>;
  if (answer.type !== "choice" || typeof answer.choice !== "string") {
    return { error: `question "${id}" did not return a choice answer` };
  }
  // The docs promise answers stay inside the supplied options; verify
  // anyway so an off-list model value can never become a routing input.
  if (!(allowed as readonly string[]).includes(answer.choice)) {
    return { error: `question "${id}" returned an off-list option` };
  }
  if (typeof answer.confidence !== "number") {
    return { error: `question "${id}" returned no confidence` };
  }
  const probabilities =
    typeof answer.probabilities === "object" && answer.probabilities !== null
      ? (answer.probabilities as Record<string, number>)
      : {};
  return { value: answer.choice as T, confidence: answer.confidence, probabilities };
}

export interface MappedClassification {
  kind: MappedField<Kind>;
  difficulty: MappedField<Difficulty>;
  surface: MappedField<Surface>;
  reasoningClass: MappedField<ReasoningClass>;
  riskClass: MappedField<RiskClass>;
  toolAffinity: MappedField<ToolAffinity>;
}

/**
 * Map the six Jev answers to typed fields. Returns an `error` naming the
 * first problem (missing answer, wrong type, off-list option, no
 * confidence) so the caller can fall back with a precise reason.
 */
export function mapClassifyAnswers(
  answers: Record<string, unknown>,
): MappedClassification | { error: string } {
  const kind = mapChoice("kind", answers.kind, KIND_VALUES);
  if ("error" in kind) return kind;
  const difficulty = mapChoice("difficulty", answers.difficulty, DIFFICULTY_VALUES);
  if ("error" in difficulty) return difficulty;
  const surface = mapChoice("surface", answers.surface, SURFACE_VALUES);
  if ("error" in surface) return surface;
  const reasoningClass = mapChoice("reasoningClass", answers.reasoningClass, REASONING_CLASS_VALUES);
  if ("error" in reasoningClass) return reasoningClass;
  const riskClass = mapChoice("riskClass", answers.riskClass, RISK_CLASS_VALUES);
  if ("error" in riskClass) return riskClass;
  const toolAffinity = mapChoice("toolAffinity", answers.toolAffinity, TOOL_AFFINITY_VALUES);
  if ("error" in toolAffinity) return toolAffinity;
  return { kind, difficulty, surface, reasoningClass, riskClass, toolAffinity };
}
