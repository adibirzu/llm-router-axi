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

Status: **P2 implementation.** `route`, `explain`, and `record` are live.
Selection, ranking, fallback, and the machine capacity verdict reproduce the
firstmate `fm-dispatch-select.mjs` selector on its 14 fixtures; the doctrine
itself stays in the policy file, never in code.

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

## Commands

```sh
npx -y llm-router-axi route --kind ship --difficulty medium --surface backend [--flags] [--json]
npx -y llm-router-axi explain --kind review --difficulty hard --surface docs
npx -y llm-router-axi record --provider cursor --outcome rate_limit --task t-42
```

`route` output: `harness, model, effort, provider, pool, reason,
fallbacks[], capacity{ok,measured}`. `--json` emits the same decision as JSON;
`--flags` prints exactly `--harness X --model Y --effort Z` for fm-spawn.

`route` reads usage from `usage-axi --json --full` by default; pass
`--usage-json <path>` to route from a fixture.

Rejection reasons in `explain` reuse the frozen firstmate selector strings, so
the router and `fm-dispatch-select.mjs` stay at parity.

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
