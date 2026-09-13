import { helpBlock, toon } from "../render.js";

/**
 * Refuse to fake a decision. Every route/explain/record invocation that parses
 * cleanly lands here until the usage-axi contract (P1) is merged: the design
 * half ships the contract and the policy, never a harness/model choice.
 */
export function notImplemented(
  command: string,
  received: Record<string, unknown>,
  notes: string[],
): string {
  process.exitCode = 1;
  return toon(
    {
      error: `${command} is not implemented in this design-only build`,
      code: "NOT_IMPLEMENTED",
      command,
      received,
      note: "P2 ships the policy schema and command contract only; selection, ranking, fallback, and capacity verdicts land after the usage-axi contract (P1) merges.",
    },
    helpBlock(notes),
  );
}
