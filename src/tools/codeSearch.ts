import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolDefinition } from './registry.js';
import { resolveWithinRoots } from '../lib/safePath.js';

const execFileAsync = promisify(execFile);

export function codeSearchTool(): ToolDefinition {
  return {
    name: 'code_search',
    description: 'Search code/text using ripgrep (rg) with safe defaults; falls back to grep if rg is unavailable.',
    permission: 'read',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string' },
        maxResults: { type: 'integer', minimum: 1, maximum: 200 },
        caseSensitive: { type: 'boolean' },
        glob: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args: { query: string; path?: string; maxResults?: number; caseSensitive?: boolean; glob?: string }) => {
      const basePath = resolveWithinRoots(args.path ?? '.', process.cwd());
      const max = Math.min(Math.max(args.maxResults ?? 50, 1), 200);
      const query = String(args.query);
      const glob = args.glob ? String(args.glob) : undefined;

      const rgArgs = ['-n', '--no-heading', '--color=never', `-m`, String(max)];
      if (args.caseSensitive === false) rgArgs.push('-i');
      if (glob) rgArgs.push('-g', glob);
      rgArgs.push(query, basePath);

      try {
        const { stdout } = await execFileAsync('rg', rgArgs, { timeout: 5000, maxBuffer: 12000 });
        return stdout.trim() || 'No matches.';
      } catch (err: any) {
        if (err?.code === 1) {
          const out = err?.stdout?.toString?.() ?? '';
          return out.trim() || 'No matches.';
        }
        // Fallback to grep if rg isn't available
        if (err?.code === 'ENOENT') {
          const grepArgs = ['-R', '-n'];
          if (args.caseSensitive === false) grepArgs.push('-i');
          grepArgs.push(query, basePath);
          try {
            const { stdout } = await execFileAsync('grep', grepArgs, { timeout: 5000, maxBuffer: 12000 });
            const lines = stdout.trim().split('\n').slice(0, max).join('\n');
            return lines || 'No matches.';
          } catch (grepErr: any) {
            if (grepErr?.code === 1) return 'No matches.';
            const msg = grepErr?.message ?? 'grep failed';
            return `Search failed: ${msg}`;
          }
        }
        const msg = err?.message ?? 'search failed';
        return `Search failed: ${msg}`;
      }
    },
  };
}
