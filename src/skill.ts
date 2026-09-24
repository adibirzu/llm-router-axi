import { DESCRIPTION } from "./description.js";

const BIN = "llm-router-axi";
const CONFIG_PATH = "~/.config/llm-router-axi/policy.json";
const STATE_PATH = "~/.local/state/llm-router-axi";

/**
 * The installable Agent Skill, generated from the same constants the CLI
 * prints. `scripts/build-skill.ts --check` fails CI when it drifts.
 */
export function createSkillMarkdown(): string {
  return `---
name: llm-router-axi
description: >
  Route a task to one harness/model/effort and print fm-spawn flags, from a
  human-editable policy file plus live usage telemetry. Use when dispatching or
  choosing a worker/reviewer model, inspecting the routing doctrine, or
  validating an llm-router-axi policy.
---

# llm-router-axi

${DESCRIPTION}

Status: **P2 implementation.** \`route\`, \`select\`, \`check\`, \`explain\`, \`capacity\`, and
\`record\` are live. Eligibility and diagnostics reproduce the firstmate
\`fm-dispatch-select.mjs\` selector on its 14 fixtures. \`route\` ranks by the
lane's declared chain order (headroom/spendPriority only break same-rank ties);
\`select\` keeps the fork's spendPriority rotation. The doctrine itself stays in
the policy file, never in code.

Run it without a global install:

\`\`\`sh
npx -y ${BIN} policy show
npx -y ${BIN} route --kind ship --difficulty medium --surface backend --flags
\`\`\`

## Policy

The doctrine is a JSON file, not code:

- config: \`${CONFIG_PATH}\`
- state: \`${STATE_PATH}\`

\`\`\`sh
npx -y ${BIN} policy init          # write the bundled default (idempotent)
npx -y ${BIN} policy show --full   # every lane and candidate chain
npx -y ${BIN} policy validate      # check the file against policy.schema.json
\`\`\`

Lanes are keyed by kind (\`ship\`, \`scout\`, \`review\`, \`architecture\`,
\`admin\`) and difficulty (\`easy\`, \`medium\`, \`hard\`). Candidate groups keep
the doctrine declared once: workers use OpenCode Go first, then free Zen ids,
then the Grok/Cursor/Gemini subscriptions; architects are Claude/Codex;
reviewers are Grok/Gemini(agy)/Cursor.

The same file carries the in-run step-down doctrine under \`modelFallback\`
(harness to ordered model ids), \`fallbackLanes\` (lane order), and
\`modelFallbackCycles\`, using the exact keys firstmate's
\`config/crew-dispatch.json\` uses. It also carries the \`capacity\` thresholds
(\`memoryFreeReservePercent\` 10, \`memoryPressureMax\`, \`maxSwapUsedPercent\`,
\`agentCeiling\`, \`maxLoadPerCore\`, \`oneSuiteAtATime\`, \`llamaParallel\`).

## Commands

\`\`\`sh
npx -y ${BIN} route --kind ship --difficulty medium --surface backend [--flags] [--json]
npx -y ${BIN} select --quota-json usage.json '[{"harness":"claude"},{"harness":"codex"}]'
npx -y ${BIN} check --harness opencode --model opencode-go/qwen3.8-flash
npx -y ${BIN} route chain --harness opencode --model opencode-go/qwen3.8-flash
npx -y ${BIN} explain --kind review --difficulty hard --surface docs
npx -y ${BIN} capacity check
npx -y ${BIN} capacity --for suite
npx -y ${BIN} capacity --for local-llm
npx -y ${BIN} record --provider cursor --outcome rate_limit --task t-42
npx -y ${BIN} classify --task "Fix the login retry bug" --json
npx -y ${BIN} triage --evidence "failed: request failed with status code 429" --json
npx -y ${BIN} pick --task "Fix the login retry bug" --candidate opencode:opencode-go/qwen3.8-flash --candidate claude:claude-opus
npx -y ${BIN} doctor
npx -y ${BIN} shadow report
\`\`\`

\`route\` output: \`harness, model, effort, provider, pool, reason,
fallbacks[], capacity{ok,measured}\`. \`--json\` emits the same decision as JSON;
\`--flags\` prints exactly \`--harness X --model Y --effort Z\` for fm-spawn.
\`explain\` lists each candidate with its 1-based chain \`rank\`.

\`select\` accepts firstmate's rule/profile-array input shape
(\`harness/provider/model/effort/quotaWindow\`, a \`{use:[...]}\` rule, or an
array) and prints one compact launch profile, so \`fm-dispatch-select.mjs\` can
become a shim. \`check\` gates an explicit harness/model override on the same
quota, pool, cooldown, runtime-health, and spawn-capacity paths; a refusal names
the exact selector reason and next eligible candidate, while
\`--force-override\` succeeds and appends a credential-free audit record under
\`${STATE_PATH}/override-audit.jsonl\`. \`route chain\` walks the policy \`modelFallback\` /
\`fallbackLanes\` step-down, so \`fm-model-fallback.sh\` can read it. \`capacity\`
reports the machine gauges (memory free percent, memory pressure, swap, agent
count, load, suite slot, llama.cpp parallel slots busy/total) against the
policy thresholds. Spawn admission (the default, and the only thing \`route\`
uses) never refuses because a test suite is running or a llama slot is busy;
\`capacity --for suite\` is the gate a suite start calls, and it refuses when
\`oneSuiteAtATime\` is true and the slot is occupied; \`capacity --for local-llm\`
is the gate a local-Qwen agent launch on adi1 calls, and it refuses when every
configured \`llamaParallel\` slot is busy (probed from
\`LLM_ROUTER_LLAMA_SLOTS_URL\`, default the adi1 llama.cpp \`/slots\` endpoint).

Rejection reasons in \`explain\` and \`select\` reuse the frozen firstmate selector
strings, so the router and \`fm-dispatch-select.mjs\` stay at parity.

\`route\`/\`explain\` read usage from \`usage-axi --json --full\` by default; pass
\`--usage-json <path>\` to route from a fixture. A fresh usage-axi document is
cached and reused so a route does not re-pay the slow OpenUsage refresh.

\`record --outcome rate_limit\` parks the provider for the policy
\`routing.cooldownSeconds\`; \`record --outcome ok\` clears it. Cooldown and
least-recent-use state live under \`${STATE_PATH}\`.

\`classify --task <text|file|->\` (Slice 1) classifies a task into the
\`kind/difficulty/surface\` enums \`route\` accepts plus classifier-only
\`reasoningClass/riskClass/toolAffinity\`, each with confidence. Output
always carries \`source: jev|fallback\` (plus a reason on fallback). Jev is
used only when \`${"TYPESAFE_API_KEY"}\` is set; otherwise a deterministic
heuristic answers with the same schema, so the fleet works with no key and
no network. Slice 1 only classifies: it never changes a routing decision.
\`triage --evidence <text|file|->\` (Slice 2) types failure evidence into
a closed defect class plus \`retryable\`/\`needsHuman\` booleans, each with
a probability; it reuses the \`classify-evidence\` vocabulary first and is
read-only over cooldown/record/routing state. \`pick --task <text|file|->
--candidate <harness:model> ...\` (Slice 2) chooses among caller-named
candidates with a ranked distribution and closed-enum reasons only; it is
advisory (no capacity/reserve/cooldown, nothing calls it from
\`route\`/\`select\`).
\`doctor\` reports the Jev check (key present yes/no, one models-listing
probe, latencyMs, active path); without a key it exits cleanly and makes no
network call. Nothing routes real traffic through Jev until the lab's
\`docs/when-to-route.md\` verdict exists and the captain says go.

Shadow mode (Slice 3) only observes: with \`jev.shadow.enabled: true\` in
the policy (\`policy init\` writes \`false\`), \`route --task <text|file|->\`
additionally classifies the task text with Jev and appends the Jev-derived
descriptor beside the supplied one (plus per-field agreement and a
read-only same-decision preview) to
\`${STATE_PATH}/shadow-ledger.jsonl\`. The decision never changes; the hook
has a 10s total budget and degrades silently to \`fallback\`/\`skipped\`.
\`LLM_ROUTER_JEV_SHADOW=off\` is the kill switch and always wins over the
config. \`record\` appends the outcome to the same ledger; \`shadow report
[--json]\` summarises descriptor agreement, route agreement, and
\`rate_limit\` outcomes plus the go criteria (>= 85% / >= 90% / no rise
over 100+ tasks) as data, never as a routing decision.

## Exit codes

\`\`\`
0  success (including idempotent no-ops)
1  error: no eligible candidate, capacity refused, unreadable telemetry
2  usage error: unknown flag, invalid value, malformed policy
\`\`\`

Default stdout is TOON; \`--json\` is the machine escape hatch.
`;
}
