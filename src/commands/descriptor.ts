import type { FlagSpec } from "../args.js";

export const KIND_VALUES = [
  "ship",
  "scout",
  "review",
  "architecture",
  "admin",
] as const;

export const DIFFICULTY_VALUES = ["easy", "medium", "hard"] as const;

export const SURFACE_VALUES = [
  "backend",
  "frontend",
  "docs",
  "infra",
  "mixed",
] as const;

/** Flags shared by `route` and `explain` (the task descriptor). */
export const DESCRIPTOR_FLAGS: FlagSpec[] = [
  {
    name: "--kind",
    value: "ship|scout|review|architecture|admin",
    description: "Task kind",
  },
  {
    name: "--difficulty",
    value: "easy|medium|hard",
    description: "Task difficulty",
  },
  {
    name: "--surface",
    value: "backend|frontend|docs|infra|mixed",
    description: "Change surface",
  },
  {
    name: "--size",
    value: "changed-lines",
    description: "Expected changed lines (non-negative integer)",
  },
  {
    name: "--needs",
    value: "vision,long-context,tools",
    description: "Comma-separated capability needs",
  },
  { name: "--project", value: "name", description: "Project name" },
  {
    name: "--usage-json",
    value: "path",
    description: "Read usage telemetry from this file instead of usage-axi",
  },
  { name: "--json", description: "Emit JSON instead of TOON" },
];

/** The decision fields every `route` output will carry once implemented. */
export const DECISION_FIELDS = [
  "harness",
  "model",
  "effort",
  "provider",
  "pool",
  "reason",
  "fallbacks[]",
  "capacity{ok,measured}",
] as const;

export const FM_SPAWN_FLAGS = "--harness X --model Y --effort Z" as const;
