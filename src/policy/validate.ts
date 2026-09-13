import { Ajv, type ErrorObject } from "ajv";

import { POLICY_SCHEMA } from "./schema.js";
import type { Policy } from "./types.js";

export interface PolicyIssue {
  /** JSON pointer to the offending value, or `(root)`. */
  path: string;
  message: string;
}

export type PolicyValidation =
  | { ok: true; policy: Policy }
  | { ok: false; issues: PolicyIssue[] };

const ajv = new Ajv({ allErrors: true, strict: false });
const validateShape = ajv.compile(POLICY_SCHEMA);

/**
 * Validate a parsed policy object. Two layers:
 *
 * 1. JSON Schema shape (`policy.schema.json`) — types, ranges, enums, and
 *    `additionalProperties: false` so a typo is refused rather than ignored.
 * 2. Referential integrity the schema cannot express — every candidate group
 *    name a lane references must be declared under `candidateGroups`.
 */
export function validatePolicy(value: unknown): PolicyValidation {
  const issues: PolicyIssue[] = [];

  if (!validateShape(value)) {
    for (const error of validateShape.errors ?? []) {
      issues.push(toIssue(error));
    }
  }

  if (issues.length === 0) {
    issues.push(...checkGroupReferences(value as Policy));
    issues.push(...checkFallbacks(value as Policy & { _model_fallback?: Record<string, string[]> }));
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, policy: value as Policy };
}

function toIssue(error: ErrorObject): PolicyIssue {
  const path = error.instancePath.length > 0 ? error.instancePath : "(root)";
  const params = error.params as Record<string, unknown>;
  let detail = "";

  switch (error.keyword) {
    case "additionalProperties":
      detail = ` (unexpected property "${String(params.additionalProperty)}")`;
      break;
    case "required":
      detail = ` (missing required property "${String(params.missingProperty)}")`;
      break;
    case "enum": {
      const allowed = Array.isArray(params.allowedValues)
        ? params.allowedValues.join(" | ")
        : "";
      detail = ` (expected one of: ${allowed})`;
      break;
    }
    case "const":
      detail = ` (expected ${JSON.stringify(params.allowedValue)})`;
      break;
    case "minimum":
      detail = ` (must be >= ${String(params.limit)})`;
      break;
    case "maximum":
      detail = ` (must be <= ${String(params.limit)})`;
      break;
    case "minLength":
    case "minItems":
    case "minProperties":
      detail = ` (must have at least ${String(params.limit)})`;
      break;
    default:
      break;
  }

  return { path, message: `${error.message ?? "is invalid"}${detail}` };
}

/**
 * The in-run step-down rules the JSON Schema cannot express: the legacy alias
 * may not shadow the canonical key, and a cyclic lane needs at least two model
 * ids or the wrap would be a no-op. These mirror fm-dispatch-select.mjs's
 * `validate-model-fallback` so the router and firstmate refuse the same files.
 */
function checkFallbacks(
  policy: Policy & { _model_fallback?: Record<string, string[]> },
): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  if (policy.modelFallback !== undefined && policy._model_fallback !== undefined) {
    issues.push({
      path: "/_model_fallback",
      message: "modelFallback and its legacy alias _model_fallback cannot both be declared",
    });
    return issues;
  }
  const chains = policy.modelFallback ?? policy._model_fallback ?? {};
  for (const harness of policy.modelFallbackCycles ?? []) {
    const chain = chains[harness];
    if (!Array.isArray(chain) || chain.length < 2) {
      issues.push({
        path: `/modelFallbackCycles`,
        message: `modelFallbackCycles requires a modelFallback chain with at least two model ids: ${harness}`,
      });
    }
  }
  return issues;
}

function checkGroupReferences(policy: Policy): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const groups = new Set(Object.keys(policy.candidateGroups));

  for (const [kind, lanes] of Object.entries(policy.kinds)) {
    for (const difficulty of ["easy", "medium", "hard"] as const) {
      const lane = lanes[difficulty];
      lane.candidates.forEach((entry, index) => {
        if (typeof entry === "string" && !groups.has(entry)) {
          issues.push({
            path: `/kinds/${kind}/${difficulty}/candidates/${index}`,
            message: `references unknown candidate group "${entry}" (declare it under candidateGroups)`,
          });
        }
      });
    }
  }

  return issues;
}
