// Generates policy.schema.json from src/policy/schema.ts. The TS object is the
// single source of truth used by `policy validate`; the JSON file is the
// published editor/CI artifact.
//
//   npm run build:policy-schema            # write the file
//   npm run build:policy-schema -- --check # fail (exit 1) if stale
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { POLICY_SCHEMA } from "../src/policy/schema.js";

const target = new URL("../policy.schema.json", import.meta.url);
const expected = `${JSON.stringify(POLICY_SCHEMA, null, 2)}\n`;
const check = process.argv.includes("--check");

if (check) {
  let actual: string | null = null;
  try {
    actual = await readFile(target, "utf8");
  } catch {
    // a missing file falls through to the mismatch branch below
  }
  if (actual !== expected) {
    console.error(
      "policy.schema.json is out of date. Run `npm run build:policy-schema` and commit the result.",
    );
    process.exit(1);
  }
  console.log("policy.schema.json is up to date.");
} else {
  await writeFile(target, expected);
  console.log(`Wrote ${fileURLToPath(target)}`);
}
