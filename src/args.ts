import { AxiError } from "axi-sdk-js";

export interface FlagSpec {
  /** Canonical flag name, e.g. `--kind`. */
  name: string;
  /** Value placeholder when the flag takes a value; omitted for booleans. */
  value?: string;
  description: string;
}

export interface ParsedArgs {
  values: Map<string, string>;
  booleans: Set<string>;
}

/**
 * Strict per-command flag parsing per the AXI "fail loud on unrecognized
 * input" rule: an unknown flag is refused by name with the command's valid
 * flags inlined, so the agent self-corrects in one turn. `--help` is handled
 * by the caller (or the SDK) before this runs.
 */
export function parseArgs(
  command: string,
  args: string[],
  specs: FlagSpec[],
): ParsedArgs {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const values = new Map<string, string>();
  const booleans = new Set<string>();

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      continue;
    }

    let name = arg;
    let inlineValue: string | undefined;
    if (arg.startsWith("--") && arg.includes("=")) {
      const equals = arg.indexOf("=");
      name = arg.slice(0, equals);
      inlineValue = arg.slice(equals + 1);
    }

    const spec = byName.get(name);
    if (!spec) {
      // Report the flag NAME only: echoing the whole token would print an
      // `--api-key=SECRET` value back into output and errors. The key (or
      // any other secret passed by mistake) must never appear anywhere.
      throw new AxiError(`unknown flag ${name} for \`${command}\``, "VALIDATION_ERROR", [
        `valid flags for \`${command}\`: ${validFlags(specs)}`,
        `Run \`llm-router-axi ${command} --help\` for the contract`,
      ]);
    }

    if (spec.value !== undefined) {
      const value = inlineValue ?? args[++index];
      if (value === undefined || value.startsWith("--")) {
        throw new AxiError(
          `flag ${name} requires a value <${spec.value}>`,
          "VALIDATION_ERROR",
          [`Example: ${name} <${spec.value}>`, `Run \`llm-router-axi ${command} --help\``],
        );
      }
      values.set(name, value);
    } else {
      if (inlineValue !== undefined) {
        throw new AxiError(`flag ${name} takes no value`, "VALIDATION_ERROR", [
          `Remove the value after ${name}`,
        ]);
      }
      booleans.add(name);
    }
  }

  return { values, booleans };
}

export function validFlags(specs: FlagSpec[]): string {
  return specs.map((spec) => spec.name).join(", ");
}

export function requireEnum<T extends string>(
  value: string | undefined,
  flag: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new AxiError(`invalid value for ${flag}: ${value}`, "VALIDATION_ERROR", [
      `${flag} must be one of: ${allowed.join(" | ")}`,
    ]);
  }
  return value as T;
}

export function requireInteger(
  value: string | undefined,
  flag: string,
  minimum = 0,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new AxiError(`invalid value for ${flag}: ${value}`, "VALIDATION_ERROR", [
      `${flag} must be an integer >= ${minimum}`,
    ]);
  }
  return parsed;
}
