# llm-router-axi design

Status: **P2 implementation.** The policy schema/validator and the routing
behavior described below are shipped. `route`, `explain`, and `record` choose a
harness/model/effort from the policy plus telemetry, print the decision, and
persist cooldown and least-recent-use state. Selection, ranking, and fallback
reproduce the firstmate `fm-dispatch-select.mjs` selector on its 14 fixtures
(`test/parity/selector-parity.test.ts` runs the pinned selector side by side);
the frozen rejection strings below are the parity contract. Telemetry comes from
`usage-axi --json --full` (or `--usage-json`).

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
| `capacity` | `agentCeiling` (10), `oneSuiteAtATime` (true), `memoryFreeReservePercent` (20), `maxLoadPerCore` (2). |
| `pools` | Split-pool window ids: cursor `auto_usage`/`api_usage`, agy `gemini_5h`/`gemini_weekly` vs `claude_gpt_5h`/`claude_gpt_weekly`, opencode `opencode-go`/`opencode`. |
| `spendPriority` | `weight`, `tieBreaker` (`least-recent-use` \| `declared-order`), `preferKnown`. |
| `candidateGroups` | Named, ordered candidate lists. |
| `kinds` | Lanes keyed by kind, then difficulty. |

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
memoryFreePct, suiteSlotFree}` against the policy thresholds; the fleet ceiling,
load, memory reserve, and one-suite slot all refuse a route.

### 3.3 `explain`

Same descriptor flags as `route` (and deliberately **not** `--flags`). Output is
a `candidates[]` table — `harness, provider, pool, model, decision
(eligible|refused), reason` — plus the `selected` candidate and `capacity`
verdict, so an operator can see why each candidate was accepted or dropped.
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

## 4. Routing pipeline (implemented)

The order is fixed by selector parity. `src/router.ts` and `src/selector.ts`
implement it; `src/usage.ts` owns provider identity and pool pricing, and
`src/capacity.ts` owns the machine verdict.

1. **Resolve the lane.** Join `(kind, difficulty)` to a lane and expand its
   ordered candidate chain.
2. **Load telemetry.** `usage-axi --json --full` (or `--usage-json`). Stale or
   undated telemetry fails closed.
3. **Eligibility.** For each candidate: telemetry present and fresh
   (`telemetryMaxAgeSeconds`), provider not in cooldown, declared
   quota window present and usable, and headroom above `reservePercent`.
   Provider-wide headroom is the minimum across usable windows; a declared
   `pool` prices that pool instead.
4. **Ranking.** Known `spendPriority` first (higher scalar wins, scaled by
   `spendPriority.weight`), ties broken by `tieBreaker`, preserving the
   strongest reasoning class the lane needs.
5. **Fallbacks.** Emit the next `maxFallbacks` eligible candidates in lane
   order.
6. **Capacity verdict.** Fold in `usage-axi machine{}`: refuse when the fleet is
   at `agentCeiling`, when load per core exceeds `maxLoadPerCore`, when memory
   free is under `memoryFreeReservePercent`, or when `oneSuiteAtATime` and the
   suite slot is taken. The verdict is `capacity{ok, measured}`.
7. **Accounts.** Where several accounts exist, select the one the ledger marks
   least recently used (ported from `fm-accounts-lib.sh`).

## 5. Selector parity

P2's router must reproduce `fm-dispatch-select.mjs` byte-for-byte on the 14 fork
tests, so `explain` and `route` reuse its strings rather than inventing new ones.
The frozen set (P0 §4.3) includes:

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
| `bin/fm-dispatch-select.mjs` (755 lines) | `llm-router-axi route --json`; the script becomes a thin shim only while upstream still expects it. |
| `bin/fm-model-fallback.sh` (380 lines) | Reads its chain from `llm-router-axi route --json`. |
| `bin/fm-capacity.sh` + `fm-capacity-lib.sh` (901 lines) | `usage-axi machine` for measurement; the router's `capacity{ok}` folds the doctrine. |
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
