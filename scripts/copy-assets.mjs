// Copies runtime data files that tsc does not emit (it only emits imported
// JSON, and policy.default.json is deliberately read at runtime so the doctrine
// stays a data file). Runs after tsc in the build script.
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/policy.default.json", import.meta.url));
const target = fileURLToPath(new URL("../dist/src/policy.default.json", import.meta.url));

await mkdir(fileURLToPath(new URL("../dist/src/", import.meta.url)), { recursive: true });
await copyFile(source, target);
console.log(`Copied ${target}`);
