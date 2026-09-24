# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Status and boundaries

- This repo is the P2 **shim-first implementation** of the `axi-router-program`: policy schema/validator plus live `route`/`select`/`check`/`explain`/`capacity`/`record` and `route chain`. Eligibility + frozen diagnostics (+ `select`'s spendPriority rotation) stay at parity with the firstmate selector (`src/selector.ts` is the port; `test/parity/selector-parity.test.ts` and `test/select.test.ts` run the pinned selector side by side). `route` (P2c) ranks by the lane's declared chain order through the optional `ranks` param: the lowest eligible chain rank wins, and headroom/spendPriority only break same-rank ties; `select` passes no ranks. See [docs/design.md](docs/design.md).
- `check --harness H --model M` is the explicit-override gate: it resolves the matching policy candidate group, reuses selector and spawn-capacity refusals, returns the next eligible candidate, and does not rotate least-recent-use state. `--force-override` appends a credential-free audit row to `override-audit.jsonl` (`LLM_ROUTER_OVERRIDE_LOG` overrides the path in tests).
- `test/parity/selector-parity.test.ts` must `realpathSync()` its temp `home` once in `prepare()` before handing it to both the real selector subprocess and this repo's own engine: the tie-break hash is salted with that home, the real selector resolves `FM_HOME` through `fs.realpathSync`, and macOS routes `os.tmpdir()` through `/var` -> `/private/var`, so an unresolved path silently picks a different tied candidate on a real Mac than in CI. If a parity case ever goes flaky again on one machine but not another, suspect an unresolved path in a hashed seam before suspecting the selector logic itself.
- The three P3b shim targets are `select` (arbitrary profiles, `src/dispatch-profiles.ts`), `route chain` (step-down walk, `src/fallback.ts`), and `capacity` (gauges + verdict, `src/machine.ts` + `src/capacity.ts`).
- `capacity` has three admission purposes (`src/capacity.ts` `evaluateGauges`/`capacityVerdict`, default `"spawn"`): a spawn/`route` verdict never refuses because a suite is running or a llama slot is busy (both are context), `capacity --for suite` enforces `oneSuiteAtATime` and is the gate a suite start calls, and `capacity --for local-llm` enforces `capacity.llamaParallel` (the GB10 adi1 `llama.cpp --parallel` ceiling, default 2) and is the gate a local-Qwen agent launch calls. Do not move the suite-slot or llama-slot refusal back into the spawn path. A bare `--for suite`/`--for local-llm` fails closed like `check` does, not only under an explicit `check` verb.
- The routing doctrine is data, not code. It lives in `src/policy.default.json` (the seed `policy init` writes) and the user's `~/.config/llm-router-axi/policy.json`. Never hard-code a harness, model, lane, provider, or pool in `src/`.
- Telemetry comes from `usage-axi --json --full` (override the binary with `LLM_ROUTER_USAGE_AXI`) or `--usage-json`; a fresh document is cached (`LLM_ROUTER_USAGE_CACHE`) and the subprocess budget is 200s for the measured 82-180s OpenUsage refresh (`src/usage.ts`). Provider identity and pool pricing are resolved in `src/usage.ts`. An opencode Go-pool candidate resolves to the live `opencode-go` row (preferring it over the legacy OpenUsage `opencode` row) and is priced on `pools.opencode.goWindows`, because quota-axi reports unknown joint semantics with no pools[]; without that scope the pool min-prices every live window. State (cooldown + least-recent-use ledger) lives under `~/.local/state/llm-router-axi` (`LLM_ROUTER_STATE_FILE` overrides the file).
- Jev slices 1-2 (`src/jev/`, `classify`, `triage`, `pick`, `doctor`) only classify/triage/advise and never affect `route`: `classify` is the task-descriptor classifier while `classify-evidence` stays the depletion detector — do not re-merge them. `triage` reuses the `classify-evidence` vocabulary first so it can never contradict depletion, and is read-only over cooldown/record/routing state; `pick` is advisory only (no capacity/reserve/cooldown, nothing calls it from `route`/`select`) with a closed reason enum. The TypeSafe key comes ONLY from `TYPESAFE_API_KEY` (never a flag) and must never appear in output, errors, logs, or fixtures (`test/jev.test.ts`, `test/jev-slice2.test.ts` enforce this with a sentinel). `src/jev/client.ts` lists the documented-contract gaps.

## Policy schema

- `src/policy/schema.ts` is the single source of truth for the JSON Schema; `policy.schema.json` at the repo root is generated from it and must stay byte-identical (`npm run build:policy-schema -- --check`).
- `policy validate` runs Ajv shape validation plus referential checks: every `candidates` string resolves to a `candidateGroups` key, `modelFallback` and its legacy alias `_model_fallback` are refused together, and a `modelFallbackCycles` lane needs a chain of at least two ids. Unknown top-level or nested keys are refused (`additionalProperties: false`).
- `src/policy.default.json` is read at runtime relative to the module, so the build copies it into `dist/` via `scripts/copy-assets.mjs`. Do not import it as JSON (tsc/NodeNext attribute friction); read it with `readDefaultPolicy()`.
- `test/fixtures/policy/live-mac-mini.policy.json` is a read-only copy of the Mac mini's actual `~/.config/llm-router-axi/policy.json`, validated in `test/policy.test.ts` — a schema change that would break that live file (as `capacity.llamaParallel` did against a schema that hadn't landed it yet) fails CI here instead of the next real `policy.json` install. Re-copy it when the live file's shape legitimately changes; check for secrets before copying (it should only ever hold routing doctrine — harness/pool/model ids, never credentials).

## CLI conventions (AXI)

- CLI plumbing (routing, `--help`, `-v/--version`, the built-in `update`/`update --check`, error framing, exit codes) comes from `axi-sdk-js` `runAxiCli`; the entrypoint `bin/llm-router-axi.ts` answers `--version` before loading the command graph via `axi-sdk-js/fast-path`.
- TOON is the default stdout; `--json` is the escape hatch. `AxiError(..., "VALIDATION_ERROR")` is exit `2` (bad flag/value/policy); a refusal with no eligible candidate or a capacity refusal sets `process.exitCode = 1` and returns a structured `NO_ELIGIBLE_CANDIDATE`/`CAPACITY_REFUSED` block. `route --flags` prints only `--harness X --model Y --effort Z`.
- Flags are parsed per command by `src/args.ts`; an unknown flag is refused by name with the command's valid flags inlined (never silently ignored). `select` deliberately emits the fork's compact launch JSON (not TOON) and exits `3` with the frozen diagnostics on stderr, so it can back a pure shim.
- Machine gauges (`src/machine.ts`: memory pressure, swap, worker-root count, load, suite slot, llama.cpp parallel slots) read `usage-axi machine{}` first, then local probes ported from `fm-capacity-lib.sh`. `LLM_ROUTER_MACHINE_JSON` pins all gauges for tests; the suite sets it in `test/setup.ts`. `LLM_ROUTER_MACHINE_PS_COMM`/`LLM_ROUTER_MACHINE_PS_ARGV` replay a captured two-file `ps` snapshot instead (mirrors usage-axi's `USAGE_AXI_MACHINE_PS_COMM`/`_ARGV`).
- `measureMachine()` always probes the llama.cpp `/slots` endpoint (a real `curl` to adi1, `LLM_ROUTER_LLAMA_SLOTS_URL`) unless disabled — `test/setup.ts` sets `LLM_ROUTER_LLAMA_SLOTS_URL=off` suite-wide so no test spawns that network call; a test that needs a specific busy count sets `LLM_ROUTER_LLAMA_SLOTS_BUSY` instead (an exact count, or the literal `"unknown"`). Any new gauge fixture (`test/fixtures/machine/*.json`) should carry the four `llama*` keys too, since `readMachineFixture()`/`stripNulls` fall through to the live probe for any key the fixture omits.
- The worker-root agent count (`countWorkerRoots`/`readFleet` in `src/machine.ts`) must stay a faithful, invocation-root port of usage-axi's `readFleet` (`src/sources/machine.ts` in adibirzu/usage-axi): a matching descendant collapses into its matching ancestor and Cursor private-worker/worker-start daemons are excluded, so `agents` counts harness invocations, not every matching process. usage-axi has no library `exports`, so it cannot be imported directly — parity is kept by vendoring its ps-snapshot fixtures with their recorded `golden` counts (`test/fixtures/machine/`, see that dir's README) rather than importing its function. `capacity check --json`'s `roots[]` (and the TOON `roots[]` block) is the audit trail behind `agents`, mirroring usage-axi's `machine.roots`.
- `skills/llm-router-axi/SKILL.md` is generated from `src/skill.ts`; regenerate with `npm run build:skill` and check with `-- --check`. The AXI authoring standard is installed under `.agents/skills/axi/`.

## Commands

```sh
npm install
npm run build          # tsc + copy-assets
npm run typecheck
npm run lint
npm test               # vitest: policy validator, CLI contract, router behavior, selector parity
npm run build:skill -- --check
npm run build:policy-schema -- --check
```

## References

- Program plan and P0 contracts live in the coordinator home (`data/axi-router-program/plan.md`, `data/axi-p0-contracts/contracts.md`); the frozen selector rejection strings the router must reuse are listed there and summarized in `docs/design.md` §5.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
