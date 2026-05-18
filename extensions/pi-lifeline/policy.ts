export type RunStatus = "keep" | "discard" | "crash" | "checks_failed";

export interface LifelineRun {
  run: number;
  metric: number;
  status: RunStatus;
  timestamp?: number;
  description?: string;
  segment?: number;
}

export interface LifelinePolicyConfig {
  auto: boolean;
  minRunsBetweenCalls: number;
  triggerAfterConsecutiveFailures: number;
  triggerAfterPlateauRuns: number;
  maxCallsPerSession: number;
}

export interface LifelinePolicyState {
  callsThisSession: number;
  lastCallRun: number | null;
}

export interface LifelineDecision {
  shouldTrigger: boolean;
  reason: string | null;
  consecutiveFailures: number;
  plateauRuns: number;
  currentRun: number;
}

export const DEFAULT_POLICY: LifelinePolicyConfig = {
  auto: true,
  minRunsBetweenCalls: 5,
  triggerAfterConsecutiveFailures: 3,
  triggerAfterPlateauRuns: 6,
  maxCallsPerSession: 10,
};

export function normalizePolicy(input: Partial<LifelinePolicyConfig> = {}): LifelinePolicyConfig {
  return {
    auto: input.auto ?? DEFAULT_POLICY.auto,
    minRunsBetweenCalls: nonNegativeInteger(input.minRunsBetweenCalls, DEFAULT_POLICY.minRunsBetweenCalls),
    triggerAfterConsecutiveFailures: positiveInteger(input.triggerAfterConsecutiveFailures, DEFAULT_POLICY.triggerAfterConsecutiveFailures),
    triggerAfterPlateauRuns: positiveInteger(input.triggerAfterPlateauRuns, DEFAULT_POLICY.triggerAfterPlateauRuns),
    maxCallsPerSession: nonNegativeInteger(input.maxCallsPerSession, DEFAULT_POLICY.maxCallsPerSession),
  };
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function isFailureStatus(status: RunStatus): boolean {
  return status === "discard" || status === "crash" || status === "checks_failed";
}

export function consecutiveFailures(runs: LifelineRun[]): number {
  let count = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (!isFailureStatus(runs[i].status)) break;
    count++;
  }
  return count;
}

export function plateauRuns(runs: LifelineRun[], direction: "lower" | "higher" = "lower"): number {
  if (runs.length === 0) return 0;

  let best: number | null = null;
  let lastBestIndex = -1;

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.status !== "keep" || !Number.isFinite(run.metric) || run.metric <= 0) continue;
    if (best === null || isBetter(run.metric, best, direction)) {
      best = run.metric;
      lastBestIndex = i;
    }
  }

  if (lastBestIndex < 0) return runs.length;
  return runs.length - lastBestIndex - 1;
}

export function isBetter(value: number, current: number, direction: "lower" | "higher"): boolean {
  return direction === "lower" ? value < current : value > current;
}

export function shouldTriggerLifeline(
  runs: LifelineRun[],
  configInput: Partial<LifelinePolicyConfig> = {},
  state: LifelinePolicyState = { callsThisSession: 0, lastCallRun: null },
  direction: "lower" | "higher" = "lower",
): LifelineDecision {
  const config = normalizePolicy(configInput);
  const currentRun = runs.length > 0 ? Math.max(...runs.map((r) => r.run || 0)) : 0;
  const failures = consecutiveFailures(runs);
  const plateau = plateauRuns(runs, direction);

  const base = { consecutiveFailures: failures, plateauRuns: plateau, currentRun };

  if (!config.auto) return { ...base, shouldTrigger: false, reason: null };
  if (runs.length === 0) return { ...base, shouldTrigger: false, reason: null };
  if (config.maxCallsPerSession === 0 || state.callsThisSession >= config.maxCallsPerSession) {
    return { ...base, shouldTrigger: false, reason: null };
  }
  if (state.lastCallRun !== null && currentRun - state.lastCallRun < config.minRunsBetweenCalls) {
    return { ...base, shouldTrigger: false, reason: null };
  }

  if (failures >= config.triggerAfterConsecutiveFailures) {
    return {
      ...base,
      shouldTrigger: true,
      reason: `${failures} consecutive discarded/crashed/checks_failed runs`,
    };
  }

  if (plateau >= config.triggerAfterPlateauRuns) {
    return {
      ...base,
      shouldTrigger: true,
      reason: `${plateau} runs since last kept improvement`,
    };
  }

  return { ...base, shouldTrigger: false, reason: null };
}
