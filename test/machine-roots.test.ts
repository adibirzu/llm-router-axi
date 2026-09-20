import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { countWorkerRoots, readFleet } from "../src/machine.js";

const FIXTURES = fileURLToPath(new URL("fixtures/machine/", import.meta.url));

function readFixture(name: string): {
  comm: string;
  argv: string;
  golden: { residentMb: number; agents: number; procs: number };
} {
  const comm = readFileSync(`${FIXTURES}${name}.comm.ps`, "utf8");
  const argv = readFileSync(`${FIXTURES}${name}.argv.ps`, "utf8");
  const meta = JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8")) as {
    golden: { residentMb: number; agents: number; procs: number };
  };
  return { comm, argv, golden: meta.golden };
}

describe("invocation-root fleet counting (fixes 15-18 vs 8 agent overcount)", () => {
  it("collapses a real agent's own matching children, ignores a Claude.app GUI helper, and counts a codex node root once", () => {
    // A realistic snapshot: a live `claude` session whose loaded plugin spawned
    // an MCP server as `node` under a path containing `claude-plugins-official`
    // (matches "claude" via argv, but is a *child* of the claude root); the
    // Claude Desktop app's own GUI helper process (never matches: its comm is
    // "Claude Helper (Renderer)", not "node"/"python", so the argv branch never
    // triggers, and comm matching is exact); and a Codex invocation shaped like
    // usage-axi's `codex-triple` fixture (node wrapper -> codex -> codex-code-
    // mode-host, one invocation).
    const comm = [
      "  100     1    4096 claude",
      "  101   100    8192 node",
      "  200     1    1024 /Applications/Claude.app/Contents/MacOS/Claude",
      "  201   200    2048 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)",
      "  300     1    4096 node",
      "  301   300    8192 /opt/homebrew/bin/codex",
      "  302   301    2048 /opt/homebrew/bin/codex-code-mode-host",
    ].join("\n");
    const argv = [
      "100 claude --dangerously-skip-permissions",
      "101 node /Users/adi/.claude/plugins/cache/claude-plugins-official/imessage-mcp/dist/index.js",
      "200 /Applications/Claude.app/Contents/MacOS/Claude",
      "201 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer",
      "300 node /opt/homebrew/bin/codex",
      "301 /opt/homebrew/bin/codex",
      "302 /opt/homebrew/bin/codex-code-mode-host",
    ].join("\n");

    // Before the fix: every matching process is counted independently (no
    // collapse), so this same table reads 5 (claude=1, plugin-cache node
    // child=1, codex triple=3) instead of the 2 real invocation roots.
    const fleet = readFleet(comm, argv);
    expect(fleet.agents).toBe(2);
    expect(countWorkerRoots(comm, argv)).toBe(2);
    expect(fleet.roots).toEqual([
      { pid: 100, comm: "claude", match: "claude", via: "comm" },
      { pid: 300, comm: "node", match: "codex", via: "argv" },
    ]);
  });

  it("reproduces usage-axi's vendored invocation-root goldens (codex-triple, cursor-daemon)", () => {
    for (const name of ["codex-triple", "cursor-daemon"]) {
      const { comm, argv, golden } = readFixture(name);
      const fleet = readFleet(comm, argv);
      expect(
        { residentMb: fleet.residentMb, agents: fleet.agents, procs: fleet.procs },
        `fixture ${name}`,
      ).toEqual(golden);
    }
  });
});
