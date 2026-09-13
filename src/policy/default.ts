import { readFileSync } from "node:fs";

import type { Policy } from "./types.js";

const DEFAULT_POLICY_URL = new URL("../policy.default.json", import.meta.url);

/**
 * The bundled seed policy, read from `policy.default.json` next to this module.
 * It is the same bytes `policy init` writes, so the doctrine stays a data file
 * and never becomes code.
 */
export function readDefaultPolicy(): Policy {
  return JSON.parse(readFileSync(DEFAULT_POLICY_URL, "utf8")) as Policy;
}

export function defaultPolicyJson(): string {
  return readFileSync(DEFAULT_POLICY_URL, "utf8");
}
