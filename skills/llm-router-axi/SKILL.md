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

Status: the **policy schema and validator are live**; `route`, `explain`, and
`record` ship the contract and refuse to guess — they exit 1 with code
`NOT_IMPLEMENTED` until the usage-axi contract lands. Do not treat their output
as a routing decision yet.

Run it without a global install:

```sh
npx -y llm-router-axi policy show
npx -y llm-router-axi policy validate
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
npx -y llm-router-axi route --kind ship --difficulty medium --surface backend [--flags]
npx -y llm-router-axi explain --kind review --difficulty hard --surface docs
npx -y llm-router-axi record --provider cursor --outcome rate_limit --task t-42
```

`route` output (planned): `harness, model, effort, provider, pool, reason,
fallbacks[], capacity{ok,measured}`. `--json` emits the same decision as JSON;
`--flags` prints `--harness X --model Y --effort Z` for fm-spawn.

Rejection reasons in `explain` reuse the firstmate selector strings so the
router and `fm-dispatch-select.mjs` stay at parity.

## Exit codes

```
0  success (including idempotent no-ops)
1  error (including design-only NOT_IMPLEMENTED stubs)
2  usage error: unknown flag, invalid value, malformed policy
```

Default stdout is TOON; `--json` is the machine escape hatch.
