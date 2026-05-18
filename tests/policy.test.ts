import test from "node:test";
import assert from "node:assert/strict";

import {
  consecutiveFailures,
  normalizePolicy,
  plateauRuns,
  shouldTriggerLifeline,
  type LifelineRun,
} from "../extensions/pi-lifeline/policy.ts";

const baseline: LifelineRun = { run: 1, metric: 100, status: "keep" };

test("normalizePolicy preserves defaults and clamps invalid values", () => {
  const cfg = normalizePolicy({
    auto: false,
    minRunsBetweenCalls: -1,
    triggerAfterConsecutiveFailures: 0,
    triggerAfterPlateauRuns: Number.NaN,
    maxCallsPerSession: 2.9,
  });

  assert.equal(cfg.auto, false);
  assert.equal(cfg.minRunsBetweenCalls, 5);
  assert.equal(cfg.triggerAfterConsecutiveFailures, 3);
  assert.equal(cfg.triggerAfterPlateauRuns, 6);
  assert.equal(cfg.maxCallsPerSession, 2);
});

test("consecutiveFailures counts only trailing discard/crash/checks_failed runs", () => {
  assert.equal(consecutiveFailures([]), 0);
  assert.equal(consecutiveFailures([baseline]), 0);
  assert.equal(consecutiveFailures([
    baseline,
    { run: 2, metric: 101, status: "discard" },
    { run: 3, metric: 0, status: "crash" },
    { run: 4, metric: 102, status: "checks_failed" },
  ]), 3);
  assert.equal(consecutiveFailures([
    baseline,
    { run: 2, metric: 101, status: "discard" },
    { run: 3, metric: 99, status: "keep" },
  ]), 0);
});

test("triggers after default 3 consecutive failures", () => {
  const runs: LifelineRun[] = [
    baseline,
    { run: 2, metric: 101, status: "discard" },
    { run: 3, metric: 102, status: "discard" },
  ];
  assert.equal(shouldTriggerLifeline(runs).shouldTrigger, false);

  const decision = shouldTriggerLifeline([
    ...runs,
    { run: 4, metric: 103, status: "discard" },
  ]);
  assert.equal(decision.shouldTrigger, true);
  assert.match(decision.reason ?? "", /3 consecutive/);
});

test("recent keep resets failure trigger", () => {
  const decision = shouldTriggerLifeline([
    baseline,
    { run: 2, metric: 101, status: "discard" },
    { run: 3, metric: 102, status: "discard" },
    { run: 4, metric: 99, status: "keep" },
  ]);
  assert.equal(decision.consecutiveFailures, 0);
  assert.equal(decision.shouldTrigger, false);
});

test("plateauRuns counts runs since last kept improvement", () => {
  assert.equal(plateauRuns([baseline], "lower"), 0);
  assert.equal(plateauRuns([
    baseline,
    { run: 2, metric: 101, status: "discard" },
    { run: 3, metric: 99, status: "keep" },
    { run: 4, metric: 100, status: "discard" },
    { run: 5, metric: 100, status: "discard" },
  ], "lower"), 2);
});

test("triggers on plateau after configured threshold", () => {
  const decision = shouldTriggerLifeline([
    baseline,
    { run: 2, metric: 99, status: "keep" },
    { run: 3, metric: 100, status: "discard" },
    { run: 4, metric: 100, status: "discard" },
  ], { triggerAfterPlateauRuns: 2, triggerAfterConsecutiveFailures: 99 });

  assert.equal(decision.shouldTrigger, true);
  assert.match(decision.reason ?? "", /2 runs since/);
});

test("respects minRunsBetweenCalls", () => {
  const runs: LifelineRun[] = [
    baseline,
    { run: 2, metric: 101, status: "discard" },
    { run: 3, metric: 102, status: "discard" },
    { run: 4, metric: 103, status: "discard" },
  ];

  const decision = shouldTriggerLifeline(runs, {}, { callsThisSession: 1, lastCallRun: 2 });
  assert.equal(decision.shouldTrigger, false);
});

test("respects maxCallsPerSession and auto=false", () => {
  const runs: LifelineRun[] = [
    baseline,
    { run: 2, metric: 101, status: "discard" },
    { run: 3, metric: 102, status: "discard" },
    { run: 4, metric: 103, status: "discard" },
  ];

  assert.equal(shouldTriggerLifeline(runs, { maxCallsPerSession: 1 }, { callsThisSession: 1, lastCallRun: null }).shouldTrigger, false);
  assert.equal(shouldTriggerLifeline(runs, { auto: false }).shouldTrigger, false);
});

test("higher-is-better plateau uses maximum kept metric", () => {
  const runs: LifelineRun[] = [
    { run: 1, metric: 10, status: "keep" },
    { run: 2, metric: 11, status: "keep" },
    { run: 3, metric: 10, status: "discard" },
  ];
  assert.equal(plateauRuns(runs, "higher"), 1);
});
