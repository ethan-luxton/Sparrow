import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolDefinition } from './registry.js';
import { resolveWithinRoots } from '../lib/safePath.js';

const execFileAsync = promisify(execFile);

export function fileDiffTool(): ToolDefinition {
  return {
    name: 'file_diff',
    description: 'Show a unified diff between two files within allowed roots.',
    permission: 'read',
    schema: {
      type: 'object',
      properties: {
        pathA: { type: 'string' },
        pathB: { type: 'string' },
        context: { type: 'integer', minimum: 0, maximum: 20 },
      },
      required: ['pathA', 'pathB'],
      additionalProperties: false,
    },
    handler: async (args: { pathA: string; pathB: string; context?: number }) => {
      const a = resolveWithinRoots(args.pathA, process.cwd());
      const b = resolveWithinRoots(args.pathB, process.cwd());
      const ctx = Math.min(Math.max(args.context ?? 3, 0), 20);
      try {
        const { stdout } = await execFileAsync('diff', ['-u', `-U`, String(ctx), a, b], { timeout: 5000, maxBuffer: 12000 });
        return stdout.trim() || 'No differences.';
      } catch (err: any) {
        // diff returns exit code 1 when differences exist; stdout still contains diff
        const out = err?.stdout?.toString?.() ?? '';
        if (out.trim()) return out.trim();
        const msg = err?.message ?? 'diff failed';
        return `Diff failed: ${msg}`;
      }
    },
  };
}
