import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { injectMarkdown, resolveToolMdPath } from '../injector.js';
import type { ToolDefinition } from '../../../tools/registry.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-md-'));
}

test('injector ordering and determinism', () => {
  const root = makeTempDir();
  const agentDir = path.join(root, 'agent');
  const toolsDir = path.join(root, 'tools');
  fs.ensureDirSync(agentDir);
  fs.ensureDirSync(toolsDir);
  const docs = ['BOOTSTRAP', 'IDENTITY', 'SOUL', 'USER', 'TOOLS', 'AGENTS', 'HEARTBEAT'];
  for (const d of docs) {
    fs.writeFileSync(path.join(agentDir, `${d}.md`), `${d} content`);
  }
  const tools: ToolDefinition[] = [];
  const resultA = injectMarkdown({
    userText: 'hello',
    tools,
    config: { agentDir, toolsDir, perFileMaxChars: 200, totalMaxChars: 2000, toolDocsMaxChars: 200, recentToolLimit: 2 },
  });
  const resultB = injectMarkdown({
    userText: 'hello',
    tools,
    config: { agentDir, toolsDir, perFileMaxChars: 200, totalMaxChars: 2000, toolDocsMaxChars: 200, recentToolLimit: 2 },
  });
  assert.equal(resultA.text, resultB.text);
  const order = docs.map((d) => resultA.text.indexOf(`--- ${d}.md ---`));
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], `${docs[i]} should appear after ${docs[i - 1]}`);
  }
});

test('injector truncation and missing markers', () => {
  const root = makeTempDir();
  const agentDir = path.join(root, 'agent');
  const toolsDir = path.join(root, 'tools');
  fs.ensureDirSync(agentDir);
  fs.ensureDirSync(toolsDir);
  fs.writeFileSync(path.join(agentDir, 'BOOTSTRAP.md'), 'x'.repeat(200));
  const res = injectMarkdown({
    userText: 'hello',
    tools: [],
    config: { agentDir, toolsDir, perFileMaxChars: 50, totalMaxChars: 200, toolDocsMaxChars: 50, recentToolLimit: 2 },
  });
  assert.ok(res.text.includes('(truncated)'));
  assert.ok(res.text.includes('[missing: IDENTITY.md]'));
});

test('tool md resolution', () => {
  const root = makeTempDir();
  const toolsDir = path.join(root, 'tools');
  const result = resolveToolMdPath('cli', { agentDir: '/x', toolsDir, perFileMaxChars: 10, totalMaxChars: 10, toolDocsMaxChars: 10, recentToolLimit: 2 });
  assert.equal(result, path.join(toolsDir, 'cli.md'));
});
