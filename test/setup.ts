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

/**
 * The llama.cpp slots probe is a real curl to adi1; never let a test spawn it.
 * "off" makes `measureMachine()` report the fixture's llama fields untouched,
 * same doctrine as every other gauge here. A test that wants the live-probe
 * path sets `LLM_ROUTER_LLAMA_SLOTS_URL`/`LLM_ROUTER_LLAMA_SLOTS_BUSY` itself.
 */
process.env.LLM_ROUTER_LLAMA_SLOTS_URL = "off";
