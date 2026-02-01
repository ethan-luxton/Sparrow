import fs from 'fs-extra';
import { ToolDefinition } from './registry.js';
import { resolveWithinRoots } from '../lib/safePath.js';

export function fileSnippetTool(): ToolDefinition {
  return {
    name: 'file_snippet',
    description: 'Read a small line-range snippet from a file within allowed roots.',
    permission: 'read',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        maxLines: { type: 'integer', minimum: 1, maximum: 500 },
        maxBytes: { type: 'integer', minimum: 1, maximum: 200000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args: { path: string; startLine?: number; endLine?: number; maxLines?: number; maxBytes?: number }) => {
      const target = resolveWithinRoots(args.path, process.cwd());
      const maxBytes = Math.min(args.maxBytes ?? 200000, 200000);
      const buf = await fs.readFile(target);
      const text = buf.slice(0, maxBytes).toString('utf8');
      const lines = text.split('\n');
      const start = Math.max(1, args.startLine ?? 1);
      const maxLines = Math.min(args.maxLines ?? 200, 500);
      const end = Math.min(args.endLine ?? start + maxLines - 1, start + maxLines - 1, lines.length);
      const snippet = lines.slice(start - 1, end);
      const numbered = snippet.map((line: string, idx: number) => `${start + idx}: ${line}`);
      const note = buf.length > maxBytes ? `\n[truncated at ${maxBytes} bytes]` : '';
      return numbered.join('\n') + note;
    },
  };
}
