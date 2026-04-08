import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskMatcher, shouldSkipAgentGenerateTitle } from "../src/task-matcher.js";

test("shouldSkipAgentGenerateTitle skips error-dump and long titles", () => {
  assert.equal(shouldSkipAgentGenerateTitle("normal tutorial task"), false);
  assert.equal(shouldSkipAgentGenerateTitle('Recurring LLM ERROR] 401 foo'), true);
  process.env.DARWIN_AGENT_GENERATE_TITLE_MAX_LEN = "10";
  assert.equal(shouldSkipAgentGenerateTitle("12345678901"), true);
  delete process.env.DARWIN_AGENT_GENERATE_TITLE_MAX_LEN;
});

test("agent generate failure applies cooldown: second cycle does not call callback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "darwin-tm-"));
  const hub = {
    nodeId: "n1",
    registerWorker: async () => ({}),
    getMyWork: async () => ({ assignments: [] }),
  };
  const tm = new TaskMatcher({ hub, dataDir: dir, autoSubmit: true });
  await tm.register({ enabled: true });

  let calls = 0;
  tm.setGenerateCallback(async () => {
    calls++;
    return null;
  });

  const task = {
    task_id: "task-cooldown-1",
    title: "short title",
    signals: "sig-a,sig-b",
  };
  const store = {
    findByTaskType: () => [],
    ranked: () => [],
    capacity: 100,
  };
  const darwin = {
    getBufferedTasks: () => [task],
    store,
    hub: { validate: async () => ({ valid: true }) },
    _emit: () => {},
  };

  await tm.cycle(darwin);
  assert.equal(calls, 1);

  await tm.cycle(darwin);
  assert.equal(calls, 1);

  const statePath = join(dir, "agent-generate-state.json");
  const raw = JSON.parse(readFileSync(statePath, "utf-8"));
  assert.ok(raw.tasks["task-cooldown-1"]);
  assert.ok(raw.tasks["task-cooldown-1"].nextEligibleAt > Date.now() - 1000);

  rmSync(dir, { recursive: true, force: true });
});

test("skipped titles do not invoke generate callback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "darwin-tm-"));
  const hub = {
    nodeId: "n1",
    registerWorker: async () => ({}),
    getMyWork: async () => ({ assignments: [] }),
  };
  const tm = new TaskMatcher({ hub, dataDir: dir, autoSubmit: true });
  await tm.register({ enabled: true });

  let calls = 0;
  tm.setGenerateCallback(async () => {
    calls++;
    return null;
  });

  const task = {
    task_id: "task-skip-1",
    title: "prefix LLM ERROR] 401 tail",
    signals: "x,y",
  };
  const store = { findByTaskType: () => [], ranked: () => [], capacity: 100 };
  const darwin = {
    getBufferedTasks: () => [task],
    store,
    hub: { validate: async () => ({ valid: true }) },
    _emit: () => {},
  };

  await tm.cycle(darwin);
  assert.equal(calls, 0);

  rmSync(dir, { recursive: true, force: true });
});
