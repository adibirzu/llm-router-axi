import { createHash } from "node:crypto";

/**
 * A faithful TypeScript port of `bin/fm-dispatch-select.mjs`'s subscription
 * readiness and deterministic distribution, extended with the router's
 * pool-aware provider identity. The rejection and diagnostic strings are
 * frozen (P0 §4.3) so `route`/`explain` stay at byte-level parity with the
 * firstmate selector; do not reword them.
 */

export interface EngineProfile {
  harness: string;
  provider: string;
  model?: string;
  effort?: string;
  /**
   * Pricing declaration. `quotaWindow` names one window id (selector parity);
   * `poolWindows` names several (a router pool such as agy `gemini`); both are
   * stripped from the launch profile.
   */
  quotaWindow?: string;
  poolWindows?: string[];
  /** Human pool name used only when a diagnostic must name a multi-window pool. */
  poolLabel?: string;
}

export interface EngineSettings {
  reservePercent: number;
  telemetryMaxAgeSeconds: number;
  cooldownSeconds: number;
}

interface QuotaWindow {
  id?: string;
  percentRemaining?: number;
}

interface EffectiveAvailability {
  scope?: string;
  status?: string;
  effectivePercentRemaining?: number;
  boundedBy?: string[];
  limitingWindowIds?: string[];
  selection?: { status?: string; spendPriority?: number };
}

interface UsagePool {
  id: string;
  label?: string;
  provider?: string;
  windowIds: string[];
  percentRemaining?: number;
  models?: string[];
  modelCount?: number;
}

export interface QuotaProvider {
  provider?: string;
  label?: string;
  windows?: QuotaWindow[];
  pools?: UsagePool[];
  state?: { status?: string; stale?: boolean; error?: string };
  quotaSemantics?: { effectiveAvailability?: EffectiveAvailability[] };
}

export interface QuotaTelemetry {
  generatedAt?: string;
  providers: QuotaProvider[];
  machine?: MachineTelemetry;
  [key: string]: unknown;
}

export interface MachineTelemetry {
  agents?: number | null;
  agentCeiling?: number;
  loadPerCore?: number | null;
  memoryFreePct?: number | null;
  suiteSlotFree?: boolean | null;
}

export type QuotaRead =
  | { available: true; data: QuotaTelemetry }
  | { available: false; reason: string };

export interface Cooldown {
  until: number;
  reason: string;
  recordedAt: number;
}

export interface EngineState {
  version: 1;
  sequence: number;
  lastSelected: Record<string, number>;
  profileLastSelected: Record<string, number>;
  cooldowns: Record<string, Cooldown>;
}

export interface CandidateEvaluation {
  profile: EngineProfile;
  provider: string;
  /** The window id used for pricing, or null for provider-wide pricing. */
  windowId: string | null;
  eligible: boolean;
  /** Full diagnostic line, exactly as the selector logs it. */
  reason: string;
  /** Bare frozen reason string (no `candidate provider=…` prefix). */
  detail: string;
  spendPriority: number | null;
}

export interface SelectionReport {
  ok: boolean;
  exitCode: number;
  evaluations: CandidateEvaluation[];
  selected?: EngineProfile;
  basis?: string;
  sequence?: number;
  /** Overall refusal when no candidate is eligible. */
  reason?: string;
  state: EngineState;
}

export function emptyState(): EngineState {
  return {
    version: 1,
    sequence: 0,
    lastSelected: {},
    profileLastSelected: {},
    cooldowns: {},
  };
}

const RATE_LIMIT_RE = new RegExp(
  [
    "(?:http|status|code|error|response)[^\\n]{0,16}\\b429\\b",
    "(?:spending|budget|credit|balance|quota)[^\\n]{0,80}\\b403\\b",
    "\\b403\\b[^\\n]{0,80}(?:spending|budget|credit|balance|quota)",
    "rate[ _-]?limit",
    "too many requests",
    "resource[ _-]?exhausted",
    "insufficient[ _-]?(?:quota|credits?|balance|funds)",
    "out of (?:quota|credits?|tokens?|balance)",
    "credit balance is too low",
    "spending[ _-]?limit",
    "(?:quota|usage|spending|allowance|subscription|credits?|balance|monthly|weekly|daily|session)[^\\n]{0,80}(?:exhaust|deplet|used up|limit|reach|exceed|zero)",
    "(?:exhaust|deplet|reach|exceed)[^\\n]{0,80}(?:quota|usage|spending|allowance|credits?|balance)",
  ].join("|"),
  "i",
);

export function classifyEvidence(text: string): string | null {
  const match = RATE_LIMIT_RE.exec(text);
  return match ? match[0] : null;
}

/** The launch shape: pricing declarations never reach stdout. */
function cleanProfile(profile: EngineProfile): EngineProfile {
  return {
    harness: profile.harness,
    provider: profile.provider,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.effort ? { effort: profile.effort } : {}),
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable identity for a concrete route, including its pool declaration. */
export function profileIdentity(profile: EngineProfile): string {
  const clean = cleanProfile(profile);
  return JSON.stringify({ ...clean, quotaWindow: profile.quotaWindow ?? null });
}

function profileKey(profile: EngineProfile): string {
  return digest(profileIdentity(profile));
}

function usablePercent(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 100;
}

function reserveVerdict(
  headroom: number,
  basis: string,
  settings: EngineSettings,
): { eligible: boolean; reason: string } {
  if (headroom <= settings.reservePercent) {
    return {
      eligible: false,
      reason: `${basis} headroom ${headroom}% is at or below ${settings.reservePercent}% reserve`,
    };
  }
  return {
    eligible: true,
    reason: `fresh ${basis} headroom=${headroom}% reserve=${settings.reservePercent}%`,
  };
}

interface ProviderReadiness {
  ok: boolean;
  reason?: string;
  provider?: QuotaProvider;
  cooldownEvidence?: boolean;
}

function providerReadiness(
  providerName: string,
  quota: QuotaRead,
  now: number,
  settings: EngineSettings,
): ProviderReadiness {
  if (!quota.available) return { ok: false, reason: quota.reason };
  const generated = Date.parse(quota.data.generatedAt ?? "");
  const age = Number.isFinite(generated)
    ? now - Math.floor(generated / 1000)
    : Number.POSITIVE_INFINITY;
  if (age < -60 || age > settings.telemetryMaxAgeSeconds) {
    return { ok: false, reason: "quota telemetry stale or undated" };
  }
  const provider = quota.data.providers.find((item) => item?.provider === providerName);
  if (!provider) return { ok: false, reason: "provider telemetry unavailable" };
  if (provider.state?.status !== "fresh" || provider.state?.stale === true) {
    const evidence = `${provider.state?.status ?? ""} ${provider.state?.error ?? ""}`;
    const rateLimited = RATE_LIMIT_RE.test(evidence);
    return {
      ok: false,
      reason: rateLimited ? "provider quota/rate-limit evidence" : "provider telemetry not fresh",
      cooldownEvidence: rateLimited,
    };
  }
  return { ok: true, provider };
}

/** The conservative default: the tightest reported live provider-wide figure. */
function priceProviderWide(
  provider: QuotaProvider,
  settings: EngineSettings,
): { eligible: boolean; reason: string } {
  const values: number[] = [];
  for (const window of provider.windows ?? []) {
    if (usablePercent(window?.percentRemaining)) values.push(window.percentRemaining);
  }
  if (!values.length) {
    return { eligible: false, reason: "provider telemetry has no usable live window percentage" };
  }
  for (const availability of provider.quotaSemantics?.effectiveAvailability ?? []) {
    if (availability?.status === "known" && usablePercent(availability.effectivePercentRemaining)) {
      values.push(availability.effectivePercentRemaining);
    }
  }
  return reserveVerdict(Math.min(...values), "quota", settings);
}

interface PoolPricing {
  eligible: boolean;
  reason: string;
  windowId: string | null;
}

/** Price exactly the window ids a candidate declares; never substitute. */
function priceDeclaredPool(
  provider: QuotaProvider,
  windowIds: string[],
  label: string | undefined,
  settings: EngineSettings,
): PoolPricing {
  const primary = label ?? windowIds[0] ?? "";
  const windows = windowIds
    .map((id) => (provider.windows ?? []).find((window) => window?.id === id))
    .filter((window): window is QuotaWindow => window !== undefined);
  if (!windows.length) {
    return {
      eligible: false,
      reason: `declared quota window ${primary} is absent from provider telemetry`,
      windowId: windowIds[0] ?? null,
    };
  }
  const usable = windows.filter((window) => usablePercent(window.percentRemaining));
  if (!usable.length) {
    return {
      eligible: false,
      reason: `declared quota window ${primary} has no usable live percentage`,
      windowId: windowIds[0] ?? null,
    };
  }
  let tightest = usable[0] as QuotaWindow;
  for (const window of usable) {
    if ((window.percentRemaining as number) < (tightest.percentRemaining as number)) {
      tightest = window;
    }
  }
  const basis = `window ${tightest.id}`;
  const verdict = reserveVerdict(tightest.percentRemaining as number, basis, settings);
  return { ...verdict, windowId: tightest.id ?? windowIds[0] ?? null };
}

function priceCandidate(
  provider: QuotaProvider,
  profile: EngineProfile,
  settings: EngineSettings,
): PoolPricing {
  const windows = profile.poolWindows;
  if (windows && windows.length > 0) {
    if (windows.length === 1) {
      return priceDeclaredPool(provider, windows, undefined, settings);
    }
    return priceDeclaredPool(provider, windows, profile.poolLabel, settings);
  }
  if (profile.quotaWindow) {
    return priceDeclaredPool(provider, [profile.quotaWindow], undefined, settings);
  }
  const wide = priceProviderWide(provider, settings);
  return { ...wide, windowId: null };
}

function knownSpendPriority(
  provider: QuotaProvider | undefined,
  windowIds: string[] | null,
): number | null {
  const scopes = provider?.quotaSemantics?.effectiveAvailability ?? [];
  const matches: Array<{ spend: number; exact: boolean }> = [];
  for (const scope of scopes) {
    const spend = scope?.selection?.status === "known" ? scope.selection.spendPriority : null;
    if (typeof spend !== "number" || !Number.isFinite(spend)) continue;
    const name = scope.scope ?? "";
    const bounded = [...(scope.boundedBy ?? []), ...(scope.limitingWindowIds ?? [])];
    if (windowIds && windowIds.length > 0) {
      const exact = windowIds.includes(name);
      const joined = bounded.some((id) => windowIds.includes(id));
      if (exact || joined) matches.push({ spend, exact });
    } else if (name === "all_models" || name === "all_products") {
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

function cooldownActive(state: EngineState, provider: string, now: number): Cooldown | null {
  const item = state.cooldowns[provider];
  return item && Number.isInteger(item.until) && item.until > now ? item : null;
}

export function setCooldown(
  state: EngineState,
  provider: string,
  reason: string,
  now: number,
  seconds: number,
): void {
  state.cooldowns[provider] = { until: now + seconds, reason, recordedAt: now };
}

function tieKey(home: string, value: string): string {
  return digest(`${home}\0${value}`);
}

function selectLeastRecent<T>(
  items: T[],
  lastUsed: Record<string, number>,
  home: string,
  identity: (item: T) => string,
): T {
  return [...items].sort((a, b) => {
    const aLast = lastUsed[identity(a)] ?? 0;
    const bLast = lastUsed[identity(b)] ?? 0;
    if (aLast !== bLast) return aLast - bLast;
    return tieKey(home, identity(a)).localeCompare(tieKey(home, identity(b)));
  })[0] as T;
}

/**
 * Evaluate every candidate against the telemetry and choose one, mutating a
 * copy of `state` for rotation. `profiles` must be non-empty and unique.
 */
export function selectProfiles(params: {
  profiles: EngineProfile[];
  quota: QuotaRead;
  settings: EngineSettings;
  now: number;
  state: EngineState;
  home: string;
}): SelectionReport {
  const { profiles, quota, settings, now, home } = params;
  const state = structuredCloneState(params.state);
  const evaluations: CandidateEvaluation[] = [];

  const byProvider = new Map<string, EngineProfile[]>();
  for (const profile of profiles) {
    const list = byProvider.get(profile.provider) ?? [];
    list.push(profile);
    byProvider.set(profile.provider, list);
  }

  const eligibleProviders: Array<{
    provider: string;
    profiles: EngineProfile[];
    telemetry: QuotaProvider;
  }> = [];

  for (const [provider, providerProfiles] of byProvider) {
    const cooldown = cooldownActive(state, provider, now);
    if (cooldown) {
      for (const profile of providerProfiles) {
        evaluations.push({
          profile,
          provider,
          windowId: profile.quotaWindow ?? null,
          eligible: false,
          reason: `candidate provider=${provider} unavailable: cooldown until epoch ${cooldown.until}`,
          detail: `candidate provider=${provider} unavailable: cooldown until epoch ${cooldown.until}`,
          spendPriority: null,
        });
      }
      continue;
    }
    const readiness = providerReadiness(provider, quota, now, settings);
    if (readiness.cooldownEvidence) {
      setCooldown(state, provider, "quota-telemetry-evidence", now, settings.cooldownSeconds);
    }
    if (!readiness.ok || !readiness.provider) {
      const reason = `candidate provider=${provider} unavailable: ${readiness.reason}`;
      for (const profile of providerProfiles) {
        evaluations.push({
          profile,
          provider,
          windowId: profile.quotaWindow ?? null,
          eligible: false,
          reason,
          detail: readiness.reason ?? reason,
          spendPriority: null,
        });
      }
      continue;
    }

    const priced = new Map<string, PoolPricing>();
    const eligible: EngineProfile[] = [];
    for (const profile of providerProfiles) {
      const poolKey = poolIdentity(profile);
      if (!priced.has(poolKey)) {
        priced.set(poolKey, priceCandidate(readiness.provider, profile, settings));
      }
      const verdict = priced.get(poolKey) as PoolPricing;
      const label = describePool(provider, profile);
      evaluations.push({
        profile,
        provider,
        windowId: verdict.windowId,
        eligible: verdict.eligible,
        reason: `candidate ${label} ${verdict.eligible ? "eligible" : "unavailable"}: ${verdict.reason}`,
        detail: verdict.reason,
        spendPriority: knownSpendPriority(readiness.provider, spendWindowIds(profile)),
      });
      if (verdict.eligible) eligible.push(profile);
    }
    if (eligible.length) {
      eligibleProviders.push({ provider, profiles: eligible, telemetry: readiness.provider });
    }
  }

  if (!eligibleProviders.length) {
    return {
      ok: false,
      exitCode: 3,
      reason: "no subscription candidate has current dispatch capacity evidence",
      evaluations,
      state,
    };
  }

  const ranked: Array<{
    group: (typeof eligibleProviders)[number];
    candidate: EngineProfile;
    spend: number | null;
  }> = [];
  for (const group of eligibleProviders) {
    for (const candidate of group.profiles) {
      ranked.push({
        group,
        candidate,
        spend: knownSpendPriority(group.telemetry, spendWindowIds(candidate)),
      });
    }
  }
  const known = ranked.filter((item) => item.spend !== null);
  let pool = ranked;
  let basis = "least-recent eligible subscription";
  if (known.length) {
    const best = Math.max(...known.map((item) => item.spend as number));
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
    providerPool.length ? providerPool : providerGroup.profiles,
    state.profileLastSelected,
    home,
    (item) => profileKey(item),
  );
  state.sequence += 1;
  state.lastSelected[providerGroup.provider] = state.sequence;
  state.profileLastSelected[profileKey(candidate)] = state.sequence;

  return {
    ok: true,
    exitCode: 0,
    evaluations,
    selected: candidate,
    basis,
    sequence: state.sequence,
    state,
  };
}

function structuredCloneState(state: EngineState): EngineState {
  return {
    version: 1,
    sequence: state.sequence,
    lastSelected: { ...state.lastSelected },
    profileLastSelected: { ...state.profileLastSelected },
    cooldowns: Object.fromEntries(
      Object.entries(state.cooldowns).map(([key, value]) => [key, { ...value }]),
    ),
  };
}

function spendWindowIds(profile: EngineProfile): string[] | null {
  if (profile.poolWindows && profile.poolWindows.length > 0) return profile.poolWindows;
  if (profile.quotaWindow) return [profile.quotaWindow];
  return null;
}

function poolIdentity(profile: EngineProfile): string {
  return `${profile.quotaWindow ?? ""}\0${(profile.poolWindows ?? []).join(",")}`;
}

function describePool(provider: string, profile: EngineProfile): string {
  if (profile.poolWindows && profile.poolWindows.length > 1 && profile.poolLabel) {
    return `provider=${provider} pool=${profile.poolLabel}`;
  }
  const window = profile.quotaWindow ?? profile.poolWindows?.[0];
  return window ? `provider=${provider} window=${window}` : `provider=${provider}`;
}

