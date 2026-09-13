import { fileURLToPath } from "node:url";

/**
 * Pin the machine gauges for the whole suite. `route`/`explain` merge
 * `usage-axi machine{}` over these, so a test that passes `machine{}` still
 * controls its own capacity fixture; tests that pass none no longer depend on
 * whatever the host is doing. Capacity tests override `LLM_ROUTER_MACHINE_JSON`
 * with their own file.
 */
process.env.LLM_ROUTER_MACHINE_JSON = fileURLToPath(
  new URL("./fixtures/machine/healthy.json", import.meta.url),
);
