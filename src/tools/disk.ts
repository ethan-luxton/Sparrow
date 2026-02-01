import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolDefinition } from './registry.js';
import { resolveWithinRoots } from '../lib/safePath.js';

const execFileAsync = promisify(execFile);

export function diskTool(): ToolDefinition {
  return {
    name: 'disk_usage',
    description: 'Show disk usage (df -h) and optionally du -sh for a path.',
    permission: 'read',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        includeDirs: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: async (args: { path?: string; includeDirs?: boolean }) => {
      const parts: string[] = [];
      const { stdout: dfOut } = await execFileAsync('df', ['-h'], { timeout: 5000, maxBuffer: 12000 });
      parts.push('df -h:\n' + dfOut.trim());
      if (args.path) {
        const target = resolveWithinRoots(args.path, process.cwd());
        if (args.includeDirs) {
          const { stdout } = await execFileAsync('du', ['-sh', `${target}/*`], { timeout: 5000, maxBuffer: 12000 });
          parts.push(`\ndu -sh ${target}/*:\n` + stdout.trim());
        } else {
          const { stdout } = await execFileAsync('du', ['-sh', target], { timeout: 5000, maxBuffer: 12000 });
          parts.push(`\ndu -sh ${target}:\n` + stdout.trim());
        }
      }
      return parts.join('\n');
    },
  };
}
