import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolDefinition } from './registry.js';

const execFileAsync = promisify(execFile);

export function processTool(): ToolDefinition {
  return {
    name: 'process_list',
    description: 'List top processes by CPU usage.',
    permission: 'read',
    schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    handler: async (args: { limit?: number }) => {
      const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
      const { stdout } = await execFileAsync('ps', ['-eo', 'pid,comm,%cpu,%mem', '--sort=-%cpu'], {
        timeout: 5000,
        maxBuffer: 12000,
      });
      const lines = stdout.trim().split('\n');
      const header = lines.shift() ?? '';
      const top = lines.slice(0, limit);
      return [header, ...top].join('\n');
    },
  };
}
