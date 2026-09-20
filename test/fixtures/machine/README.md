# Machine ps snapshots

`codex-triple.{comm,argv}.ps` and `cursor-daemon.{comm,argv}.ps`, plus their
`.json` golden metadata, are vendored verbatim from usage-axi's
`test/fixtures/machine/` (adibirzu/usage-axi, `src/sources/machine.ts`
`readFleet`, pinned at commit `2b7790e`). usage-axi is a CLI (no library
`exports`), so its `readFleet`/`countWorkerRoots` cannot be imported directly;
this shared-fixture pair is the parity mechanism instead: both repos' test
suites assert the same `golden.agents` count over the identical two `ps`
snapshots. `test/machine-roots.test.ts` reproduces `golden.agents` from each
fixture here the same way usage-axi's own `test/sources/machine.test.ts` does.

`healthy.json` is unrelated: a `LLM_ROUTER_MACHINE_JSON` gauge-fixture (whole
`MachineGauges` object), not a ps-snapshot pair.
