#!/usr/bin/env node
// Resolve one already-matched set of comparable crew-dispatch candidates.
//
// Usage:
//   fm-dispatch-select.mjs select [--quota-json <file>] [--now <epoch>] [<json>]
//   fm-dispatch-select.mjs record-failure --provider <claude|codex|grok|cursor|agy> --task <id> [--now <epoch>]
//   fm-dispatch-select.mjs clear --provider <claude|codex|grok|cursor|agy>
//   fm-dispatch-select.mjs classify-evidence (--file <path> | with text on stdin)
//   fm-dispatch-select.mjs validate-model-fallback --file <crew-dispatch.json>
//
// `select` accepts a full rule object with `use`, one profile object, or a
// non-empty profile array on the command line or stdin. It prints exactly one
// compact profile JSON object on stdout. Diagnostics are sanitized summaries on
// stderr; quota payloads and harness output are never printed.
//
// The caller owns natural-language rule matching, task fit, reasoning class,
// model support discovery, and provider identity for non-native adapters. This
// script owns only subscription readiness and deterministic distribution:
//
// - Native claude, codex, grok, cursor, and agy profiles resolve to their
//   same-named provider. Other harnesses need an explicit `provider` field.
// - Providers exposed by quota-axi, including Claude, Codex, Grok, Cursor, and
//   agy, require fresh telemetry no older than the configured maximum. Their
//   tightest reported live percentage must remain strictly above the
//   configured reserve. Stale, absent, malformed, or windowless telemetry makes
//   that provider ineligible; it never falls back to an unmetered guess.
// - A profile may declare the one quota window it is actually drawn from with
//   an optional `quotaWindow` field naming a `windows[].id` in that provider's
//   telemetry. The candidate is then priced on that window alone instead of the
//   provider-wide minimum, because a provider whose separate pools are billed
//   separately would otherwise be priced by its worst pool and refused while its
//   own pool is healthy. A declared window that is absent from the live
//   telemetry, or that carries no usable percentage, makes that candidate
//   ineligible; it never falls back to a different, rosier window. No mapping
//   from model name to pool is inferred: the pool is declared in config, where
//   it is checkable and correctable, or it is not used at all.
// - Kimi is deliberately unsupported by this selector: its 0.29.1 lifecycle
//   exit could not be made deterministic after interrupt in the guarded Herdr
//   lab. Explicit Kimi work remains outside automatic subscription dispatch.
// - Rate-limit or quota-exhaustion evidence creates a provider cooldown.
//   `record-failure` verifies the evidence in the named task's status file and
//   verifies that task's recorded routing provider before changing state.
//   Evidence must read in subscription vocabulary - a framed 429, an explicit
//   rate limit, a RESOURCE_EXHAUSTED code, or a named quota/credit/allowance/
//   spending limit being exhausted, depleted, or reached. A context-window or
//   tool-output ceiling is an ordinary working state, so a bare `limit`,
//   `token`, unframed `429`, or plain authorization `403` is refused rather
//   than parking the provider for a whole cooldown. This one vocabulary is
//   also the depletion detector behind `bin/fm-model-fallback.sh`: the
//   `classify-evidence` subcommand exposes it as a pure stdin/file
//   classification so every consumer shares one owner instead of each
//   re-spelling quota vocabulary.
// - Among eligible candidates, a known spendPriority from quota-axi is the
//   quota-perspective ranker: the highest known scalar wins. When every
//   remaining eligible candidate lacks a known scalar, or when known scalars
//   tie, providers rotate by least-recent selection. Hash ordering breaks a
//   never-used tie independently of candidate array order, then persisted
//   last-use state gives exact round-robin behavior while the eligible set is
//   stable. Profiles within one provider rotate the same way.
// - State updates are serialized by a private mkdir lock and published through
//   rename. No task is selected when every candidate is unavailable.
//
// A profile priced on its own pool looks like this:
//   { "harness": "cursor", "model": "cursor-grok-4.6-high", "quotaWindow": "auto_usage" }
//   { "harness": "agy", "model": "gemini-3.7-flash-high", "quotaWindow": "gemini_5h" }
//
// config/crew-dispatch.json may contain this optional settings object:
//   "subscriptionRouting": {
//     "reservePercent": 20,
//     "telemetryMaxAgeSeconds": 300,
//     "cooldownSeconds": 1800
//   }
// The defaults above are used when the object or a field is absent. Exact schema
// validation is shared with bootstrap. FM_HOME must be explicit so routing state
// can never land in the wrong Firstmate home.
//
// Test-only seams:
//   --quota-json reads a fixture instead of running quota-axi.
//   --now fixes the current epoch second.
//   FM_DISPATCH_QUOTA_AXI overrides the quota-axi executable.
//   FM_DISPATCH_STATE_FILE overrides the state path.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Routable providers must have a credit-identity in quota-axi so the selector
// can test capacity and redirect. quota-axi reports claude, codex, grok,
// cursor, and agy. cline is deliberately absent: it is BYO-API-key with no
// subscription window quota-axi can read, so it stays spawn-only (a single
// non-array profile), never a credit-routed candidate. Same for pi/opencode.
// copilot has telemetry too and could be added the same way if wanted.
const PROVIDERS = new Set(['claude', 'codex', 'grok', 'cursor', 'agy']);
const VERIFIED_HARNESSES = new Set(['claude', 'codex', 'opencode', 'pi', 'pi-signed', 'grok', 'kimi', 'cursor', 'muse', 'agy', 'cline', 'copilot']);
const NATIVE_PROVIDER = new Map([
  ['claude', 'claude'],
  ['codex', 'codex'],
  ['grok', 'grok'],
  // The cursor harness draws on the Cursor subscription, which quota-axi
  // reports under the provider name `cursor`.
  ['cursor', 'cursor'],
  // agy draws on the Google AI subscription, reported as provider `agy`.
  ['agy', 'agy'],
]);
const DEFAULTS = Object.freeze({
  reservePercent: 20,
  telemetryMaxAgeSeconds: 300,
  cooldownSeconds: 1800,
});
const LIMITS = Object.freeze({
  reservePercent: [0, 99],
  telemetryMaxAgeSeconds: [1, 3600],
  cooldownSeconds: [60, 86400],
});
// Keep this narrow: both consumers of this gate park a provider for a whole
// cooldown on a single match, so an ordinary working state ("context token
// limit reached", "exceeded the tool output limit") must not reach it. The
// subscription-vocabulary contract these alternatives encode is stated in the
// evidence bullet of the header help above.
const RATE_LIMIT_RE = new RegExp([
  '(?:http|status|code|error|response)[^\\n]{0,16}\\b429\\b',
  // A framed 403 is an authorization code, so it counts only when budget
  // vocabulary shares the line - "403 spending limit reached", never a plain
  // forbidden/auth error.
  '(?:spending|budget|credit|balance|quota)[^\\n]{0,80}\\b403\\b',
  '\\b403\\b[^\\n]{0,80}(?:spending|budget|credit|balance|quota)',
  'rate[ _-]?limit',
  'too many requests',
  'resource[ _-]?exhausted',
  'insufficient[ _-]?(?:quota|credits?|balance|funds)',
  'out of (?:quota|credits?|tokens?|balance)',
  'credit balance is too low',
  'spending[ _-]?limit',
  '(?:quota|usage|spending|allowance|subscription|credits?|balance|monthly|weekly|daily|session)[^\\n]{0,80}(?:exhaust|deplet|used up|limit|reach|exceed|zero)',
  '(?:exhaust|deplet|reach|exceed)[^\\n]{0,80}(?:quota|usage|spending|allowance|credits?|balance)',
].join('|'), 'i');

class CliError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

function die(message, code = 2) {
  throw new CliError(message, code);
}

function log(message) {
  process.stderr.write(`fm-dispatch-select: ${message}\n`);
}

function usage() {
  const source = fs.readFileSync(new URL(import.meta.url), 'utf8');
  const lines = source.split('\n').slice(1);
  for (const line of lines) {
    if (!line.startsWith('//')) break;
    process.stderr.write(`${line.replace(/^\/\/? ?/, '')}\n`);
  }
}

function parseArgs(argv) {
  const command = argv[0]?.startsWith('-') || argv.length === 0 ? 'select' : argv.shift();
  const options = { command, positional: [] };
  while (argv.length) {
    const arg = argv.shift();
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (['--quota-json', '--now', '--provider', '--task', '--file'].includes(arg)) {
      if (!argv.length) die(`${arg} requires a value`);
      options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv.shift();
    } else if (arg === '--') {
      options.positional.push(...argv);
      break;
    } else if (arg.startsWith('-')) {
      die(`unknown option ${arg}`);
    } else {
      options.positional.push(arg);
    }
  }
  return options;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    die(`${label} is missing, unreadable, or malformed`);
  }
}

function explicitHome() {
  const home = process.env.FM_HOME;
  if (!home) die('FM_HOME must be explicit');
  try {
    return fs.realpathSync(home);
  } catch {
    die(`FM_HOME is not a readable directory: ${home}`);
  }
}

function operationalPaths(home) {
  const stateDir = process.env.FM_STATE_OVERRIDE || path.join(home, 'state');
  const configDir = process.env.FM_CONFIG_OVERRIDE || path.join(home, 'config');
  const stateFile = process.env.FM_DISPATCH_STATE_FILE || path.join(stateDir, '.dispatch-routing.json');
  return { stateDir, configDir, stateFile, lockDir: `${stateFile}.lock` };
}

function settingsFromConfig(configDir) {
  const file = path.join(configDir, 'crew-dispatch.json');
  if (!fs.existsSync(file)) return { ...DEFAULTS };
  const root = readJson(file, 'config/crew-dispatch.json');
  if (!root || Array.isArray(root) || typeof root !== 'object') {
    die('config/crew-dispatch.json must be an object');
  }
  const configured = root.subscriptionRouting ?? {};
  if (!configured || Array.isArray(configured) || typeof configured !== 'object') {
    die('config/crew-dispatch.json subscriptionRouting must be an object');
  }
  const settings = { ...DEFAULTS };
  for (const [key, value] of Object.entries(configured)) {
    if (!(key in LIMITS)) die(`config/crew-dispatch.json subscriptionRouting has unknown field: ${key}`);
    const [min, max] = LIMITS[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      die(`config/crew-dispatch.json subscriptionRouting.${key} must be an integer from ${min} to ${max}`);
    }
    settings[key] = value;
  }
  return settings;
}

function validateModelFallbackConfig(config) {
  if (!config || Array.isArray(config) || typeof config !== 'object') {
    die('config/crew-dispatch.json must be an object');
  }
  if (Object.hasOwn(config, 'modelFallback') && Object.hasOwn(config, '_model_fallback')) {
    die('modelFallback and its legacy alias _model_fallback cannot both be declared');
  }
  const fallback = config.modelFallback ?? config._model_fallback;
  if (fallback !== undefined) {
    if (!fallback || Array.isArray(fallback) || typeof fallback !== 'object') {
      die('modelFallback must be an object mapping a harness to its ordered model chain');
    }
    for (const [harness, chain] of Object.entries(fallback)) {
      if (!VERIFIED_HARNESSES.has(harness)) die(`modelFallback has an unverified harness: ${harness}`);
      if (!Array.isArray(chain) || !chain.length || chain.some((model) => typeof model !== 'string' || !model)) {
        die(`modelFallback chain must be a non-empty array of non-empty model ids: ${harness}`);
      }
      if (new Set(chain).size !== chain.length) {
        die(`modelFallback chain has duplicate model ids, which would make the step-down order ambiguous: ${harness}`);
      }
    }
  }
  if (Object.hasOwn(config, 'modelFallbackCycles')) {
    const cycles = config.modelFallbackCycles;
    if (!Array.isArray(cycles) || !cycles.length) {
      die('modelFallbackCycles must be a non-empty array of verified harness names');
    }
    const invalidCycles = cycles.filter((harness) => typeof harness !== 'string' || !VERIFIED_HARNESSES.has(harness));
    if (invalidCycles.length) {
      die(`modelFallbackCycles has a non-string or unverified harness entry: ${invalidCycles.join(', ')}`);
    }
    if (new Set(cycles).size !== cycles.length) {
      die('modelFallbackCycles has duplicate entries; a cyclic lane must be named once');
    }
    for (const harness of cycles) {
      const chain = fallback?.[harness];
      if (!Array.isArray(chain) || chain.length < 2) {
        die(`modelFallbackCycles requires a modelFallback chain with at least two model ids: ${harness}`);
      }
    }
  }
  if (Object.hasOwn(config, 'fallbackLanes')) {
    const lanes = config.fallbackLanes;
    if (!Array.isArray(lanes) || !lanes.length) {
      die('fallbackLanes must be a non-empty array of verified harness names');
    }
    const invalidLanes = lanes.filter((harness) => typeof harness !== 'string' || !VERIFIED_HARNESSES.has(harness));
    if (invalidLanes.length) {
      die(`fallbackLanes has a non-string or unverified harness entry: ${invalidLanes.join(', ')}`);
    }
    if (new Set(lanes).size !== lanes.length) {
      die('fallbackLanes has duplicate entries; a lane order must name each runtime once');
    }
  }
}

function validateModelFallback(options) {
  if (!options.file || options.positional.length) die('validate-model-fallback requires exactly --file <crew-dispatch.json>');
  const config = readJson(options.file, 'config/crew-dispatch.json');
  validateModelFallbackConfig(config);
}

function emptyState() {
  return {
    version: 1,
    sequence: 0,
    lastSelected: {},
    profileLastSelected: {},
    cooldowns: {},
  };
}

function loadState(file) {
  if (!fs.existsSync(file)) return emptyState();
  const state = readJson(file, 'dispatch routing state');
  if (!state || state.version !== 1 || !Number.isInteger(state.sequence) || state.sequence < 0) {
    die('dispatch routing state has an unsupported or malformed schema');
  }
  for (const key of ['lastSelected', 'profileLastSelected', 'cooldowns']) {
    if (!state[key] || Array.isArray(state[key]) || typeof state[key] !== 'object') {
      die(`dispatch routing state has malformed ${key}`);
    }
  }
  return state;
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}

function acquireLock(lockDir) {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      fs.writeFileSync(path.join(lockDir, 'owner'), `${process.pid}\n`, { mode: 0o600 });
      return () => fs.rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        let owner = null;
        try {
          owner = Number(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8').trim());
          if (Number.isInteger(owner) && owner > 1) process.kill(owner, 0);
        } catch (error) {
          if (owner && error.code === 'ESRCH') {
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        }
        die('routing state lock remained busy for 5 seconds', 3);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function profileProvider(profile) {
  return profile.provider || NATIVE_PROVIDER.get(profile.harness) || null;
}

// The emitted profile stays launch-shaped: quotaWindow is a pricing declaration
// consumed here, never a launch flag, so it is reported on stderr and kept out
// of stdout. It still joins the identity below, so two candidates that share a
// concrete route but declare different pools stay distinct entries.
function cleanProfile(profile, provider) {
  return {
    harness: profile.harness,
    provider,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.effort ? { effort: profile.effort } : {}),
  };
}

function parseProfiles(input) {
  let value;
  try {
    value = JSON.parse(input);
  } catch {
    die('dispatch input is malformed JSON');
  }
  if (value && !Array.isArray(value) && typeof value === 'object' && Object.hasOwn(value, 'use')) value = value.use;
  if (!Array.isArray(value)) value = [value];
  if (!value.length) die('dispatch profile array must not be empty');
  const seen = new Set();
  return value.map((raw) => {
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') die('each dispatch profile must be an object');
    if (typeof raw.harness !== 'string' || !raw.harness) die('each dispatch profile needs a non-empty harness');
    for (const field of ['provider', 'model', 'effort', 'quotaWindow']) {
      if (Object.hasOwn(raw, field) && (typeof raw[field] !== 'string' || !raw[field])) {
        die(`dispatch profile ${field} must be a non-empty string when present`);
      }
    }
    if (!VERIFIED_HARNESSES.has(raw.harness)) {
      die(`subscription dispatch requires a verified harness, not ${raw.harness}`);
    }
    if (raw.harness === 'kimi') die('Kimi is unsupported for subscription dispatch');
    const nativeProvider = NATIVE_PROVIDER.get(raw.harness);
    if (nativeProvider && raw.provider && raw.provider !== nativeProvider) {
      die(`native harness ${raw.harness} requires provider ${nativeProvider}`);
    }
    const provider = profileProvider(raw);
    if (!provider || !PROVIDERS.has(provider)) {
      die(`provider identity is unresolved or unsupported for harness ${raw.harness}`);
    }
    const profile = cleanProfile(raw, provider);
    const quotaWindow = raw.quotaWindow || null;
    const identity = JSON.stringify({ ...profile, provider, quotaWindow });
    if (seen.has(identity)) die('dispatch profile array contains a duplicate concrete profile');
    seen.add(identity);
    return { profile, provider, quotaWindow, identity, key: digest(identity) };
  });
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseNow(raw) {
  if (raw === undefined) return Math.floor(Date.now() / 1000);
  if (!/^\d+$/.test(raw)) die('--now must be a non-negative epoch second');
  return Number(raw);
}

function readQuota(options) {
  let text;
  if (options.quotaJson) {
    try {
      text = fs.readFileSync(options.quotaJson, 'utf8');
    } catch {
      return { available: false, reason: 'quota fixture unreadable' };
    }
  } else {
    const executable = process.env.FM_DISPATCH_QUOTA_AXI || 'quota-axi';
    const result = spawnSync(executable, ['--json'], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) return { available: false, reason: 'quota-axi unavailable' };
    text = result.stdout;
  }
  try {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.providers)) throw new Error('shape');
    return { available: true, data };
  } catch {
    return { available: false, reason: 'quota telemetry malformed' };
  }
}

// Provider-level readiness: everything that is true of a provider regardless of
// which of its pools a candidate declares.
function providerReadiness(providerName, quota, now, settings) {
  if (!quota.available) return { ok: false, reason: quota.reason };
  const generated = Date.parse(quota.data.generatedAt || '');
  const age = Number.isFinite(generated) ? now - Math.floor(generated / 1000) : Number.POSITIVE_INFINITY;
  if (age < -60 || age > settings.telemetryMaxAgeSeconds) {
    return { ok: false, reason: 'quota telemetry stale or undated' };
  }
  const provider = quota.data.providers.find((item) => item?.provider === providerName);
  if (!provider) return { ok: false, reason: 'provider telemetry unavailable' };
  if (provider.state?.status !== 'fresh' || provider.state?.stale === true) {
    const evidence = `${provider.state?.status || ''} ${provider.state?.error || ''}`;
    const rateLimited = RATE_LIMIT_RE.test(evidence);
    return {
      ok: false,
      reason: rateLimited ? 'provider quota/rate-limit evidence' : 'provider telemetry not fresh',
      cooldownEvidence: rateLimited,
    };
  }
  return { ok: true, provider };
}

function usablePercent(value) {
  return typeof value === 'number' && value >= 0 && value <= 100;
}

function reserveVerdict(headroom, basis, settings) {
  if (headroom <= settings.reservePercent) {
    return { eligible: false, reason: `${basis} headroom ${headroom}% is at or below ${settings.reservePercent}% reserve`, headroom };
  }
  return { eligible: true, reason: `fresh ${basis} headroom=${headroom}% reserve=${settings.reservePercent}%`, headroom };
}

// The conservative default: a provider is worth only its tightest reported live
// figure, so no single healthy window can hide an exhausted one.
function priceProviderWide(provider, settings) {
  const values = [];
  for (const window of provider.windows || []) {
    if (usablePercent(window?.percentRemaining)) values.push(window.percentRemaining);
  }
  if (!values.length) return { eligible: false, reason: 'provider telemetry has no usable live window percentage' };
  for (const availability of provider.quotaSemantics?.effectiveAvailability || []) {
    if (availability?.status === 'known' && usablePercent(availability.effectivePercentRemaining)) {
      values.push(availability.effectivePercentRemaining);
    }
  }
  return reserveVerdict(Math.min(...values), 'quota', settings);
}

// The declared-pool path: price this candidate on exactly the window it says it
// draws on, and refuse rather than substitute when that window is not there.
function priceDeclaredWindow(provider, windowId, settings) {
  const matched = (provider.windows || []).filter((window) => window?.id === windowId);
  if (!matched.length) {
    return { eligible: false, reason: `declared quota window ${windowId} is absent from provider telemetry` };
  }
  const values = matched.map((window) => window.percentRemaining).filter(usablePercent);
  if (!values.length) {
    return { eligible: false, reason: `declared quota window ${windowId} has no usable live percentage` };
  }
  return reserveVerdict(Math.min(...values), `window ${windowId}`, settings);
}

function quotaCandidate(readiness, windowId, settings) {
  if (!readiness.ok) return { eligible: false, reason: readiness.reason };
  return windowId
    ? priceDeclaredWindow(readiness.provider, windowId, settings)
    : priceProviderWide(readiness.provider, settings);
}

function cooldownActive(state, provider, now) {
  const item = state.cooldowns[provider];
  return item && Number.isInteger(item.until) && item.until > now ? item : null;
}

function setCooldown(state, provider, reason, now, seconds) {
  state.cooldowns[provider] = { until: now + seconds, reason, recordedAt: now };
}

function tieKey(home, value) {
  return digest(`${home}\0${value}`);
}

function selectLeastRecent(items, lastUsed, home, identity) {
  return [...items].sort((a, b) => {
    const aLast = lastUsed[identity(a)] || 0;
    const bLast = lastUsed[identity(b)] || 0;
    if (aLast !== bLast) return aLast - bLast;
    return tieKey(home, identity(a)).localeCompare(tieKey(home, identity(b)));
  })[0];
}

function knownSpendPriority(provider, windowId) {
  const scopes = provider?.quotaSemantics?.effectiveAvailability || [];
  const matches = [];
  for (const scope of scopes) {
    const spend = scope?.selection?.status === 'known' ? scope.selection.spendPriority : null;
    if (typeof spend !== 'number' || !Number.isFinite(spend)) continue;
    const name = scope.scope || '';
    const bounded = [...(scope.boundedBy || []), ...(scope.limitingWindowIds || [])];
    if (windowId) {
      if (name === windowId || bounded.includes(windowId)) {
        matches.push({ spend, exact: name === windowId });
      }
    } else if (name === 'all_models' || name === 'all_products') {
      matches.push({ spend, exact: true });
    } else {
      matches.push({ spend, exact: false });
    }
  }
  if (!matches.length) return null;
  const exact = matches.filter((item) => item.exact);
  const pool = exact.length ? exact : matches;
  return Math.min(...pool.map((item) => item.spend));
}

function inputText(options) {
  if (options.positional.length > 1) die('expected at most one JSON argument');
  if (options.positional.length === 1) return options.positional[0];
  return fs.readFileSync(0, 'utf8');
}

function select(options, home, paths, settings, now, state) {
  const candidates = parseProfiles(inputText(options));
  const quota = readQuota(options);
  const byProvider = new Map();
  for (const candidate of candidates) {
    if (!byProvider.has(candidate.provider)) byProvider.set(candidate.provider, []);
    byProvider.get(candidate.provider).push(candidate);
  }

  const eligibleProviders = [];
  for (const [provider, providerCandidates] of byProvider) {
    const cooldown = cooldownActive(state, provider, now);
    if (cooldown) {
      log(`candidate provider=${provider} unavailable: cooldown until epoch ${cooldown.until}`);
      continue;
    }
    const readiness = providerReadiness(provider, quota, now, settings);
    if (readiness.cooldownEvidence) setCooldown(state, provider, 'quota-telemetry-evidence', now, settings.cooldownSeconds);
    if (!readiness.ok) {
      // A provider-level refusal is the same for every pool, so it is stated once.
      log(`candidate provider=${provider} unavailable: ${readiness.reason}`);
      continue;
    }
    // Pricing is per declared pool, so one provider can report several verdicts.
    // Each distinct pool is priced and logged once, however many candidates
    // share it.
    const priced = new Map();
    const eligible = [];
    for (const candidate of providerCandidates) {
      const pool = candidate.quotaWindow || '';
      if (!priced.has(pool)) {
        const verdict = quotaCandidate(readiness, candidate.quotaWindow, settings);
        priced.set(pool, verdict);
        const label = pool ? `provider=${provider} window=${pool}` : `provider=${provider}`;
        log(`candidate ${label} ${verdict.eligible ? 'eligible' : 'unavailable'}: ${verdict.reason}`);
      }
      if (priced.get(pool).eligible) eligible.push(candidate);
    }
    if (eligible.length) eligibleProviders.push({ provider, candidates: eligible, telemetry: readiness.provider });
  }
  if (!eligibleProviders.length) {
    saveState(paths.stateFile, state);
    die('no subscription candidate has current dispatch capacity evidence', 3);
  }

  const ranked = [];
  for (const group of eligibleProviders) {
    for (const candidate of group.candidates) {
      ranked.push({
        group,
        candidate,
        spend: knownSpendPriority(group.telemetry, candidate.quotaWindow),
      });
    }
  }
  const known = ranked.filter((item) => item.spend !== null);
  let pool = ranked;
  let basis = 'least-recent eligible subscription';
  if (known.length) {
    const best = Math.max(...known.map((item) => item.spend));
    pool = known.filter((item) => item.spend === best);
    basis = `spendPriority=${best}`;
  }
  const providerNames = [...new Set(pool.map((item) => item.group.provider))];
  const providerGroup = selectLeastRecent(
    eligibleProviders.filter((item) => providerNames.includes(item.provider)),
    state.lastSelected,
    home,
    (item) => item.provider,
  );
  const providerPool = pool
    .filter((item) => item.group.provider === providerGroup.provider)
    .map((item) => item.candidate);
  const candidate = selectLeastRecent(
    providerPool.length ? providerPool : providerGroup.candidates,
    state.profileLastSelected,
    home,
    (item) => item.key,
  );
  state.sequence += 1;
  state.lastSelected[providerGroup.provider] = state.sequence;
  state.profileLastSelected[candidate.key] = state.sequence;
  saveState(paths.stateFile, state);
  log(`selection provider=${providerGroup.provider} basis=${basis} sequence=${state.sequence}`);
  process.stdout.write(`${JSON.stringify(candidate.profile)}\n`);
}

function taskMetaProvider(paths, task) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(task)) die('task id has an unsafe shape');
  const metaFile = path.join(paths.stateDir, `${task}.meta`);
  const statusFile = path.join(paths.stateDir, `${task}.status`);
  let meta;
  let status;
  try {
    meta = fs.readFileSync(metaFile, 'utf8');
    status = fs.readFileSync(statusFile, 'utf8');
  } catch {
    die('record-failure requires readable task meta and status evidence');
  }
  const entries = new Map(meta.split('\n').map((line) => {
    const index = line.indexOf('=');
    return index < 0 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)];
  }));
  const harness = entries.get('harness');
  const provider = entries.get('provider') || NATIVE_PROVIDER.get(harness);
  if (!provider || !PROVIDERS.has(provider)) die('record-failure requires a recorded claude, codex, grok, cursor, or agy routing provider');
  const nativeProvider = NATIVE_PROVIDER.get(harness);
  if (nativeProvider && provider !== nativeProvider) die(`task ${task} has mismatched native harness and provider metadata`);
  if (harness === 'kimi') die('record-failure does not support Kimi tasks');
  if (!RATE_LIMIT_RE.test(status)) die('task status contains no rate-limit or quota-exhaustion evidence');
  return provider;
}

function recordFailure(options, paths, settings, now, state) {
  if (!options.provider || !PROVIDERS.has(options.provider)) die('record-failure needs --provider claude, codex, grok, cursor, or agy');
  if (!options.task) die('record-failure needs --task');
  const actual = taskMetaProvider(paths, options.task);
  if (actual !== options.provider) die(`task ${options.task} is recorded on provider ${actual}, not ${options.provider}`);
  setCooldown(state, options.provider, 'verified-task-rate-limit-or-quota-evidence', now, settings.cooldownSeconds);
  saveState(paths.stateFile, state);
  log(`provider=${options.provider} cooldown recorded until epoch ${state.cooldowns[options.provider].until}`);
}

function clearProvider(options, paths, state) {
  if (!options.provider || !PROVIDERS.has(options.provider)) die('clear needs --provider claude, codex, grok, cursor, or agy');
  delete state.cooldowns[options.provider];
  saveState(paths.stateFile, state);
  log(`provider=${options.provider} cooldown cleared`);
}

// classify-evidence: the pure depletion detector behind record-failure and
// bin/fm-model-fallback.sh. Reads evidence text from --file or stdin and
// prints exactly one `classification=` line plus the matched signature when
// depleted. It touches no home, lock, or state, so a caller may run it before
// any of this script's routing machinery exists.
function classifyEvidence(options) {
  let text;
  try {
    text = options.file ? fs.readFileSync(options.file, 'utf8') : fs.readFileSync(0, 'utf8');
  } catch {
    die('classify-evidence requires a readable --file or stdin text');
  }
  const match = RATE_LIMIT_RE.exec(text);
  if (!match) {
    process.stdout.write('classification=none\n');
    return;
  }
  process.stdout.write(`classification=depleted\nsignature=${JSON.stringify(match[0])}\n`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'classify-evidence') {
    classifyEvidence(options);
  } else if (options.command === 'validate-model-fallback') {
    validateModelFallback(options);
  } else if (!['select', 'record-failure', 'clear'].includes(options.command)) {
    die(`unknown command ${options.command}`);
  } else {
    const home = explicitHome();
    const paths = operationalPaths(home);
    const settings = settingsFromConfig(paths.configDir);
    const now = parseNow(options.now);
    const unlock = acquireLock(paths.lockDir);
    try {
      const state = loadState(paths.stateFile);
      if (options.command === 'select') select(options, home, paths, settings, now, state);
      else if (options.command === 'record-failure') recordFailure(options, paths, settings, now, state);
      else clearProvider(options, paths, state);
    } finally {
      unlock();
    }
  }
} catch (error) {
  if (error instanceof CliError) {
    process.stderr.write(`fm-dispatch-select: ${error.message}\n`);
    process.exitCode = error.code;
  } else {
    process.stderr.write('fm-dispatch-select: unexpected internal failure\n');
    process.exitCode = 1;
  }
}
