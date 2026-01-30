import fs from 'fs-extra';
import path from 'node:path';
import { ToolDefinition } from './registry.js';
import { loadConfig } from '../config/config.js';
import { baseDir } from '../config/paths.js';
import { extractTextFromFile, createPdfBufferFromText } from '../lib/fileText.js';

function assertWithinBase(target: string, base: string) {
  const baseResolved = path.resolve(base);
  const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(baseResolved, target);
  const rel = path.relative(baseResolved, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path ${resolved} is outside of ${baseResolved}.`);
  }
  // If the path exists, ensure realpath doesn't escape via symlinks.
  try {
    if (fs.existsSync(resolved)) {
      const realBase = fs.realpathSync(baseResolved);
      const realTarget = fs.realpathSync(resolved);
      const relReal = path.relative(realBase, realTarget);
      if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
        throw new Error(`Resolved path ${realTarget} is outside of ${realBase}.`);
      }
    }
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error('Path validation failed.');
  }
  return resolved;
}

export function filesystemTool(): ToolDefinition {
  return {
    name: 'filesystem',
    description: 'Safe local file access restricted to ~/.sparrow only.',
    permission: 'write',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write', 'list', 'read_pdf_text', 'read_docx_text', 'write_pdf'] },
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['action', 'path'],
      additionalProperties: false,
    },
    handler: async (args: { action: 'read' | 'write' | 'list' | 'read_pdf_text' | 'read_docx_text' | 'write_pdf'; path: string; content?: string }) => {
      loadConfig(); // ensures baseDir exists
      const target = assertWithinBase(args.path, baseDir);
      switch (args.action) {
        case 'read':
          return fs.readFile(target, 'utf8');
        case 'write':
          if (typeof args.content !== 'string') throw new Error('content is required for write');
          await fs.outputFile(target, args.content, 'utf8');
          return 'written';
        case 'write_pdf': {
          if (typeof args.content !== 'string') throw new Error('content is required for write_pdf');
          const buffer = await createPdfBufferFromText(args.content);
          await fs.outputFile(target, buffer);
          return 'written';
        }
        case 'list':
          return await fs.readdir(target);
        case 'read_pdf_text':
        case 'read_docx_text':
          return await extractTextFromFile(target);
        default:
          throw new Error('Unknown action');
      }
    },
  };
}
