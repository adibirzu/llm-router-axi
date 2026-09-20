# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Status and boundaries

- This repo is the P2 **shim-first implementation** of the `axi-router-program`: policy schema/validator plus live `route`/`select`/`explain`/`capacity`/`record` and `route chain`. Eligibility + frozen diagnostics (+ `select`'s spendPriority rotation) stay at parity with the firstmate selector (`src/selector.ts` is the port; `test/parity/selector-parity.test.ts` and `test/select.test.ts` run the pinned selector side by side). `route` (P2c) ranks by the lane's declared chain order through the optional `ranks` param: the lowest eligible chain rank wins, and headroom/spendPriority only break same-rank ties; `select` passes no ranks. See [docs/design.md](docs/design.md).
- The three P3b shim targets are `select` (arbitrary profiles, `src/dispatch-profiles.ts`), `route chain` (step-down walk, `src/fallback.ts`), and `capacity` (gauges + verdict, `src/machine.ts` + `src/capacity.ts`).
- `capacity` has two admission purposes (`src/capacity.ts` `evaluateGauges`/`capacityVerdict`, default `"spawn"`): a spawn/`route` verdict never refuses because a suite is running (the slot is context), while `capacity --for suite` enforces `oneSuiteAtATime` and is the gate a suite start calls. Do not move the suite-slot refusal back into the spawn path.
- The routing doctrine is data, not code. It lives in `src/policy.default.json` (the seed `policy init` writes) and the user's `~/.config/llm-router-axi/policy.json`. Never hard-code a harness, model, lane, provider, or pool in `src/`.
- Telemetry comes from `usage-axi --json --full` (override the binary with `LLM_ROUTER_USAGE_AXI`) or `--usage-json`; a fresh document is cached (`LLM_ROUTER_USAGE_CACHE`) and the subprocess budget is 200s for the measured 82-180s OpenUsage refresh (`src/usage.ts`). Provider identity and pool pricing are resolved in `src/usage.ts`. State (cooldown + least-recent-use ledger) lives under `~/.local/state/llm-router-axi` (`LLM_ROUTER_STATE_FILE` overrides the file).

## Policy schema

- `src/policy/schema.ts` is the single source of truth for the JSON Schema; `policy.schema.json` at the repo root is generated from it and must stay byte-identical (`npm run build:policy-schema -- --check`).
- `policy validate` runs Ajv shape validation plus referential checks: every `candidates` string resolves to a `candidateGroups` key, `modelFallback` and its legacy alias `_model_fallback` are refused together, and a `modelFallbackCycles` lane needs a chain of at least two ids. Unknown top-level or nested keys are refused (`additionalProperties: false`).
- `src/policy.default.json` is read at runtime relative to the module, so the build copies it into `dist/` via `scripts/copy-assets.mjs`. Do not import it as JSON (tsc/NodeNext attribute friction); read it with `readDefaultPolicy()`.

## CLI conventions (AXI)

- CLI plumbing (routing, `--help`, `-v/--version`, the built-in `update`/`update --check`, error framing, exit codes) comes from `axi-sdk-js` `runAxiCli`; the entrypoint `bin/llm-router-axi.ts` answers `--version` before loading the command graph via `axi-sdk-js/fast-path`.
- TOON is the default stdout; `--json` is the escape hatch. `AxiError(..., "VALIDATION_ERROR")` is exit `2` (bad flag/value/policy); a refusal with no eligible candidate or a capacity refusal sets `process.exitCode = 1` and returns a structured `NO_ELIGIBLE_CANDIDATE`/`CAPACITY_REFUSED` block. `route --flags` prints only `--harness X --model Y --effort Z`.
- Flags are parsed per command by `src/args.ts`; an unknown flag is refused by name with the command's valid flags inlined (never silently ignored). `select` deliberately emits the fork's compact launch JSON (not TOON) and exits `3` with the frozen diagnostics on stderr, so it can back a pure shim.
- Machine gauges (`src/machine.ts`: memory pressure, swap, worker-root count, load, suite slot) read `usage-axi machine{}` first, then local probes ported from `fm-capacity-lib.sh`. `LLM_ROUTER_MACHINE_JSON` pins all gauges for tests; the suite sets it in `test/setup.ts`. `LLM_ROUTER_MACHINE_PS_COMM`/`LLM_ROUTER_MACHINE_PS_ARGV` replay a captured two-file `ps` snapshot instead (mirrors usage-axi's `USAGE_AXI_MACHINE_PS_COMM`/`_ARGV`).
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
