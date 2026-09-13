# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Status and boundaries

- This repo is the P2 **design half** of the `axi-router-program`: the policy schema/validator and the command contract, no routing. `route`, `explain`, and `record` are strict stubs that validate flags then exit `1` with `NOT_IMPLEMENTED`; do not add selection, ranking, fallback, or capacity logic until the `usage-axi` contract (P1) is merged. See [docs/design.md](docs/design.md).
- The routing doctrine is data, not code. It lives in `src/policy.default.json` (the seed `policy init` writes) and the user's `~/.config/llm-router-axi/policy.json`. Never hard-code a harness, model, or lane in `src/`.

## Policy schema

- `src/policy/schema.ts` is the single source of truth for the JSON Schema; `policy.schema.json` at the repo root is generated from it and must stay byte-identical (`npm run build:policy-schema -- --check`).
- `policy validate` runs Ajv shape validation plus a referential check that every `candidates` string resolves to a `candidateGroups` key. Unknown top-level or nested keys are refused (`additionalProperties: false`).
- `src/policy.default.json` is read at runtime relative to the module, so the build copies it into `dist/` via `scripts/copy-assets.mjs`. Do not import it as JSON (tsc/NodeNext attribute friction); read it with `readDefaultPolicy()`.

## CLI conventions (AXI)

- CLI plumbing (routing, `--help`, `-v/--version`, the built-in `update`/`update --check`, error framing, exit codes) comes from `axi-sdk-js` `runAxiCli`; the entrypoint `bin/llm-router-axi.ts` answers `--version` before loading the command graph via `axi-sdk-js/fast-path`.
- TOON is the default stdout; `--json` is the escape hatch. `AxiError(..., "VALIDATION_ERROR")` is exit `2`; any other error is exit `1`; a parsed-but-unimplemented stub sets `process.exitCode = 1` and returns a structured `NOT_IMPLEMENTED` block.
- Flags are parsed per command by `src/args.ts`; an unknown flag is refused by name with the command's valid flags inlined (never silently ignored).
- `skills/llm-router-axi/SKILL.md` is generated from `src/skill.ts`; regenerate with `npm run build:skill` and check with `-- --check`. The AXI authoring standard is installed under `.agents/skills/axi/`.

## Commands

```sh
npm install
npm run build          # tsc + copy-assets
npm run typecheck
npm run lint
npm test               # vitest: policy validator (test/policy.test.ts) + CLI contract (test/cli.test.ts)
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
