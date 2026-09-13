import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { readDefaultPolicy } from "./default.js";
import type { Policy } from "./types.js";
import { validatePolicy, type PolicyIssue } from "./validate.js";

export type Env = Record<string, string | undefined>;

export function configDir(env: Env = process.env): string {
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(base, "llm-router-axi");
}

export function configPath(env: Env = process.env): string {
  return join(configDir(env), "policy.json");
}

export function stateDir(env: Env = process.env): string {
  const base =
    env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0
      ? env.XDG_STATE_HOME
      : join(homedir(), ".local", "state");
  return join(base, "llm-router-axi");
}

export type PolicyRead =
  | {
      ok: true;
      policy: Policy;
      source: "file" | "default";
      path: string;
      exists: boolean;
    }
  | {
      ok: false;
      path: string;
      message: string;
      issues: PolicyIssue[];
    };

export function readPolicyFile(path: string): PolicyRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, path, message: `policy file unreadable: ${path}`, issues: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      path,
      message: `policy file is not valid JSON: ${detail}`,
      issues: [],
    };
  }

  const result = validatePolicy(parsed);
  if (!result.ok) {
    return {
      ok: false,
      path,
      message: `policy file failed validation: ${path}`,
      issues: result.issues,
    };
  }
  return { ok: true, policy: result.policy, source: "file", path, exists: true };
}

export function loadEffectivePolicy(env: Env = process.env): PolicyRead {
  const path = configPath(env);
  if (!existsSync(path)) {
    const result = validatePolicy(readDefaultPolicy());
    if (!result.ok) {
      return {
        ok: false,
        path,
        message: "bundled default policy failed validation",
        issues: result.issues,
      };
    }
    return { ok: true, policy: result.policy, source: "default", path, exists: false };
  }
  return readPolicyFile(path);
}

export function writePolicyFile(path: string, json: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json, { mode: 0o644 });
}
