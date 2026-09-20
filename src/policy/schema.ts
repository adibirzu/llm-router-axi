/**
 * The published JSON Schema for `~/.config/llm-router-axi/policy.json`.
 *
 * This object is the single source of truth: `policy validate` compiles it with
 * Ajv, and `scripts/build-policy-schema.ts` writes the committed
 * `policy.schema.json` from these same bytes (with a `--check` mode for CI).
 * Keep doctrine out of here — this only shapes the file; the defaults live in
 * `src/policy.default.json`.
 */
export const POLICY_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://raw.githubusercontent.com/adibirzu/llm-router-axi/main/policy.schema.json",
  title: "llm-router-axi policy",
  description:
    "Routing doctrine for llm-router-axi. Human-editable; the router reads this file and never hard-codes a harness, model, or lane in code.",
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "routing",
    "capacity",
    "pools",
    "spendPriority",
    "candidateGroups",
    "kinds",
  ],
  properties: {
    $schema: { type: "string" },
    version: { type: "integer", const: 1 },
    routing: {
      type: "object",
      additionalProperties: false,
      required: [
        "reservePercent",
        "cooldownSeconds",
        "telemetryMaxAgeSeconds",
        "maxFallbacks",
      ],
      properties: {
        reservePercent: {
          type: "integer",
          minimum: 0,
          maximum: 99,
          description:
            "Provider headroom kept in reserve; candidates at or below this remaining percentage are refused.",
        },
        cooldownSeconds: {
          type: "integer",
          minimum: 60,
          maximum: 86400,
          description:
            "How long a verified rate-limit/quota failure parks a provider.",
        },
        telemetryMaxAgeSeconds: {
          type: "integer",
          minimum: 1,
          maximum: 3600,
          description:
            "Maximum age of usage telemetry before it is treated as stale.",
        },
        maxFallbacks: {
          type: "integer",
          minimum: 0,
          maximum: 10,
          description: "How many alternative candidates to emit after the pick.",
        },
      },
    },
    capacity: {
      type: "object",
      additionalProperties: false,
      required: [
        "agentCeiling",
        "oneSuiteAtATime",
        "memoryFreeReservePercent",
        "maxLoadPerCore",
      ],
      properties: {
        agentCeiling: {
          type: "integer",
          minimum: 1,
          maximum: 64,
          description:
            "Machine-wide agent ceiling; the router refuses to route when the fleet is at or above it.",
        },
        oneSuiteAtATime: {
          type: "boolean",
          description:
            "When true, route/explain treat an occupied test-suite slot as a capacity refusal.",
        },
        memoryFreeReservePercent: {
          type: "integer",
          minimum: 0,
          maximum: 99,
          description:
            "Minimum memory-free percentage required before a test suite may start.",
        },
        maxLoadPerCore: {
          type: "number",
          minimum: 0,
          maximum: 64,
          description: "Maximum 1-minute load per core before routing refuses.",
        },
        memoryPressureMax: {
          enum: ["normal", "warn", "ignore"],
          description:
            "Worst kernel memory-pressure level still admitted: normal refuses on warn, warn refuses only on critical, ignore never refuses on pressure.",
        },
        maxSwapUsedPercent: {
          type: ["integer", "null"],
          minimum: 0,
          maximum: 100,
          description:
            "Swap-in-use ceiling in percent; null reports swap without refusing.",
        },
        llamaParallel: {
          type: "integer",
          minimum: 1,
          maximum: 16,
          description:
            "Configured llama.cpp --parallel ceiling for the local qwen fleet (default 2). Enforced only for capacity --for local-llm.",
        },
      },
    },
    pools: {
      type: "object",
      additionalProperties: false,
      required: ["cursor", "agy", "opencode"],
      properties: {
        cursor: {
          type: "object",
          additionalProperties: false,
          required: ["default", "auto", "api"],
          properties: {
            default: { enum: ["auto_usage", "api_usage"] },
            auto: { type: "string", minLength: 1 },
            api: { type: "string", minLength: 1 },
          },
        },
        agy: {
          type: "object",
          additionalProperties: false,
          required: ["default", "gemini", "nonGemini"],
          properties: {
            default: { enum: ["gemini", "nonGemini"] },
            gemini: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 },
            },
            nonGemini: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 },
            },
          },
        },
        opencode: {
          type: "object",
          additionalProperties: false,
          required: ["default", "go", "free"],
          properties: {
            default: { enum: ["opencode-go", "opencode"] },
            go: { type: "string", minLength: 1 },
            free: { type: "string", minLength: 1 },
          },
        },
      },
    },
    spendPriority: {
      type: "object",
      additionalProperties: false,
      required: ["weight", "tieBreaker", "preferKnown"],
      properties: {
        weight: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description:
            "Multiplier applied to a known spendPriority score before ranking.",
        },
        tieBreaker: { enum: ["least-recent-use", "declared-order"] },
        preferKnown: {
          type: "boolean",
          description:
            "When true, a candidate with a known spendPriority outranks one without.",
        },
      },
    },
    candidateGroups: {
      type: "object",
      minProperties: 1,
      additionalProperties: {
        type: "array",
        minItems: 1,
        items: { $ref: "#/definitions/candidate" },
      },
      description:
        "Named, ordered candidate lists. Lanes reference a group by name so the worker/reviewer/architect doctrine is declared once.",
    },
    kinds: { $ref: "#/definitions/kinds" },
    modelFallback: {
      type: "object",
      propertyNames: { $ref: "#/definitions/harness" },
      additionalProperties: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
      },
      description:
        "In-run step-down chains, harness -> ordered model ids. Same key as firstmate config/crew-dispatch.json modelFallback.",
    },
    _model_fallback: {
      type: "object",
      propertyNames: { $ref: "#/definitions/harness" },
      additionalProperties: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
      },
      description:
        "Legacy alias for modelFallback, honored only when modelFallback is absent (firstmate parity).",
    },
    fallbackLanes: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { $ref: "#/definitions/harness" },
      description:
        "Ordered harness lanes an exhausted in-run chain may move to. Same key as firstmate config/crew-dispatch.json fallbackLanes.",
    },
    modelFallbackCycles: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { $ref: "#/definitions/harness" },
      description:
        "Harnesses whose in-run chain wraps to its head instead of exhausting. Same key as firstmate config/crew-dispatch.json modelFallbackCycles.",
    },
  },
  definitions: {
    effort: { enum: ["low", "medium", "high"] },
    harness: {
      enum: [
        "claude",
        "codex",
        "grok",
        "cursor",
        "agy",
        "opencode",
        "copilot",
        "cline",
      ],
    },
    candidate: {
      type: "object",
      additionalProperties: false,
      required: ["harness", "provider"],
      properties: {
        harness: { $ref: "#/definitions/harness" },
        provider: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
        pool: { type: "string", minLength: 1 },
        effort: { $ref: "#/definitions/effort" },
        needs: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    },
    difficultyLane: {
      type: "object",
      additionalProperties: false,
      required: ["effort", "candidates"],
      properties: {
        effort: { $ref: "#/definitions/effort" },
        candidates: {
          type: "array",
          minItems: 1,
          items: {
            oneOf: [
              { type: "string", minLength: 1 },
              { $ref: "#/definitions/candidate" },
            ],
          },
          description:
            "Ordered fallback chain; each entry is a candidateGroups key or an inline candidate.",
        },
      },
    },
    kindLanes: {
      type: "object",
      additionalProperties: false,
      required: ["easy", "medium", "hard"],
      properties: {
        easy: { $ref: "#/definitions/difficultyLane" },
        medium: { $ref: "#/definitions/difficultyLane" },
        hard: { $ref: "#/definitions/difficultyLane" },
      },
    },
    kinds: {
      type: "object",
      additionalProperties: false,
      required: ["ship", "scout", "review", "architecture", "admin"],
      properties: {
        ship: { $ref: "#/definitions/kindLanes" },
        scout: { $ref: "#/definitions/kindLanes" },
        review: { $ref: "#/definitions/kindLanes" },
        architecture: { $ref: "#/definitions/kindLanes" },
        admin: { $ref: "#/definitions/kindLanes" },
      },
    },
  },
} as const;

export type PolicySchema = typeof POLICY_SCHEMA;
