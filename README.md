# pi-lifeline

A Pi extension that lets a smaller/local model **phone a stronger advisor model** when an autonomous optimization loop gets stuck.

Inspired by Tobi Lütke's observation that local models can run `pi-autoresearch` effectively when they occasionally ask a stronger model for ideas.

## What it does

`pi-lifeline` adds:

- **Tool:** `phone_a_friend` — ask a configured stronger model for strategy, critique, debugging help, or next experiment ideas.
- **Command:** `/lifeline` — inspect status, thresholds, and advisor config.
- **Autoresearch trigger detection:** watches `log_experiment` results and detects repeated failures or plateaus.
- **Rate limiting:** avoids calling the expensive model every iteration.

The larger model is a **strategy reset mechanism**, not the inner loop.

```text
small/local model: edit → run_experiment → log_experiment → repeat
                                  │
                                  │ only when stuck/plateaued
                                  ▼
                     phone_a_friend → stronger advisor model
```

## Why not call every iteration?

Calling the larger model every run defeats the point. The default policy only triggers after evidence that the local model is stuck:

```json
{
  "auto": true,
  "action": "nudge",
  "minRunsBetweenCalls": 5,
  "triggerAfterConsecutiveFailures": 3,
  "triggerAfterPlateauRuns": 6,
  "maxCallsPerSession": 10
}
```

Default behavior is **nudge**, not hidden spending: when stuck, the extension sends a steer message telling the agent to call `phone_a_friend`. If you want fully automatic advisor calls, set `"action": "ask"`.

## Install

Install from npm with Pi:

```bash
pi install npm:pi-lifeline
```

Then reload Pi:

```text
/reload
```

Verify it loaded:

```text
/lifeline
```

### Load locally for development

From this repo:

```bash
pi -e ./extensions/pi-lifeline/index.ts
```

As a Pi package, `package.json` exposes:

```json
{
  "pi": {
    "extensions": ["./extensions/pi-lifeline"]
  }
}
```

## Configuration

Create `pi-lifeline.json` in the Pi working directory:

```json
{
  "auto": true,
  "action": "nudge",
  "minRunsBetweenCalls": 5,
  "triggerAfterConsecutiveFailures": 3,
  "triggerAfterPlateauRuns": 6,
  "maxCallsPerSession": 10,
  "advisor": {
    "provider": "openai",
    "model": "gpt-5.5",
    "maxTokens": 4096,
    "temperature": 0.7
  },
  "includeAutoresearchContext": true
}
```

You can also set:

```bash
export PI_LIFELINE_ADVISOR_PROVIDER=openai
export PI_LIFELINE_ADVISOR_MODEL=gpt-5.5
export PI_LIFELINE_MAX_TOKENS=4096
export PI_LIFELINE_TEMPERATURE=0.7
```

For tests/smoke runs without spending tokens:

```bash
export PI_LIFELINE_FAKE_RESPONSE="Try profiling phase timings and attack the largest non-noisy bucket."
```

## Tool: `phone_a_friend`

Inputs:

- `question` — specific question for the advisor.
- `context` — optional logs, metrics, code summary, failed ideas.
- `mode` — one of:
  - `ideas`
  - `critique`
  - `debug`
  - `next_experiment`
- `max_ideas` — default 5.
- `provider` / `model` — optional per-call override.

Example use:

```json
{
  "question": "We have three discarded parser optimization attempts. What should we try next?",
  "mode": "next_experiment",
  "context": "Recent runs: #2 discard inline cache, #3 crash arena reuse, #4 discard branchless scan",
  "max_ideas": 4
}
```

The advisor prompt explicitly asks for strategic, testable advice — not full patches — and warns against benchmark cheating.

## Command: `/lifeline`

```text
/lifeline
```

Shows:

- active config source
- advisor provider/model
- thresholds
- calls this session
- autoresearch run count
- current trigger decision

```text
/lifeline sample-config
```

Prints a starter `pi-lifeline.json`.

## Autoresearch integration

When `pi-autoresearch` is active, `pi-lifeline` reads `autoresearch.jsonl` and watches `log_experiment` results.

It triggers when either:

1. trailing failures reach `triggerAfterConsecutiveFailures`
   - statuses: `discard`, `crash`, `checks_failed`
2. no kept improvement has happened for `triggerAfterPlateauRuns`

It respects:

- `minRunsBetweenCalls`
- `maxCallsPerSession`
- `auto: false`

With `includeAutoresearchContext: true`, the tool includes recent `autoresearch.jsonl` runs in the advisor prompt.

## Validation plan

### 1. Static validation

```bash
npm run check
```

This verifies the extension and policy modules parse under Node's TypeScript stripping.

### 2. Policy unit tests

```bash
npm test
```

Tests cover:

- default config normalization
- consecutive failure detection
- keep resetting failure streak
- plateau detection
- `higher` and `lower` metric directions
- `minRunsBetweenCalls`
- `maxCallsPerSession`
- `auto: false`

### 3. Fake advisor smoke test

```bash
export PI_LIFELINE_FAKE_RESPONSE="Try measuring phase timings before further code changes."
pi -e ./extensions/pi-lifeline/index.ts
```

Then ask the agent to call `phone_a_friend`. Expected: the tool returns the fake response and records a session call without requiring real model auth.

### 4. Autoresearch fixture smoke test

Create `autoresearch.jsonl`:

```jsonl
{"type":"config","name":"test","metricName":"score","metricUnit":"","bestDirection":"lower"}
{"run":1,"metric":100,"status":"keep","description":"baseline","timestamp":1}
{"run":2,"metric":101,"status":"discard","description":"bad 1","timestamp":2}
{"run":3,"metric":102,"status":"discard","description":"bad 2","timestamp":3}
{"run":4,"metric":103,"status":"discard","description":"bad 3","timestamp":4}
```

Start Pi with the extension and run `/lifeline`. Expected: current decision says trigger due to 3 consecutive failures.

### 5. Real advisor smoke test

Configure a cheap available model first:

```json
{
  "auto": true,
  "action": "ask",
  "minRunsBetweenCalls": 0,
  "triggerAfterConsecutiveFailures": 1,
  "triggerAfterPlateauRuns": 99,
  "maxCallsPerSession": 1,
  "advisor": {
    "provider": "google",
    "model": "gemini-2.5-flash",
    "maxTokens": 1024,
    "temperature": 0.3
  }
}
```

Expected:

- advisor auth resolves via Pi model registry
- main model is not changed
- advisor returns a concise strategy message
- no code is modified by the advisor directly

## Design notes

- The small model remains responsible for edits and experiments.
- The strong model is used only for strategic advice.
- Defaults are intentionally conservative to avoid token waste.
- `action: "nudge"` makes cost explicit; `action: "ask"` is available for trusted unattended runs.
