import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolDefinition } from './registry.js';

const execFileAsync = promisify(execFile);

export function serviceTool(): ToolDefinition {
  return {
    name: 'service_status',
    description: 'Check systemd service status or recent logs (read-only).',
    permission: 'read',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'logs'] },
        name: { type: 'string' },
        lines: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['action', 'name'],
      additionalProperties: false,
    },
    handler: async (args: { action: 'status' | 'logs'; name: string; lines?: number }) => {
      const name = String(args.name).trim();
      if (!name) throw new Error('name is required');
      try {
        if (args.action === 'status') {
          const { stdout } = await execFileAsync('systemctl', ['status', name, '--no-pager'], { timeout: 5000, maxBuffer: 12000 });
          return stdout.trim() || 'No status output.';
        }
        const lines = Math.min(Math.max(args.lines ?? 50, 1), 200);
        const { stdout } = await execFileAsync('journalctl', ['-u', name, '-n', String(lines), '--no-pager'], {
          timeout: 5000,
          maxBuffer: 12000,
        });
        return stdout.trim() || 'No logs output.';
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          return 'systemctl/journalctl not available on this system.';
        }
        return `Service query failed: ${err?.message ?? 'unknown error'}`;
      }
    },
  };
}
