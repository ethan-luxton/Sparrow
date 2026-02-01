import fs from 'fs-extra';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { ToolDefinition } from './registry.js';
import { baseDir } from '../config/paths.js';
import { resolveWithinRoots } from '../lib/safePath.js';

const INDEX_PATH = path.join(baseDir, 'doc_index.json');
const EXTENSIONS = ['.md', '.txt', '.pdf', '.docx'];
const MAX_FILES = 2000;

type DocEntry = { path: string; mtimeMs: number };

async function loadIndex(): Promise<DocEntry[]> {
  if (!fs.existsSync(INDEX_PATH)) return [];
  try {
    return (await fs.readJSON(INDEX_PATH)) as DocEntry[];
  } catch {
    return [];
  }
}

async function saveIndex(entries: DocEntry[]) {
  await fs.outputJSON(INDEX_PATH, entries, { spaces: 2 });
}

export function docIndexTool(): ToolDefinition {
  return {
    name: 'doc_index',
    description: 'Index and search local docs by filename (md/txt/pdf/docx).',
    permission: 'read',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['index', 'search', 'status'] },
        path: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: async (args: { action: 'index' | 'search' | 'status'; path?: string; query?: string }) => {
      if (args.action === 'status') {
        const entries = await loadIndex();
        return { indexPath: INDEX_PATH, count: entries.length };
      }
      if (args.action === 'index') {
        const root = resolveWithinRoots(args.path ?? '.', process.cwd());
        const results: DocEntry[] = [];
        const queue: string[] = [root];
        while (queue.length && results.length < MAX_FILES) {
          const dir = queue.shift()!;
          let dirents: Dirent[];
          try {
            dirents = await fs.readdir(dir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const ent of dirents) {
            if (ent.name.startsWith('.')) continue;
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
              queue.push(full);
            } else {
              const ext = path.extname(ent.name).toLowerCase();
              if (EXTENSIONS.includes(ext)) {
                const stat = await fs.stat(full);
                results.push({ path: full, mtimeMs: stat.mtimeMs });
                if (results.length >= MAX_FILES) break;
              }
            }
          }
        }
        await saveIndex(results);
        return { indexed: results.length, indexPath: INDEX_PATH };
      }
      const query = (args.query ?? '').toLowerCase();
      if (!query) return 'query is required for search';
      const entries = await loadIndex();
      const matches = entries.filter((e) => e.path.toLowerCase().includes(query)).slice(0, 50);
      return matches;
    },
  };
}
