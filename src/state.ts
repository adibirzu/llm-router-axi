import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { stateDir } from "./policy/index.js";
import { emptyState, type EngineState } from "./selector.js";

/**
 * Cooldown and least-recent-use ledger, under `~/.local/state/llm-router-axi`
 * (XDG-aware; `LLM_ROUTER_STATE_FILE` overrides the exact file for tests).
 */
export function dispatchStatePath(): string {
  const override = process.env.LLM_ROUTER_STATE_FILE;
  if (override && override.length > 0) return override;
  return join(stateDir(), "dispatch-routing.json");
}

export function homeDir(): string {
  const fmHome = process.env.FM_HOME;
  if (fmHome && fmHome.length > 0) return fmHome;
  return homedir();
}

export function loadState(path: string = dispatchStatePath()): EngineState {
  if (!existsSync(path)) return emptyState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`routing state is unreadable or malformed: ${path}`);
  }
  const state = parsed as Partial<EngineState>;
  if (!state || state.version !== 1 || !Number.isInteger(state.sequence) || (state.sequence as number) < 0) {
    throw new Error("routing state has an unsupported or malformed schema");
  }
  for (const key of ["lastSelected", "profileLastSelected", "cooldowns"] as const) {
    const value = state[key];
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error(`routing state has malformed ${key}`);
    }
  }
  return {
    version: 1,
    sequence: state.sequence as number,
    lastSelected: state.lastSelected as Record<string, number>,
    profileLastSelected: state.profileLastSelected as Record<string, number>,
    cooldowns: state.cooldowns as EngineState["cooldowns"],
  };
}

export function saveState(state: EngineState, path: string = dispatchStatePath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}

/** Serialize state mutations with a private mkdir lock, then publish atomically. */
export function withStateLock<T>(fn: () => T, path: string = dispatchStatePath()): T {
  const lockDir = `${path}.lock`;
  const unlock = acquireLock(lockDir);
  try {
    return fn();
  } finally {
    unlock();
  }
}

function acquireLock(lockDir: string): () => void {
  mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(join(lockDir, "owner"), `${process.pid}\n`, { mode: 0o600 });
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        let owner: number | null = null;
        try {
          owner = Number(readFileSync(join(lockDir, "owner"), "utf8").trim());
          if (Number.isInteger(owner) && owner > 1) process.kill(owner, 0);
        } catch (ownerError) {
          if (owner && (ownerError as NodeJS.ErrnoException).code === "ESRCH") {
            rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        }
        throw new Error("routing state lock remained busy for 5 seconds", { cause: error });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
