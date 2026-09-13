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
