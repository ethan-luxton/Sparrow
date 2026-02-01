import test from 'node:test';
import assert from 'node:assert/strict';
import { cliTool } from '../cli.js';

test('cli allowlist blocks disallowed commands', async () => {
  const tool = cliTool();
  await assert.rejects(
    async () => {
      await tool.handler({ command: 'rm', args: ['-rf', '/'] } as any, 1);
    },
    /Command not allowed/
  );
});
