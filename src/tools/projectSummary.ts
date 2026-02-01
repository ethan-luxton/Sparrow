import fs from 'fs-extra';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolDefinition } from './registry.js';
import { resolveWithinRoots } from '../lib/safePath.js';

const execFileAsync = promisify(execFile);

type RepoSummary = {
  path: string;
  branch?: string;
  lastCommit?: string;
  changedFiles?: number;
};

async function gitSummary(repoPath: string): Promise<RepoSummary> {
  const summary: RepoSummary = { path: repoPath };
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000, maxBuffer: 8000 });
    summary.branch = stdout.trim();
  } catch {
    return summary;
  }
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'log', '-1', '--pretty=format:%h %cd %s', '--date=short'], {
      timeout: 5000,
      maxBuffer: 8000,
    });
    summary.lastCommit = stdout.trim();
  } catch {
    // ignore
  }
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'status', '--porcelain'], { timeout: 5000, maxBuffer: 8000 });
    summary.changedFiles = stdout.trim() ? stdout.trim().split('\n').length : 0;
  } catch {
    // ignore
  }
  return summary;
}

export function projectSummaryTool(): ToolDefinition {
  return {
    name: 'project_summary',
    description: 'Summarize projects under a folder and detect git repos (branch, last commit, changed files).',
    permission: 'read',
    schema: {
      type: 'object',
      properties: {
        root: { type: 'string' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 6 },
        includeGit: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: async (args: { root?: string; maxDepth?: number; includeGit?: boolean }) => {
      const root = resolveWithinRoots(args.root ?? '~/projects', process.cwd());
      const maxDepth = Math.min(Math.max(args.maxDepth ?? 2, 1), 6);
      const includeGit = args.includeGit !== false;
      const repos: RepoSummary[] = [];
      const entries: string[] = [];

      const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
      while (queue.length) {
        const { dir, depth } = queue.shift()!;
        let dirEntries: Dirent[];
        try {
          dirEntries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        if (depth === 0) {
          entries.push(...dirEntries.filter((d) => d.isDirectory()).map((d) => d.name).sort());
        }
        const isRepo = dirEntries.some((d) => d.isDirectory() && d.name === '.git');
        if (isRepo && includeGit) {
          repos.push(await gitSummary(dir));
          continue;
        }
        if (depth >= maxDepth) continue;
        for (const ent of dirEntries) {
          if (ent.isDirectory() && !ent.name.startsWith('.')) {
            queue.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
          }
        }
      }

      return { root, entries, repos };
    },
  };
}
