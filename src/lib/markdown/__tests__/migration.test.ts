import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { migrateWorkspaceDocs } from '../migration.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pixeltrail-migrate-'));
}

test('migration helper creates new docs and copies legacy content', () => {
  const root = makeTempDir();
  const agentDir = path.join(root, 'agent', 'mds');
  fs.ensureDirSync(path.join(root, 'src', 'guides'));
  fs.writeFileSync(path.join(root, 'src', 'guides', 'personality.md'), 'legacy personality');
  fs.writeFileSync(path.join(root, 'CLI.md'), 'legacy cli');
  fs.writeFileSync(path.join(root, 'heartbeat.md'), 'legacy heartbeat');

  const prevCwd = process.cwd();
  process.chdir(root);
  process.env.PIXELTRAIL_AGENT_MDS_DIR = agentDir;
  try {
    migrateWorkspaceDocs();
    const soul = fs.readFileSync(path.join(agentDir, 'SOUL.md'), 'utf8');
    const tools = fs.readFileSync(path.join(agentDir, 'TOOLS.md'), 'utf8');
    const hb = fs.readFileSync(path.join(agentDir, 'HEARTBEAT.md'), 'utf8');
    assert.ok(soul.includes('legacy personality'));
    assert.ok(tools.includes('legacy cli'));
    assert.ok(hb.includes('legacy heartbeat'));
  } finally {
    process.chdir(prevCwd);
    delete process.env.PIXELTRAIL_AGENT_MDS_DIR;
  }
});
