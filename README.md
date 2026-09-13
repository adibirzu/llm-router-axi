# llm-router-axi

AXI: policy-driven LLM router that turns a task descriptor plus live usage into
one harness/model/effort decision with a fallback chain and the exact spawn flags.

```
route --kind ship --difficulty medium --surface backend
  -> harness opencode, model opencode-go/deepseek-v4.1-flash, effort medium
  -> --harness opencode --model opencode-go/deepseek-v4.1-flash --effort medium
```

> **Status: implementation (P2).** The policy schema and validator are live, and
> `route`, `explain`, and `record` are implemented. Selection, ranking, and
> fallback reproduce the firstmate `fm-dispatch-select.mjs` selector on its 14
> fixtures; usage comes from `usage-axi --json --full`. See
> [docs/design.md](docs/design.md).

## Why

Firstmate's fork carried ~3,600 lines of dispatch/fallback/capacity logic.
`llm-router-axi` moves the doctrine into one human-editable policy file and the
decision into one CLI, so the fork can shrink to thin shims and stay close to
upstream.

## Install / run

```sh
npx -y llm-router-axi policy show
npm install -g llm-router-axi
llm-router-axi --version
```

Node 22+, no native dependencies, ARM64-clean.

## Policy

The routing doctrine is `~/.config/llm-router-axi/policy.json` — lanes by kind
and difficulty, reserve percent, cooldown, telemetry max age, spendPriority
weighting, per-pool windows, agent ceiling and the one-suite rule.

```sh
llm-router-axi policy init          # write the bundled default (idempotent)
llm-router-axi policy show --full   # every lane and candidate chain
llm-router-axi policy validate      # schema + group-reference check
```

`policy validate` refuses a malformed file with exit `2` and a JSON pointer per
issue. The schema is generated from `src/policy/schema.ts` into
[policy.schema.json](policy.schema.json), so editors and CI share one source of
truth. The seed doctrine is [src/policy.default.json](src/policy.default.json).

Default doctrine: Claude/Codex architect and coordinator; Grok/Gemini(agy)/Cursor
second-level reviewers; workers on OpenCode Go first, then free Zen ids, then the
Grok/Cursor/Gemini subscriptions. Machine ceiling 10 agents, one test suite at a
time, 20% memory reserve.

## Commands

```sh
llm-router-axi route --kind ship --difficulty medium --surface backend [--flags]
llm-router-axi explain --kind review --difficulty hard --surface docs
llm-router-axi record --provider cursor --outcome rate_limit --task t-42
```

- `route` picks harness/model/effort/provider/pool with a `reason`, ordered
  `fallbacks[]`, and `capacity{ok,measured}`. Usage comes from
  `usage-axi --json --full` (or `--usage-json <path>`). `--json` for JSON,
  `--flags` for `--harness X --model Y --effort Z` passed straight to `fm-spawn`.
- `explain` shows each candidate and why it was accepted or rejected, reusing the
  firstmate selector's frozen rejection strings.
- `record` feeds rate-limit outcomes back into cooldown and least-recent-use
  state under `~/.local/state/llm-router-axi`.

Every command prints TOON by default; `--json` is the escape hatch. Exit codes:
`0` success, `1` error, `2` usage error. Unknown flags are refused by name.

## Agent skill

A generated, installable skill lives at
[skills/llm-router-axi/SKILL.md](skills/llm-router-axi/SKILL.md):

```sh
npx skills add adibirzu/llm-router-axi --skill llm-router-axi
```

## Development

```sh
npm install
npm run build          # tsc + copy the runtime policy seed
npm run typecheck
npm run lint
npm test               # vitest: policy validator + CLI contract
npm run build:skill -- --check
npm run build:policy-schema -- --check
```

## License

MIT
