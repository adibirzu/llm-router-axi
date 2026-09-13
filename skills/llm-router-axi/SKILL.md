---
name: llm-router-axi
description: >
  Route a task to one harness/model/effort and print fm-spawn flags, from a
  human-editable policy file plus live usage telemetry. Use when dispatching or
  choosing a worker/reviewer model, inspecting the routing doctrine, or
  validating an llm-router-axi policy.
---

# llm-router-axi

Policy-driven LLM router: task descriptor plus live usage in, one harness/model/effort decision out.

Status: **P2 implementation.** `route`, `select`, `explain`, `capacity`, and
`record` are live. Eligibility and diagnostics reproduce the firstmate
`fm-dispatch-select.mjs` selector on its 14 fixtures. `route` ranks by the
lane's declared chain order (headroom/spendPriority only break same-rank ties);
`select` keeps the fork's spendPriority rotation. The doctrine itself stays in
the policy file, never in code.

Run it without a global install:

```sh
npx -y llm-router-axi policy show
npx -y llm-router-axi route --kind ship --difficulty medium --surface backend --flags
```

## Policy

The doctrine is a JSON file, not code:

- config: `~/.config/llm-router-axi/policy.json`
- state: `~/.local/state/llm-router-axi`

```sh
npx -y llm-router-axi policy init          # write the bundled default (idempotent)
npx -y llm-router-axi policy show --full   # every lane and candidate chain
npx -y llm-router-axi policy validate      # check the file against policy.schema.json
```

Lanes are keyed by kind (`ship`, `scout`, `review`, `architecture`,
`admin`) and difficulty (`easy`, `medium`, `hard`). Candidate groups keep
the doctrine declared once: workers use OpenCode Go first, then free Zen ids,
then the Grok/Cursor/Gemini subscriptions; architects are Claude/Codex;
reviewers are Grok/Gemini(agy)/Cursor.

The same file carries the in-run step-down doctrine under `modelFallback`
(harness to ordered model ids), `fallbackLanes` (lane order), and
`modelFallbackCycles`, using the exact keys firstmate's
`config/crew-dispatch.json` uses. It also carries the `capacity` thresholds
(`memoryFreeReservePercent` 10, `memoryPressureMax`, `maxSwapUsedPercent`,
`agentCeiling`, `maxLoadPerCore`, `oneSuiteAtATime`).

## Commands

```sh
npx -y llm-router-axi route --kind ship --difficulty medium --surface backend [--flags] [--json]
npx -y llm-router-axi select --quota-json usage.json '[{"harness":"claude"},{"harness":"codex"}]'
npx -y llm-router-axi route chain --harness opencode --model opencode-go/qwen3.8-flash
npx -y llm-router-axi explain --kind review --difficulty hard --surface docs
npx -y llm-router-axi capacity check
npx -y llm-router-axi capacity --for suite
npx -y llm-router-axi record --provider cursor --outcome rate_limit --task t-42
```

`route` output: `harness, model, effort, provider, pool, reason,
fallbacks[], capacity{ok,measured}`. `--json` emits the same decision as JSON;
`--flags` prints exactly `--harness X --model Y --effort Z` for fm-spawn.
`explain` lists each candidate with its 1-based chain `rank`.

`select` accepts firstmate's rule/profile-array input shape
(`harness/provider/model/effort/quotaWindow`, a `{use:[...]}` rule, or an
array) and prints one compact launch profile, so `fm-dispatch-select.mjs` can
become a shim. `route chain` walks the policy `modelFallback` /
`fallbackLanes` step-down, so `fm-model-fallback.sh` can read it. `capacity`
reports the machine gauges (memory free percent, memory pressure, swap, agent
count, load, suite slot) against the policy thresholds. Spawn admission (the
default, and the only thing `route` uses) never refuses because a test suite is
running; `capacity --for suite` is the gate a suite start calls, and it refuses
when `oneSuiteAtATime` is true and the slot is occupied.

Rejection reasons in `explain` and `select` reuse the frozen firstmate selector
strings, so the router and `fm-dispatch-select.mjs` stay at parity.

`route`/`explain` read usage from `usage-axi --json --full` by default; pass
`--usage-json <path>` to route from a fixture. A fresh usage-axi document is
cached and reused so a route does not re-pay the slow OpenUsage refresh.

`record --outcome rate_limit` parks the provider for the policy
`routing.cooldownSeconds`; `record --outcome ok` clears it. Cooldown and
least-recent-use state live under `~/.local/state/llm-router-axi`.

## Exit codes

```
0  success (including idempotent no-ops)
1  error: no eligible candidate, capacity refused, unreadable telemetry
2  usage error: unknown flag, invalid value, malformed policy
```

Default stdout is TOON; `--json` is the machine escape hatch.
