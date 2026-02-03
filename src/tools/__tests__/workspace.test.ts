import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { workspaceTool } from '../workspace.js';

function withTempWorkspace<T>(fn: (root: string) => Promise<T> | T) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixeltrail-ws-'));
  process.env.PIXELTRAIL_WORKSPACE_ROOT = root;
  try {
    return fn(root);
  } finally {
    fs.removeSync(root);
    delete process.env.PIXELTRAIL_WORKSPACE_ROOT;
  }
}

test('workspace blocks path traversal', async () => {
  await withTempWorkspace(async (root) => {
    const tool = workspaceTool();
    await tool.handler({ action: 'ensure_project', project: 'alpha' }, 0);
    await assert.rejects(
      async () => {
        await tool.handler({ action: 'read_file', project: 'alpha', path: '../secret.txt' }, 0);
      },
      /Path traversal/
    );
    assert.ok(fs.existsSync(root));
  });
});

test('workspace blocks symlink escape', async () => {
  await withTempWorkspace(async () => {
    const tool = workspaceTool();
    await tool.handler({ action: 'ensure_project', project: 'beta' }, 0);
    const projectDir = path.join(process.env.PIXELTRAIL_WORKSPACE_ROOT as string, 'beta');
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixeltrail-out-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    await fs.writeFile(outsideFile, 'secret', 'utf8');
    const linkPath = path.join(projectDir, 'link');
    fs.symlinkSync(outsideFile, linkPath);
    await assert.rejects(
      async () => {
        await tool.handler({ action: 'read_file', project: 'beta', path: 'link' }, 0);
      },
      /Symlink escapes/
    );
    fs.removeSync(outsideDir);
  });
});
