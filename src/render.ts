import { encode } from "@toon-format/toon";
import { homedir } from "node:os";

/** Collapse the user's home directory to `~` for display. */
export function collapseHome(path: string, home: string = homedir()): string {
  if (path === home) {
    return "~";
  }
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** A TOON `help[n]:` block, the AXI contextual next-step convention. */
export function helpBlock(lines: string[]): string {
  if (lines.length === 0) {
    return "";
  }
  return `help[${lines.length}]:\n${lines.map((line) => `  ${line}`).join("\n")}`;
}

/** Encode one or more blocks to TOON; strings (e.g. help blocks) pass through. */
export function toon(
  ...blocks: Array<Record<string, unknown> | string | undefined>
): string {
  return blocks
    .filter((block): block is Record<string, unknown> | string => block !== undefined)
    .map((block) => (typeof block === "string" ? block : encode(block)))
    .join("\n");
}
