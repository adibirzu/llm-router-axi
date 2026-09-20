# Live policy fixture

`live-mac-mini.policy.json` is a verbatim copy of the Mac mini's effective
`~/.config/llm-router-axi/policy.json` (captured 2026-09-21, agentCeiling 15,
`capacity.llamaParallel` present), taken read-only and checked for secrets
before copying — it is routing doctrine only (harness/pool/model ids), never
credentials. `test/policy.test.ts` validates it against `POLICY_SCHEMA` so a
schema change that would break the live file (as `capacity.llamaParallel`
did against PR 10's main before this branch) fails CI instead of the next
`policy.json` install on the Mac mini. Refresh it by re-copying the live file
whenever it legitimately changes shape, not to chase drift in its data
values.
