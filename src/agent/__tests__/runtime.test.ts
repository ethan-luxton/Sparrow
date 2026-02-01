import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ToolRegistry, type ToolDefinition } from '../../tools/registry.js';
import { AgentRuntime } from '../runtime.js';
import { enqueueTask, getNextTask } from '../store.js';

function createStubLLM() {
  return {
    summarizeRepoRecon: async () => ({ text: 'summary' }),
    summarizeCalendar: async () => ({ text: 'calendar summary' }),
    phraseUserUpdate: async () => ({ text: 'update' }),
  };
}

test('tick budget prevents multiple tool calls per tick', async () => {
  const db = new Database(':memory:');
  const registry = new ToolRegistry();
  let calls = 0;
  const tool: ToolDefinition = {
    name: 'cli',
    description: 'stub cli',
    permission: 'read',
    schema: { type: 'object', properties: {}, additionalProperties: true },
    handler: async () => {
      calls += 1;
      return 'ok';
    },
  };
  registry.register(tool);

  const runtime = new AgentRuntime({
    tools: registry,
    llm: createStubLLM(),
    notify: async () => {},
    db,
    options: { tickMaxToolCalls: 1 },
  });

  enqueueTask(
    { chatId: 1, objectiveId: null, type: 'tool', payload: { tool: 'cli', args: { action: 'run', commands: ['echo ok'] } } },
    db
  );
  enqueueTask(
    { chatId: 1, objectiveId: null, type: 'tool', payload: { tool: 'cli', args: { action: 'run', commands: ['echo ok'] } } },
    db
  );

  await runtime.tick(1);
  assert.equal(calls, 1);
  const next = getNextTask(1, db);
  assert.ok(next, 'second task remains queued');
});
