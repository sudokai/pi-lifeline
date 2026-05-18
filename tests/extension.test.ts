import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import lifelineExtension from "../extensions/pi-lifeline/index.ts";

function makeHarness() {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sent: Array<{ text: string; options?: unknown }> = [];

  const pi = {
    on(name: string, handler: Function) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    sendUserMessage(text: string, options?: unknown) {
      sent.push({ text, options });
    },
  };

  lifelineExtension(pi as any);
  return { handlers, tools, commands, sent };
}

function withTempAgentDir(): { dir: string; restore: () => void } {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lifeline-agent-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return {
    dir,
    restore: () => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    },
  };
}

function makeCtx(cwd: string) {
  return {
    cwd,
    signal: undefined,
    sessionManager: {
      getSessionId: () => "test-session",
    },
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: false, error: "not configured" }),
    },
    ui: {
      notify: () => {},
    },
  };
}

test("extension registers phone_a_friend tool and lifeline command", () => {
  const { tools, commands, handlers } = makeHarness();

  assert.ok(tools.has("phone_a_friend"));
  assert.ok(commands.has("lifeline"));
  assert.ok((handlers.get("tool_result") ?? []).length > 0);
  assert.ok((handlers.get("before_agent_start") ?? []).length > 0);
});

test("phone_a_friend returns fake advisor response without calling a model", async () => {
  const previous = process.env.PI_LIFELINE_FAKE_RESPONSE;
  process.env.PI_LIFELINE_FAKE_RESPONSE = "Try a targeted phase-timing benchmark before more edits.";

  try {
    const { tools } = makeHarness();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lifeline-test-"));
    const tool = tools.get("phone_a_friend");

    const result = await tool.execute(
      "tool-call-1",
      { question: "What next?", mode: "next_experiment", max_ideas: 3 },
      undefined,
      undefined,
      makeCtx(cwd) as any,
    );

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Advice from fake\/env/);
    assert.match(result.content[0].text, /targeted phase-timing/);
    assert.equal(result.details.fake, true);
    assert.equal(result.details.callsThisSession, 1);
  } finally {
    if (previous === undefined) delete process.env.PI_LIFELINE_FAKE_RESPONSE;
    else process.env.PI_LIFELINE_FAKE_RESPONSE = previous;
  }
});

test("/lifeline init interactive wizard writes selected provider, model, thinking, and action", async () => {
  const agent = withTempAgentDir();
  try {
  const { commands } = makeHarness();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lifeline-wizard-"));
  const ctx = makeCtx(cwd) as any;
  const choices = [
    "anthropic/claude-opus-test — Claude Opus Test",
    "high",
    "ask — automatically call the advisor",
  ];
  ctx.modelRegistry.getAvailable = async () => [{
    provider: "anthropic",
    id: "claude-opus-test",
    name: "Claude Opus Test",
    reasoning: true,
    thinkingLevelMap: { off: null, high: "high", xhigh: "max" },
  }];
  ctx.ui.select = async () => choices.shift();
  ctx.ui.notify = () => {};

  await commands.get("lifeline").handler("init", ctx);

  const config = JSON.parse(fs.readFileSync(path.join(agent.dir, "pi-lifeline.json"), "utf-8"));
  assert.equal(config.action, "ask");
  assert.equal(config.advisor.provider, "anthropic");
  assert.equal(config.advisor.model, "claude-opus-test");
  assert.equal(config.advisor.thinking, "high");
  } finally {
    agent.restore();
  }
});

test("/lifeline init creates a starter config without overwriting", async () => {
  const agent = withTempAgentDir();
  try {
  const { commands } = makeHarness();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lifeline-init-"));
  const notices: Array<{ text: string; level: string }> = [];
  const ctx = makeCtx(cwd) as any;
  ctx.ui.notify = (text: string, level: string) => notices.push({ text, level });

  await commands.get("lifeline").handler("init", ctx);

  const configPath = path.join(agent.dir, "pi-lifeline.json");
  assert.ok(fs.existsSync(configPath));
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  assert.equal(config.action, "nudge");
  assert.equal(config.triggerAfterConsecutiveFailures, 3);
  assert.equal(config.advisor.provider, "openai");
  assert.match(notices.at(-1)?.text ?? "", /Created/);

  fs.writeFileSync(configPath, JSON.stringify({ sentinel: true }));
  await commands.get("lifeline").handler("init", ctx);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf-8")), { sentinel: true });
  assert.match(notices.at(-1)?.text ?? "", /already exists/);
  } finally {
    agent.restore();
  }
});

test("log_experiment result with three consecutive failures sends a lifeline nudge", async () => {
  const { handlers, sent } = makeHarness();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lifeline-ar-"));
  fs.writeFileSync(path.join(cwd, "autoresearch.jsonl"), [
    { type: "config", name: "test", metricName: "score", metricUnit: "", bestDirection: "lower" },
    { run: 1, metric: 100, status: "keep", description: "baseline", timestamp: 1 },
    { run: 2, metric: 101, status: "discard", description: "bad 1", timestamp: 2 },
    { run: 3, metric: 102, status: "crash", description: "bad 2", timestamp: 3 },
    { run: 4, metric: 103, status: "checks_failed", description: "bad 3", timestamp: 4 },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const toolResultHandlers = handlers.get("tool_result") ?? [];
  assert.ok(toolResultHandlers.length > 0);

  await toolResultHandlers[0]({ toolName: "log_experiment", details: {} }, makeCtx(cwd) as any);

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Lifeline trigger/);
  assert.match(sent[0].text, /3 consecutive/);
  assert.match(sent[0].text, /phone_a_friend/);
});
