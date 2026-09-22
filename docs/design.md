# llm-router-axi design

Status: **P2b implementation (shim-first).** The policy schema/validator and the
routing behavior described below are shipped, plus the three surfaces P3b needs
to delete the fork's dispatch code: `select` (arbitrary-profile selection), the
`route chain` step-down walk, and the `capacity` machine gauges. `route`,
`select`, `explain`, and `record` choose a harness/model/effort from the policy
plus telemetry, print the decision, and persist cooldown and least-recent-use
state. Eligibility, the frozen rejection strings, and `select`'s spendPriority
rotation reproduce the firstmate `fm-dispatch-select.mjs` selector on its 14
fixtures (`test/parity/selector-parity.test.ts` runs the pinned selector side by
side, `test/select.test.ts` runs it through the `select` CLI). `route` layers the
P2c rule on top: the lane's declared chain order is the primary rank, and
headroom/spendPriority only break ties among candidates sharing a chain rank.
Telemetry comes from
`usage-axi --json --full` (or `--usage-json`), reusing a fresh cached document so
a route does not re-pay the slow OpenUsage refresh.

Program context: `axi-router-program` plan (P2). Upstream of this half is P1
`usage-axi`, which produces the telemetry contract the router consumes. Downstream
is P3, which wires firstmate onto the router and deletes the fork-only dispatch
surface.

## 1. Why a policy file

The routing doctrine is a property of the captain's fleet, not of this codebase.
It changes as plans change (an allowance runs out, a model is retired, a
subscription is added). A compiled switch statement would need a release for
each change; a JSON policy file needs an editor.

So the doctrine lives in `~/.config/llm-router-axi/policy.json`:

- `policy init` writes the bundled seed from `src/policy.default.json`.
- `policy show` prints the effective policy (the file if present, else the seed).
- `policy validate` checks it against `policy.schema.json`; a malformed file is
  refused with exit `2` and a JSON-pointer per issue.

The schema is defined once in `src/policy/schema.ts`; `policy.schema.json` is
generated from it (`npm run build:policy-schema -- --check` fails CI on drift) and
is the same object Ajv compiles at runtime. There is no second validator.

Doctrine in the default seed (verbatim from `data/captain-shared.md`):

| Level | Harnesses | Where it appears |
|---|---|---|
| Architect / coordinator | Claude, Codex | `candidateGroups.architects`, kinds `architecture` and `admin` |
| Second-level review | Grok, Gemini (agy), Cursor | `candidateGroups.reviewers`, kind `review` |
| Workers / developers | OpenCode Go first, then free Zen ids, then Grok/Cursor/Gemini subscriptions | `candidateGroups.workers`, kinds `ship` and `scout` |

## 2. Policy schema

Top-level keys (all required; unknown keys are refused):

| Key | Meaning |
|---|---|
| `version` | Schema version, currently `1`. |
| `routing` | `reservePercent` (20), `cooldownSeconds` (1800), `telemetryMaxAgeSeconds` (300), `maxFallbacks` (4). |
| `capacity` | `agentCeiling` (10), `oneSuiteAtATime` (true), `memoryFreeReservePercent` (**10**), `maxLoadPerCore` (2), `memoryPressureMax` (`warn`), `maxSwapUsedPercent` (`null`). |
| `pools` | Split-pool window ids: cursor `auto_usage`/`api_usage`, agy `gemini_5h`/`gemini_weekly` vs `claude_gpt_5h`/`claude_gpt_weekly`, opencode `opencode-go`/`opencode`. |
| `spendPriority` | `weight`, `tieBreaker` (`least-recent-use` \| `declared-order`), `preferKnown`. |
| `candidateGroups` | Named, ordered candidate lists. |
| `kinds` | Lanes keyed by kind, then difficulty. |
| `modelFallback` / `_model_fallback` | harness to ordered model ids for in-run step-down (below). |
| `fallbackLanes` | Ordered harness lanes an exhausted chain moves to. |
| `modelFallbackCycles` | Harnesses whose chain wraps to its head instead of exhausting. |

### 2.4 In-run step-down (`modelFallback`)

The policy carries the same step-down keys as firstmate's
`config/crew-dispatch.json`, so `bin/fm-model-fallback.sh` can read the chain
from the router in P3:

| firstmate `config/crew-dispatch.json` | llm-router-axi `policy.json` |
|---|---|
| `modelFallback` | `modelFallback` (legacy alias `_model_fallback`, refused together) |
| `fallbackLanes` | `fallbackLanes` |
| `modelFallbackCycles` | `modelFallbackCycles` |
| `subscriptionRouting.reservePercent` etc. | `routing.*` |

`route chain --harness H [--model M]` reproduces the fork script's walk: the
entry after the recorded model, a model outside its chain steps to the chain
head, a walked-out cyclic lane wraps to its head, else the next
`fallbackLanes` harness, else `exhausted`. `fm-model-fallback.sh` keeps its
evidence classification and cursor; only the chain walk moves here.

### 2.1 Candidate groups

A candidate declares the identity the router needs to price and spawn it:

```json
{ "harness": "opencode", "provider": "opencode", "pool": "opencode-go",
  "model": "opencode-go/deepseek-v4.1-flash" }
```

- `harness` is one of `claude`, `codex`, `grok`, `cursor`, `agy`, `opencode`
  (the firstmate selector's native set plus `opencode`).
- `provider` is the `usage-axi` provider id used to join telemetry. OpenCode
  profiles carry an explicit provider; without one the selector dies
  `provider identity is unresolved or unsupported` (P0 §3), so the pool is the
  router's job to price.
- `model` is optional; omitted means the harness default.
- `pool` selects the split pool the candidate is priced against (below).
- `effort` optionally overrides the lane effort; `needs` lists capability
  requirements (`vision`, `long-context`, `tools`).

Groups keep the doctrine declared once. `workers` is the ordered
`ship`/`scout` chain, `reviewers` is the review chain, `architects` the
Claude/Codex pair, and `reviewers-escalated` adds Claude/Codex so a `hard` review
can escalate one level up. A lane may also inline a candidate object.

### 2.2 Lanes

```json
"kinds": {
  "review": {
    "easy":   { "effort": "low",    "candidates": ["reviewers"] },
    "medium": { "effort": "medium", "candidates": ["reviewers"] },
    "hard":   { "effort": "high",   "candidates": ["reviewers-escalated"] }
  }
}
```

All five kinds (`ship`, `scout`, `review`, `architecture`, `admin`) define all
three difficulties; the schema refuses a missing lane. The lane decides the
candidate order and the default reasoning effort. `policy validate` additionally
checks that every string in `candidates` resolves to a declared group.

### 2.3 Split pools

One provider can bill more than one pool, and picking the wrong one is how the
old tooling mispriced Cursor (P0 §2: `api_usage` 0% read as provider-wide while
OpenUsage showed Auto at ~99%). `pools` fixes the window ids by name:

| Provider | Default | Windows / pools |
|---|---|---|
| cursor | `auto_usage` | `auto_usage` vs `api_usage` |
| agy | `gemini` | `gemini_5h` + `gemini_weekly` vs `claude_gpt_5h` + `claude_gpt_weekly` |
| opencode | `opencode-go` | `opencode-go` (paid Go) vs `opencode` (free Zen) |

A candidate's `pool` names which one it draws on, so the router prices the
declared pool instead of a provider-wide minimum.

## 3. Command contract

All commands print TOON by default and `--json` as the machine escape hatch.
Errors are structured on stdout; exit codes are `0` success (including
idempotent no-ops), `1` error, `2` usage error (unknown flag, invalid value,
malformed policy). Unknown flags are refused by name with the command's valid
flags inlined, never ignored.

### 3.1 `policy init|show|validate`

| Command | Behavior |
|---|---|
| `policy init [--force] [--json]` | Write the bundled default to the config path. Idempotent: byte-identical file is a no-op; a differing file is left alone unless `--force`. |
| `policy show [--full] [--json]` | Print the effective policy: routing constants, capacity, pools, lane summary (`kind,difficulty,effort,candidates,first`). `--full` expands every candidate chain; `--json` returns the raw policy. |
| `policy validate [--file <path>] [--json]` | Validate the file (or the active policy) against `policy.schema.json` plus group references. Malformed input exits `2`. |

### 3.2 `route`

```
route --kind ship|scout|review|architecture|admin
      --difficulty easy|medium|hard
      --surface backend|frontend|docs|infra|mixed
      [--size <changed-lines>] [--needs vision,long-context,tools]
      [--project <name>] [--json] [--usage-json <path>] [--flags]
```

Inputs are the task descriptor plus a telemetry source (`--usage-json` for a
fixture, otherwise `usage-axi --json --full`).

Output, one TOON decision block:

```
decision:
  harness: opencode
  model: opencode-go/deepseek-v4.1-flash
  effort: medium
  provider: opencode
  pool: opencode-go
  reason: "fresh window weekly headroom=93% reserve=20%"
  fallbacks[]: {harness, model, effort, provider, pool}
  capacity: {ok: true, measured: {...}, reasons: []}
```

- `--json` emits the same object as JSON.
- `--flags` prints exactly `--harness X --model Y --effort Z` for `fm-spawn`
  (an unset axis is omitted; nothing else is printed).
- `reason` and every fallback reuse the selector's diagnostic vocabulary (§5).

**Chain rank** is the lane's declared candidate order (the expanded
`candidates` chain, 1-based). The lowest-ranked *eligible* candidate wins, so
OpenCode Go's first model beats a subscription with more raw headroom; a
candidate is skipped only for reserve, cooldown, stale telemetry, or machine
capacity. Known `spendPriority` (and then least-recent use) breaks a tie only
among candidates that share a chain rank. `select` does not supply ranks, so it
keeps the fork's spendPriority ranking.

**Provider identity** is resolved here, not by the caller. `claude`, `codex`,
`grok`, `cursor`, and `agy` map to the same-named usage-axi provider; `opencode`
maps to provider `opencode` with pool `opencode-go` or `opencode` chosen from
the model prefix (`opencode-go/` vs `opencode/`); `copilot` and `cline` are
routable when usage-axi carries their windows. The selector's fixed
five-provider set is deliberately **not** carried forward.

**Pool pricing** uses the candidate's declared pool (policy `pools` plus
`pool`/`quotaWindow`): cursor `auto_usage`/`api_usage`, agy
`gemini_5h`+`gemini_weekly` vs `claude_gpt_5h`+`claude_gpt_weekly`, opencode Go
vs free. A candidate with no declared pool keeps the conservative provider-wide
minimum. A declared window absent from telemetry fails closed; it is never
repriced on a healthier window.

**Capacity** folds `usage-axi machine{agents, agentCeiling, loadPerCore,
memoryFreePct, suiteSlotFree}` over the local gauges
(`src/machine.ts`, ported from `fm-capacity-lib.sh`) against the policy
thresholds: worker-root agent count, load per core, free-memory reserve, memory
pressure level, optional swap ceiling, and the one-suite slot. The one-suite rule
is an admission purpose, not a blanket refusal: a `spawn` verdict (the default,
and the only one `route` uses) never refuses because a suite is running and keeps
the slot as context, while a `suite` verdict (`capacity --for suite`) refuses when
`oneSuiteAtATime` is true and the slot is occupied. `memoryFreePct`
for the captain's Mac rests at 13-22 percent, so the default reserve is **10**
and `memoryPressureMax` defaults to `warn` (only `critical` refuses); a gauge
that cannot be measured is reported but never refuses on its own.

### 3.3 `explain`

Same descriptor flags as `route` (and deliberately **not** `--flags`). Output is
a `candidates[]` table — `rank` (the 1-based chain position each candidate was
considered at), `harness, provider, pool, model, decision (eligible|refused),
reason` — plus the `selected` candidate and `capacity` verdict, so an operator
can see why each candidate was accepted or dropped.
Rejection reasons are the frozen selector strings, not new prose.

### 3.4 `record`

```
record --provider <name> --outcome rate_limit|ok --task <id> [--json]
```

Records a provider outcome so the router can apply a `routing.cooldownSeconds`
cooldown and update its least-recent-use ledger under
`~/.local/state/llm-router-axi` (XDG-aware; `LLM_ROUTER_STATE_FILE` overrides
the exact file for tests). Output is a receipt
(`provider, outcome, task, cooldownUntil?, statePath`). `rate_limit` parks the
provider; `ok` clears the cooldown. Selection writes the least-recent-use
ledger; both persist across invocations.

### 3.5 `select` (arbitrary-profile compatibility)

```
select [--quota-json <file>] [--now <epoch>] [--reserve-percent N]
       [--telemetry-max-age-seconds N] [--cooldown-seconds N] [--json] [<json>]
```

Accepts firstmate's `fm-dispatch-select.mjs select` input shape: one profile,
a `{use:[...]}` rule object, or a non-empty profile array, on the command line
or stdin. A profile is `harness`, `provider`, `model`, `effort`, `quotaWindow`;
`harness` must be one of the fork's verified set and the resolved provider one
of `claude|codex|grok|cursor|agy`. Every refusal string is the fork's own
(`src/dispatch-profiles.ts`). The same `src/selector.ts` engine runs, so
eligibility, ranking, and diagnostics match `route`. Stdout is exactly the one
compact launch profile `{harness, provider, model?, effort?}` (the pricing
`quotaWindow` is stripped); stderr carries the per-candidate diagnostics; exit
is `0` selected, `2` configuration error, `3` no capacity evidence. Settings
come from the policy `routing` block, overridable by flag.

### 3.6 `capacity` and `classify-evidence`

`capacity [check] [--for <spawn|suite>] [--json]` reports the machine gauges and
the policy verdict. The default `spawn` purpose (what an agent spawn asks) never
refuses on the suite slot; `--for suite` refuses when `oneSuiteAtATime` is true
and the slot is occupied and `check`/`--for suite` exit `1` on a refusal. This is
the surface `bin/fm-capacity.sh` and `fm-test-run.sh` shim onto in P3.
`classify-evidence [--file <path>]`
exposes the shared depletion detector (stdin default) and prints
`classification=none` or `classification=depleted` plus the matched signature.

### 3.7 `route chain`

`route chain --harness H [--model M] [--json]` walks the policy
`modelFallback`/`fallbackLanes`/`modelFallbackCycles` step-down and prints
`action=harness-step|lane-move|exhausted`, `to_model`, `to_harness`, and the
chain. It is the surface `bin/fm-model-fallback.sh` reads in P3.

### 3.8 `classify`, `triage`, `pick`, and `doctor` (Jev slices 1-2: never routes)

Nothing routes real traffic through Jev until the lab's
`docs/when-to-route.md` verdict exists and the captain says go. Slices 1-2
only classify, triage, and advise: none of them changes a routing decision,
`route`/`select` are untouched, and capacity/reserve/cooldown logic is
exactly as is.

`classify --task <text|file|-> [--json] [--full]` sends the task text as
`state` with six `Choice` questions in one `POST /v1/systemone` call
(kind/difficulty/surface reuse the `route` enums; reasoningClass/riskClass/
toolAffinity are classifier-only). Output always carries
`source: jev|fallback` plus a reason on fallback. A core-field answer below
0.5 calibrated confidence falls back; no key, no network, a timeout, or a
client error falls back too, via the deterministic extension/keyword/length
heuristic (`src/jev/fallback.ts`), which implements the same schema with
every field marked `heuristic: true`.

`triage --evidence <text|file|-> [--json] [--full]` types a failure or
worker-outcome evidence string into a closed defect class
(`rate_limit|quota_exhausted|auth|region_refused|tool_error|test_failure|
timeout|unknown`) plus `retryable` and `needsHuman` booleans, each with a
probability (`src/jev/triage.ts`). The Jev path asks one `Choice` (defect)
plus two `Noul` (retryable, needsHuman) questions in a single
`POST /v1/systemone` call; a defect answer below 0.5 calibrated confidence
falls back. The deterministic fallback decides depletion FIRST with the
shared `classify-evidence` vocabulary (`classifyEvidence` in
`src/selector.ts`), so triage can never contradict the depletion detector
(depletion becomes `rate_limit`, or `quota_exhausted` when quota/credit/
allowance wording is present), then falls through keyword heuristics for
the remaining classes. Triage is read-only: it imports no state module and
never changes cooldown, record, or routing state.

`pick --task <text|file|-> --candidate <harness:model> ... [--json]
[--full]` chooses among the caller-named candidates (`src/jev/pick.ts`,
`src/commands/pick.ts`). Output is the `choice` (always one of the
caller's names), a `ranking` of every candidate best-first with
probabilities summing to 1, and `reasons` drawn ONLY from the closed
`PICK_REASON_VALUES` enum (never free text — refused by schema and test).
A candidate is a `harness:model` name (two non-empty sides around one
colon; no doctrine is hard-coded); anything else is refused as an unknown
candidate and an exact repeat as a duplicate, both validation errors. The
Jev path asks `selection` over the names (its probabilities ARE the
ranking) plus `reason` over the enum in one call, with the same 0.5
fallback floor on selection confidence. The deterministic fallback scores
task-fit (name-token overlap with the task text, Laplace-smoothed shares),
ties broken by name. Pick is advisory only: it consults no capacity,
reserve, or cooldown, and nothing calls it from `route`/`select`.

`doctor` reports the `jev` check (key
present yes/no, one read-only `GET /v1/models` probe, latencyMs, active
path); without a key it exits 0 with no network call. The key comes ONLY
from `TYPESAFE_API_KEY` and never appears in any output, error, or fixture
(`test/jev.test.ts` and `test/jev-slice2.test.ts` prove it with a sentinel).
Slice 3 (shadow hook in route + record) builds on `src/jev/client.ts`.

## 4. Routing pipeline (implemented)

The order is fixed by selector parity. `src/router.ts` and `src/selector.ts`
implement it; `src/usage.ts` owns provider identity and pool pricing, and
`src/capacity.ts` owns the machine verdict.

1. **Resolve the lane.** Join `(kind, difficulty)` to a lane and expand its
   ordered candidate chain.
2. **Load telemetry.** A fresh cached `usage-axi` document when one exists,
   else `usage-axi --json --full` (or `--usage-json`). The subprocess budget is
   200s to clear the measured 82-180s OpenUsage refresh, and a successful read is
   cached so the next route is instant. Stale or undated telemetry fails closed.
3. **Eligibility.** For each candidate: telemetry present and fresh
   (`telemetryMaxAgeSeconds`), provider not in cooldown, declared
   quota window present and usable, and headroom above `reservePercent`.
   Provider-wide headroom is the minimum across usable windows; a declared
   `pool` prices that pool instead.
4. **Ranking.** The lane's declared chain order is the rank: the lowest-ranked
   eligible candidate wins. Among candidates that share a chain rank, a known
   `spendPriority` (higher scalar wins, scaled by `spendPriority.weight`) is the
   tie-breaker, then least-recent use. `select` (no chain) keeps the fork's
   spendPriority-first ranking.
5. **Fallbacks.** Emit the next `maxFallbacks` eligible candidates in lane
   order.
6. **Capacity verdict.** Fold in `usage-axi machine{}`: refuse when the fleet is
   at `agentCeiling`, when load per core exceeds `maxLoadPerCore`, or when memory
   free is under `memoryFreeReservePercent`. A `route` spawn admission also never
   refuses on the suite slot; the `oneSuiteAtATime` refusal is confined to the
   `capacity --for suite` purpose. The verdict is `capacity{ok, measured}`.
7. **Accounts.** Where several accounts exist, select the one the ledger marks
   least recently used (ported from `fm-accounts-lib.sh`).

## 5. Selector parity

P2's `select` surface must reproduce `fm-dispatch-select.mjs` byte-for-byte on
the 14 fork tests, so `explain`/`route` reuse its strings rather than inventing
new ones. The shared `src/selector.ts` engine only applies chain-rank ranking
when the caller passes a rank array (`route` does; `select` does not), so the
14 fixtures keep their forced-spendPriority winners. The frozen set (P0 §4.3)
includes:

- `provider telemetry not fresh`
- `provider telemetry has no usable live window percentage`
- `quota headroom <n>% is at or below <reserve>% reserve` (or `window <id> …`)
- `declared quota window <id> is absent from provider telemetry`
- `declared quota window <id> has no usable live percentage`
- `candidate provider=<p> unavailable: cooldown until epoch <n>`
- `no subscription candidate has current dispatch capacity evidence`

The 15 telemetry fields the selector reads (`generatedAt`, `providers[]`, state,
windows, `quotaSemantics.effectiveAvailability[]`) are documented in P0 §4.1 and
must survive into the router's `--usage-json` input unchanged. The router's own
lane/difficulty, `--flags`, and capacity tests are additional — they are not
selector parity and are not counted as such.

## 6. Replacing the fork-only tooling

Once parity tests pass, P3 replaces three scripts with router calls:

| Fork-only file | Becomes |
|---|---|
| `bin/fm-dispatch-select.mjs` (755 lines) | `llm-router-axi select` (arbitrary profiles) plus `route`/`record`/`classify-evidence`; the script becomes a thin shim only while upstream still expects it. |
| `bin/fm-model-fallback.sh` (380 lines input) | Reads its chain from `llm-router-axi route chain`. |
| `bin/fm-capacity.sh` + `fm-capacity-lib.sh` (901 lines) | `llm-router-axi capacity` (gauges + verdict) over `usage-axi machine{}` and the local probes. |
| `config/crew-dispatch.json` | Generated from the router policy, or replaced by a one-line pointer. |

Target: shrink the fork's dispatch-surface diff versus upstream from ~3,648
lines to under 400 (shims + docs). `fm-review.sh` is a separate future
`review-axi`, out of scope here.

The integration seams that make this a swap rather than a rewrite already exist
in the selector: `FM_DISPATCH_QUOTA_AXI=<executable>` and
`select --quota-json <file>`.

## 7. Non-goals for this half

- Wiring firstmate onto the router (P3: shims, policy-generated crew-dispatch,
  deletion of the moved fork code, the diff-shrink numbers).
- Model fallback chains beyond the lane chain (`fm-model-fallback.sh` becomes a
  `route --json` reader in P3); account selection.
- `bin/fm-review.sh` becomes `review-axi`, which is separate and out of scope.

## 8. References

- Program plan §2.2, §4, §5, §6 (`axi-router-program/plan.md`).
- P0 contracts §3, §4, §7 (`axi-p0-contracts/contracts.md`).
- Routing doctrine (`data/captain-shared.md`).
- `src/policy/schema.ts`, `src/policy.default.json`, `policy.schema.json`.
- `src/commands/route.ts`, `explain.ts`, `record.ts`, `policy.ts`.
