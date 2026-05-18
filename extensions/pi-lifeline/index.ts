import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  DEFAULT_POLICY,
  normalizePolicy,
  shouldTriggerLifeline,
  type LifelinePolicyConfig,
  type LifelineRun,
} from "./policy.ts";

interface AdvisorConfig {
  provider?: string;
  model?: string;
  maxTokens: number;
  temperature: number;
}

interface LifelineConfig extends LifelinePolicyConfig {
  action: "nudge" | "ask";
  advisor: AdvisorConfig;
  includeAutoresearchContext: boolean;
}

interface RuntimeState {
  callsThisSession: number;
  lastCallRun: number | null;
  lastTriggerRun: number | null;
  lastReason: string | null;
  lastAdvice: string | null;
}

const DEFAULT_CONFIG: LifelineConfig = {
  ...DEFAULT_POLICY,
  action: "nudge",
  advisor: {
    provider: process.env.PI_LIFELINE_ADVISOR_PROVIDER,
    model: process.env.PI_LIFELINE_ADVISOR_MODEL,
    maxTokens: numberFromEnv("PI_LIFELINE_MAX_TOKENS", 4096),
    temperature: numberFromEnv("PI_LIFELINE_TEMPERATURE", 0.7),
  },
  includeAutoresearchContext: true,
};

const PhoneAFriendParams = Type.Object({
  question: Type.String({ description: "Specific question for the stronger advisor model." }),
  context: Type.Optional(Type.String({ description: "Relevant context, observations, logs, or code summary." })),
  mode: Type.Optional(Type.Union([
    Type.Literal("ideas"),
    Type.Literal("critique"),
    Type.Literal("debug"),
    Type.Literal("next_experiment"),
  ], { description: "Kind of advice desired. Default: next_experiment." })),
  max_ideas: Type.Optional(Type.Number({ description: "Maximum number of ideas to request. Default: 5." })),
  provider: Type.Optional(Type.String({ description: "Override advisor provider from pi model registry." })),
  model: Type.Optional(Type.String({ description: "Override advisor model from pi model registry." })),
});

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function configPath(cwd: string): string {
  return path.join(cwd, "pi-lifeline.json");
}

function readConfig(cwd: string): LifelineConfig {
  let fromFile: Record<string, unknown> = {};
  try {
    const p = configPath(cwd);
    if (fs.existsSync(p)) fromFile = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    fromFile = {};
  }

  const advisorInput = typeof fromFile.advisor === "object" && fromFile.advisor !== null
    ? fromFile.advisor as Record<string, unknown>
    : {};

  const policy = normalizePolicy(fromFile as Partial<LifelinePolicyConfig>);
  const action = fromFile.action === "ask" ? "ask" : "nudge";
  return {
    ...policy,
    action,
    advisor: {
      provider: stringOr(advisorInput.provider, DEFAULT_CONFIG.advisor.provider),
      model: stringOr(advisorInput.model, DEFAULT_CONFIG.advisor.model),
      maxTokens: positiveNumber(advisorInput.maxTokens, DEFAULT_CONFIG.advisor.maxTokens),
      temperature: nonNegativeNumber(advisorInput.temperature, DEFAULT_CONFIG.advisor.temperature),
    },
    includeAutoresearchContext: typeof fromFile.includeAutoresearchContext === "boolean"
      ? fromFile.includeAutoresearchContext
      : DEFAULT_CONFIG.includeAutoresearchContext,
  };
}

function stringOr(value: unknown, fallback: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readTextIfExists(filePath: string, maxChars: number): string {
  try {
    if (!fs.existsSync(filePath)) return "";
    const text = fs.readFileSync(filePath, "utf-8");
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return "";
  }
}

function parseJsonlLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readAutoresearchState(cwd: string): { runs: LifelineRun[]; direction: "lower" | "higher"; summary: string } {
  const jsonlPath = path.join(cwd, "autoresearch.jsonl");
  if (!fs.existsSync(jsonlPath)) return { runs: [], direction: "lower", summary: "" };

  const lines = readTextIfExists(jsonlPath, 200_000).split("\n").filter(Boolean);
  const runs: LifelineRun[] = [];
  let direction: "lower" | "higher" = "lower";
  let metricName = "metric";

  for (const line of lines) {
    const entry = parseJsonlLine(line);
    if (!entry) continue;
    if (entry.type === "config") {
      direction = entry.bestDirection === "higher" ? "higher" : "lower";
      if (typeof entry.metricName === "string") metricName = entry.metricName;
      continue;
    }
    if (typeof entry.run !== "number") continue;
    const status = entry.status;
    if (status !== "keep" && status !== "discard" && status !== "crash" && status !== "checks_failed") continue;
    runs.push({
      run: entry.run,
      metric: typeof entry.metric === "number" ? entry.metric : 0,
      status,
      timestamp: typeof entry.timestamp === "number" ? entry.timestamp : undefined,
      description: typeof entry.description === "string" ? entry.description : undefined,
      segment: typeof entry.segment === "number" ? entry.segment : undefined,
    });
  }

  const recent = runs.slice(-8).map((r) => `#${r.run} ${r.status} ${metricName}=${r.metric} ${r.description ?? ""}`.trim()).join("\n");
  return { runs, direction, summary: recent ? `Recent autoresearch runs:\n${recent}` : "" };
}

function buildAdvisorPrompt(args: {
  question: string;
  context?: string;
  mode: string;
  maxIdeas: number;
  autoresearchContext: string;
}): string {
  return [
    "You are a senior research advisor helping a smaller coding model running an optimization/autoresearch loop.",
    "Do not write full patches. Give strategic, testable advice the smaller model can execute locally.",
    "Avoid benchmark cheating and call out overfitting risks.",
    `Mode: ${args.mode}`,
    `Return at most ${args.maxIdeas} ranked ideas. For each idea include: rationale, concrete next experiment, and expected signal.`,
    "",
    args.autoresearchContext,
    args.context ? `Additional context:\n${args.context}` : "",
    `Question:\n${args.question}`,
  ].filter(Boolean).join("\n\n");
}

async function askAdvisor(
  ctx: ExtensionContext,
  config: LifelineConfig,
  params: {
    question: string;
    context?: string;
    mode?: string;
    max_ideas?: number;
    provider?: string;
    model?: string;
  },
): Promise<{ text: string; provider: string; model: string; fake: boolean }> {
  const fake = process.env.PI_LIFELINE_FAKE_RESPONSE;
  const provider = params.provider ?? config.advisor.provider;
  const modelId = params.model ?? config.advisor.model;

  const ar = config.includeAutoresearchContext ? readAutoresearchState(ctx.cwd).summary : "";
  const prompt = buildAdvisorPrompt({
    question: params.question,
    context: params.context,
    mode: params.mode ?? "next_experiment",
    maxIdeas: Math.max(1, Math.floor(params.max_ideas ?? 5)),
    autoresearchContext: ar,
  });

  if (fake !== undefined) {
    return { text: fake, provider: "fake", model: "env", fake: true };
  }

  if (!provider || !modelId) {
    throw new Error(`No advisor model configured. Add pi-lifeline.json with { "advisor": { "provider": "openai", "model": "gpt-5.5" } } or set PI_LIFELINE_FAKE_RESPONSE for tests.`);
  }

  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`Advisor model not found in pi registry: ${provider}/${modelId}`);

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`Advisor auth failed: ${auth.error}`);
  if (!auth.apiKey) throw new Error(`No API key configured for advisor provider: ${provider}`);

  const response = await complete(
    model,
    {
      messages: [{
        role: "user" as const,
        content: [{ type: "text" as const, text: prompt }],
        timestamp: Date.now(),
      }],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: config.advisor.maxTokens,
      temperature: config.advisor.temperature,
      signal: ctx.signal,
    },
  );

  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (!text) throw new Error("Advisor returned an empty response");
  return { text, provider, model: modelId, fake: false };
}

function runtimeStore() {
  const store = new Map<string, RuntimeState>();
  return {
    get(ctx: ExtensionContext): RuntimeState {
      const key = ctx.sessionManager.getSessionId();
      let state = store.get(key);
      if (!state) {
        state = { callsThisSession: 0, lastCallRun: null, lastTriggerRun: null, lastReason: null, lastAdvice: null };
        store.set(key, state);
      }
      return state;
    },
    clear(ctx: ExtensionContext) {
      store.delete(ctx.sessionManager.getSessionId());
    },
  };
}

function isLogExperimentResult(event: { toolName: string; details?: unknown }): boolean {
  return event.toolName === "log_experiment";
}

export default function lifelineExtension(pi: ExtensionAPI) {
  const runtimes = runtimeStore();

  pi.on("session_shutdown", async (_event, ctx) => {
    runtimes.clear(ctx);
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    return {
      systemPrompt: event.systemPrompt +
        "\n\n## Pi Lifeline" +
        "\nYou have access to phone_a_friend for occasional strategic advice from a stronger advisor model." +
        "\nUse it when stuck, plateaued, or after repeated failed experiments. Do not call it every iteration.",
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!isLogExperimentResult(event)) return;

    const config = readConfig(ctx.cwd);
    const state = runtimes.get(ctx);
    const ar = readAutoresearchState(ctx.cwd);
    if (ar.runs.length === 0) return;

    const decision = shouldTriggerLifeline(ar.runs, config, state, ar.direction);
    if (!decision.shouldTrigger) return;
    if (state.lastTriggerRun === decision.currentRun) return;

    state.lastTriggerRun = decision.currentRun;
    state.lastReason = decision.reason;

    if (config.action === "nudge") {
      pi.sendUserMessage(
        `☎️ Lifeline trigger: ${decision.reason}. Before the next experiment, call phone_a_friend for fresh strategy. Keep the question concise and include recent autoresearch observations.`,
        { deliverAs: "steer" },
      );
      return;
    }

    try {
      const advice = await askAdvisor(ctx, config, {
        mode: "next_experiment",
        max_ideas: 5,
        question: `Autoresearch appears stuck because ${decision.reason}. Suggest the next high-leverage experiments.`,
      });
      state.callsThisSession++;
      state.lastCallRun = decision.currentRun;
      state.lastAdvice = advice.text;
      pi.sendUserMessage(
        `☎️ Lifeline advice from ${advice.provider}/${advice.model}:\n\n${advice.text}`,
        { deliverAs: "steer" },
      );
    } catch (error) {
      pi.sendUserMessage(
        `☎️ Lifeline trigger fired (${decision.reason}) but advisor call failed: ${error instanceof Error ? error.message : String(error)}. You may call phone_a_friend manually after fixing config.`,
        { deliverAs: "steer" },
      );
    }
  });

  pi.registerTool({
    name: "phone_a_friend",
    label: "Phone a Friend",
    description: "Ask a stronger advisor model for strategic advice, experiment ideas, critique, or debugging help. Intended for occasional use when stuck, not every iteration.",
    promptSnippet: "Ask stronger advisor model for occasional strategic help",
    promptGuidelines: [
      "Use this only when stuck, plateaued, or after repeated failures — not every iteration.",
      "Ask for strategy and experiments, not complete patches.",
      "Include recent metrics, failed ideas, and constraints so the advisor can be specific.",
    ],
    parameters: PhoneAFriendParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = readConfig(ctx.cwd);
      const state = runtimes.get(ctx);
      try {
        const advice = await askAdvisor(ctx, config, params);
        const ar = readAutoresearchState(ctx.cwd);
        state.callsThisSession++;
        state.lastCallRun = ar.runs.length > 0 ? Math.max(...ar.runs.map((r) => r.run)) : state.lastCallRun;
        state.lastAdvice = advice.text;
        return {
          content: [{ type: "text" as const, text: `☎️ Advice from ${advice.provider}/${advice.model}${advice.fake ? " (fake)" : ""}:\n\n${advice.text}` }],
          details: { provider: advice.provider, model: advice.model, fake: advice.fake, callsThisSession: state.callsThisSession },
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `☎️ phone_a_friend failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: error instanceof Error ? error.message : String(error) },
        };
      }
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("phone_a_friend ")) + theme.fg("muted", args.question ?? ""), 0, 0);
    },
    renderResult(result, _options, _theme) {
      const first = result.content[0];
      return new Text(first?.type === "text" ? first.text : "", 0, 0);
    },
  });

  pi.registerCommand("lifeline", {
    description: "Show pi-lifeline status and configuration",
    handler: async (args, ctx) => {
      const command = (args ?? "").trim().toLowerCase();
      const config = readConfig(ctx.cwd);
      const state = runtimes.get(ctx);
      const ar = readAutoresearchState(ctx.cwd);
      const decision = shouldTriggerLifeline(ar.runs, config, state, ar.direction);

      if (command === "sample-config") {
        ctx.ui.notify(JSON.stringify({
          auto: true,
          action: "nudge",
          minRunsBetweenCalls: 5,
          triggerAfterConsecutiveFailures: 3,
          triggerAfterPlateauRuns: 6,
          maxCallsPerSession: 10,
          advisor: { provider: "openai", model: "gpt-5.5", maxTokens: 4096, temperature: 0.7 },
          includeAutoresearchContext: true,
        }, null, 2), "info");
        return;
      }

      ctx.ui.notify([
        "☎️ pi-lifeline",
        `config: ${fs.existsSync(configPath(ctx.cwd)) ? configPath(ctx.cwd) : "defaults/env"}`,
        `advisor: ${config.advisor.provider ?? "(unset)"}/${config.advisor.model ?? "(unset)"}`,
        `auto: ${config.auto}, action: ${config.action}`,
        `thresholds: failures=${config.triggerAfterConsecutiveFailures}, plateau=${config.triggerAfterPlateauRuns}, minRunsBetweenCalls=${config.minRunsBetweenCalls}, maxCalls=${config.maxCallsPerSession}`,
        `session calls: ${state.callsThisSession}, lastCallRun: ${state.lastCallRun ?? "never"}`,
        `autoresearch runs: ${ar.runs.length}`,
        `current decision: ${decision.shouldTrigger ? `trigger (${decision.reason})` : "no trigger"}`,
        "Use /lifeline sample-config to print a starter pi-lifeline.json.",
      ].join("\n"), "info");
    },
  });
}
