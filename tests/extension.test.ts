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
