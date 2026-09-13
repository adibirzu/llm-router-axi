import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createSkillMarkdown } from "../src/skill.js";

describe("installable skill", () => {
  it("keeps skills/llm-router-axi/SKILL.md in sync with src/skill.ts", () => {
    const committed = readFileSync(
      new URL("../skills/llm-router-axi/SKILL.md", import.meta.url),
      "utf8",
    );
    expect(committed).toBe(createSkillMarkdown());
  });

  it("documents the config path and the design-only status", () => {
    const skill = createSkillMarkdown();
    expect(skill).toContain("~/.config/llm-router-axi/policy.json");
    expect(skill).toContain("npx -y llm-router-axi");
    expect(skill).toContain("NOT_IMPLEMENTED");
  });
});
