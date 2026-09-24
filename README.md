# llm-router-axi

Part of AXI ([https://axi.md/](https://axi.md/)). A policy-driven LLM router that
turns a task descriptor plus live usage into one harness/model/effort decision
with a fallback chain and the exact spawn flags.

```
route --kind ship --difficulty medium --surface backend
  -> harness opencode, model opencode-go/deepseek-v4.1-flash, effort medium
  -> --harness opencode --model opencode-go/deepseek-v4.1-flash --effort medium
```

> **Status: implementation (P2c).** The policy schema/validator are live, and
> `route`, `select`, `check`, `route chain`, `explain`, `record`, and `capacity` are
> implemented. Eligibility, the frozen rejection strings, and `select`'s
> spendPriority rotation reproduce the firstmate `fm-dispatch-select.mjs` selector
> on its 14 fixtures. `route` ranks by the lane's declared chain order: the
> lowest-ranked eligible candidate wins, and headroom/spendPriority only break
> same-rank ties. Telemetry comes cache-first from `usage-axi --json --full`. See
> [docs/design.md](docs/design.md).

## Why

Firstmate's fork carried ~3,600 lines of dispatch/fallback/capacity logic.
`llm-router-axi` moves the doctrine into one human-editable policy file and the
decision into one CLI, so the fork can shrink to thin shims and stay close to
upstream.

## Install

```sh
git clone https://github.com/adibirzu/llm-router-axi
cd llm-router-axi
npm ci
npm run build
npm install -g --prefix ~/.local .
```

This puts `llm-router-axi` on `PATH` at `~/.local/bin`. Node 22+, no native
dependencies, ARM64-clean.

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
time, `memoryFreeReservePercent` **10** (the captain's Mac rests at 13–22% free).

## Commands

```sh
llm-router-axi route --kind ship --difficulty medium --surface backend [--flags]
llm-router-axi route chain --harness opencode --model opencode-go/qwen3.8-flash
llm-router-axi select --json '<profile or rule>'
llm-router-axi check --harness opencode --model opencode-go/qwen3.8-flash
llm-router-axi explain --kind review --difficulty hard --surface docs
llm-router-axi record --provider cursor --outcome rate_limit --task t-42
llm-router-axi capacity check
llm-router-axi capacity --for local-llm
llm-router-axi classify --task "Fix the login retry bug" --json
llm-router-axi triage --evidence "failed: request failed with status code 429" --json
llm-router-axi pick --task "Fix the login retry bug" --candidate opencode:opencode-go/qwen3.8-flash --candidate claude:claude-opus
llm-router-axi doctor
llm-router-axi shadow report
```

- `route` picks harness/model/effort/provider/pool with a `reason`, ordered
  `fallbacks[]`, and `capacity{ok,measured}`. Usage comes cache-first from
  `usage-axi --json --full` (or `--usage-json <path>`). `--json` for JSON,
  `--flags` for `--harness X --model Y --effort Z` passed straight to `fm-spawn`.
- `route chain` walks the policy `modelFallback`/`fallbackLanes` step-down and
  prints `action=harness-step|lane-move|exhausted`, the next `to_model`/
  `to_harness`, and the chain. This is the surface `fm-model-fallback.sh` reads.
- `select` is the fork-compatibility surface: it accepts firstmate's
  `fm-dispatch-select.mjs` input (a profile, a `{use:[...]}` rule, or a profile
  array) and emits the one compact launch profile, with the frozen diagnostics on
  stderr. It keeps spendPriority rotation because it supplies no chain ranks.
- `check` gates an explicit harness/model override on the same quota, pool,
  cooldown, runtime-health, and spawn-capacity paths as routing. A refusal exits
  `1` with the frozen reason and a next eligible policy candidate that also
  passes machine capacity; `--force-override` succeeds and, only when the
  override would otherwise have been refused, appends a credential-free record under
  `~/.local/state/llm-router-axi/override-audit.jsonl`.
- `explain` shows each candidate (with its 1-based chain rank) and why it was
  accepted or rejected, reusing the firstmate selector's frozen rejection strings.
- `record` feeds rate-limit outcomes back into cooldown and least-recent-use
  state under `~/.local/state/llm-router-axi`.
- `capacity [check] [--for <spawn|suite|local-llm>]` reports the machine gauges
  (including llama.cpp parallel slots busy/total for the adi1 local-Qwen
  fleet) and policy verdict. Spawn admission (the default, and all `route`
  uses) never refuses because a suite is running or a llama slot is busy;
  `--for suite` is the suite-start gate that refuses when `oneSuiteAtATime` is
  true and the slot is occupied; `--for local-llm` is the gate a local-Qwen
  agent launch calls, and refuses when every configured `capacity.llamaParallel`
  slot is busy. `check`, `--for suite`, and `--for local-llm` exit `1` when the
  selected purpose would refuse.

**Chain rank beats raw headroom.** The lane's declared candidate order is the
primary rank (1-based). The lowest-ranked *eligible* candidate wins, so an
OpenCode Go model beats a subscription with more headroom; a candidate is skipped
only for reserve, cooldown, stale telemetry, or machine capacity. `spendPriority`
(and then least-recent use) breaks a tie only among candidates sharing a chain
rank.

## Jev (Slices 1-2: classify, triage, pick — never routes)

> **Nothing routes real traffic through Jev until the lab's
> `docs/when-to-route.md` verdict exists and the captain says go.** These
> slices only classify, triage, and advise — they never affect `route`.

Jev is TypeSafe AI's System One model: typed, calibrated decisions
(classification, routing, scoring, extraction) over unstructured state —
not a text generator. `llm-router-axi` talks to it through a small
fetch-based client (`src/jev/`, built only from the documented
`POST /v1/systemone` + `GET /v1/models` contract):

```sh
llm-router-axi classify --task "Fix the login retry bug in api/auth.py" --json
llm-router-axi classify --task ./TASK.md --full
llm-router-axi triage --evidence "failed: request failed with status code 429" --json
llm-router-axi pick --task "Fix the login retry bug" --candidate opencode:opencode-go/qwen3.8-flash --candidate claude:claude-opus
llm-router-axi doctor
```

- `classify --task <text|file|-> [--json] [--full]` returns the `route`
  enums (`kind`, `difficulty`, `surface`) plus classifier-only
  `reasoningClass`, `riskClass`, `toolAffinity`, each with confidence.
  Output always carries `source: jev|fallback` (and a reason when it fell
  back). A Jev answer below 0.5 confidence on kind/difficulty/surface
  falls back. The deterministic heuristic fallback implements the same
  schema, so the fleet keeps working with no key and no network.
- `triage --evidence <text|file|-> [--json] [--full]` types a failure or
  worker-outcome evidence string into a closed defect class
  (`rate_limit|quota_exhausted|auth|region_refused|tool_error|test_failure|
  timeout|unknown`) plus `retryable` and `needsHuman` booleans, each with
  a probability. The depletion classes reuse the `classify-evidence`
  vocabulary, so triage never contradicts it. The Jev path asks one
  `Choice` plus two `Noul` questions in one call; a defect answer below
  0.5 confidence falls back. Triage is read-only: it never changes
  cooldown, record, or routing state.
- `pick --task <text|file|-> --candidate <harness:model> ... [--json]
  [--full]` chooses among the caller-named candidates and prints the
  choice, a full ranking with probabilities, and reasons drawn ONLY from
  a closed enum (never free text). Unknown (malformed) or duplicate
  candidates are validation errors. The Jev path asks `selection` over
  the names plus `reason` over the enum in one call, with the same 0.5
  fallback floor; the deterministic fallback scores task-fit with ties
  broken by name. Pick is advisory only: it consults no capacity,
  reserve, or cooldown, and nothing calls it from `route`/`select`.
- `doctor` reports the `jev` check: key present yes/no (never the value),
  one `GET /v1/models` probe when a key is present, latency in ms, and the
  active path (`jev|fallback`). Without a key it exits cleanly and makes no
  network call.
- The key comes ONLY from `TYPESAFE_API_KEY` (never a flag); base URL from
  `TYPESAFE_BASE_URL`, model from `TYPESAFE_DEFAULT_MODEL` (default
  `jev-latest`). The key never appears in any output, error, log, or
  fixture. Timeouts are 10s with one bounded retry on 429/529.

### Shadow mode (Slice 3: observe, never route)

> **Nothing routes real traffic through Jev until the lab's
> `docs/when-to-route.md` verdict exists and the captain says go.**
> Shadow records what Jev *would have said* next to every real decision;
> the decision itself always comes from the supplied descriptor.

Off by default. Turn it on in the policy file, kill it instantly from the
environment:

```sh
# on: policy.json -> jev.shadow.enabled = true (policy init writes false)
llm-router-axi route --kind ship --difficulty medium --surface backend \
  --task "Fix the login retry bug in api/auth.py"
llm-router-axi shadow report            # agreement + go criteria as data
LLM_ROUTER_JEV_SHADOW=off llm-router-axi route ...   # kill switch: always wins
```

- `route --task <text|file|->` supplies task text for the shadow hook only;
  routing ignores it. When `jev.shadow.enabled` is true (and the kill
  switch is off), `route` classifies that text in shadow and appends one
  row to `~/.local/state/llm-router-axi/shadow-ledger.jsonl`
  (`LLM_ROUTER_SHADOW_FILE` overrides): the Jev-derived descriptor next to
  the supplied descriptor, per-field agreement, the real decision, and a
  read-only preview of whether the Jev descriptor would have picked the
  same harness/model/effort. The decision, output, and exit code are
  unchanged. Shadow has a hard total budget of one client timeout (10s);
  any Jev error, timeout, missing key, or fallback answer degrades
  silently to a `fallback`/`skipped` row. Disabled (or killed), `route`
  is byte-identical and makes zero network calls.
- `record` additionally appends the outcome (`rate_limit`/`ok`) to the
  same ledger, so agreement and outcome can later be analysed together.
  The cooldown receipt is unchanged; old ledger entries still parse.
- `shadow report [--json]` is read-only (no network, no writes): window
  counts, descriptor agreement per field, route agreement, `rate_limit`
  outcome counts, and the proposed go criteria (descriptor agreement >=
  85%, route agreement >= 90%, no rise in `rate_limit` outcomes over 100+
  tasks) as data, not as a decision. It never turns shadow into live
  routing — a human still calls the verdict.

Every command prints TOON by default; `--json` is the escape hatch. Exit codes:
`0` success, `1` error, `2` usage error. Unknown flags are refused by name.

## Usage telemetry

Telemetry comes from `usage-axi --json --full`. The read is **cache-first**: a
fresh cached document (under `~/.local/state/llm-router-axi`) is reused so a
route does not re-pay the slow OpenUsage refresh, and a stale cache is ignored so
the tool is asked again. The subprocess budget is **200s**
(`USAGE_AXI_TIMEOUT_MS`) to clear the measured 82–180s refresh. Point a route at
a fixture with `--usage-json <path>`, or override the binary with
`LLM_ROUTER_USAGE_AXI` and the cache path with `LLM_ROUTER_USAGE_CACHE`.

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
npm test               # vitest: policy validator + CLI contract + selector parity
npm run build:skill -- --check
npm run build:policy-schema -- --check
```

## License

MIT
