import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { gitTool } from '../git.js';
import { ToolRegistry } from '../registry.js';

test('git tool blocks force flags', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixeltrail-ws-'));
  process.env.PIXELTRAIL_WORKSPACE_ROOT = root;
  try {
    const tool = gitTool();
    await assert.rejects(
      async () => {
        await tool.handler({ action: 'push', project: 'alpha', force: true }, 0);
      },
      /not allowed/
    );
  } finally {
    fs.removeSync(root);
    delete process.env.PIXELTRAIL_WORKSPACE_ROOT;
  }
});

test('git commit requires approval', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixeltrail-ws-'));
  process.env.PIXELTRAIL_WORKSPACE_ROOT = root;
  try {
    const registry = new ToolRegistry();
    registry.register(gitTool());
    await assert.rejects(
      async () => {
        await registry.run('git', { action: 'commit', project: 'alpha', message: 'test' }, 1);
      },
      /requires confirm=true/
    );
  } finally {
    fs.removeSync(root);
    delete process.env.PIXELTRAIL_WORKSPACE_ROOT;
  }
});
