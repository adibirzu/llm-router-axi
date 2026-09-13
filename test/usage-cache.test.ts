import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadUsage, USAGE_AXI_TIMEOUT_MS, usageCachePath } from "../src/usage.js";

const NOW = 1000;
const STAMP = "1970-01-01T00:16:40.000Z";
const OLD_STAMP = "1970-01-01T00:00:00.000Z";

function document(generatedAt: string): string {
  return JSON.stringify({
    schemaVersion: 5,
    generatedAt,
    providers: [
      { provider: "claude", state: { status: "fresh", stale: false }, windows: [{ id: "all", percentRemaining: 80 }] },
    ],
  });
}

let dir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-router-cache-"));
  for (const key of ["LLM_ROUTER_USAGE_AXI", "LLM_ROUTER_USAGE_CACHE", "XDG_STATE_HOME"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.LLM_ROUTER_USAGE_CACHE = join(dir, "usage-cache.json");
  process.env.LLM_ROUTER_USAGE_AXI = join(dir, "missing-usage-axi");
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("usage-axi subprocess budget and cache", () => {
  it("allows the measured 82-180s OpenUsage refresh", () => {
    expect(USAGE_AXI_TIMEOUT_MS).toBe(200_000);
  });

  it("serves a fresh cached document without spawning usage-axi", () => {
    writeFileSync(usageCachePath(), document(STAMP));
    const read = loadUsage({ maxAgeSeconds: 300, now: NOW });
    expect(read.available).toBe(true);
    if (read.available) expect(read.data.providers).toHaveLength(1);
  });

  it("ignores a stale cache and fails closed when usage-axi is absent", () => {
    writeFileSync(usageCachePath(), document(OLD_STAMP));
    const read = loadUsage({ maxAgeSeconds: 300, now: NOW });
    expect(read.available).toBe(false);
    if (!read.available) expect(read.reason).toBe("quota-axi unavailable");
  });

  it("spawns usage-axi when the cache is cold, then reuses what it wrote", () => {
    const source = join(dir, "source.json");
    const counter = join(dir, "count");
    const fake = join(dir, "usage-axi-fake");
    writeFileSync(
      fake,
      `#!/bin/sh\nprintf 'x' >> '${counter}'\ncat '${source}'\n`,
    );
    chmodSync(fake, 0o755);
    process.env.LLM_ROUTER_USAGE_AXI = fake;

    const liveNow = Math.floor(Date.now() / 1000);
    writeFileSync(source, document(new Date(liveNow * 1000).toISOString()));

    const first = loadUsage({ maxAgeSeconds: 300, now: liveNow });
    expect(first.available).toBe(true);
    expect(existsSync(usageCachePath())).toBe(true);
    expect(readFileSync(counter, "utf8")).toBe("x");

    const second = loadUsage({ maxAgeSeconds: 300, now: liveNow });
    expect(second.available).toBe(true);
    expect(readFileSync(counter, "utf8")).toBe("x");
  });

  it("reports a malformed fixture rather than throwing", () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    const read = loadUsage({ usageJson: bad });
    expect(read.available).toBe(false);
    if (!read.available) expect(read.reason).toBe("quota telemetry malformed");
  });

  it("reports an unreadable fixture", () => {
    mkdirSync(dir, { recursive: true });
    const read = loadUsage({ usageJson: join(dir, "nope.json") });
    expect(read.available).toBe(false);
    if (!read.available) expect(read.reason).toBe("quota fixture unreadable");
  });
});
