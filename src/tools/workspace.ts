import fs from 'fs-extra';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ToolDefinition } from './registry.js';
import {
  ensureWorkspaceRoot,
  ensureProjectDir,
  resolveProjectDir,
  resolveProjectPath,
  redactWorkspaceText,
  sanitizeProjectName,
} from '../lib/workspace.js';

const MAX_READ_BYTES = 400_000;
const MAX_WRITE_BYTES = 400_000;
const MAX_RESULTS = 200;

type WorkspaceAction =
  | 'ensure_workspace'
  | 'list_projects'
  | 'ensure_project'
  | 'read_file'
  | 'write_file'
  | 'apply_patch'
  | 'list_files'
  | 'search';

interface WorkspaceArgs {
  action: WorkspaceAction;
  project?: string;
  path?: string;
  content?: string;
  glob?: string;
  maxDepth?: number;
  query?: string;
  maxResults?: number;
  diff?: string;
}

function safeListDirs(root: string) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.filter((e: Dirent) => e.isDirectory()).map((e: Dirent) => e.name).sort();
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function listFiles(root: string, maxDepth = 4, glob?: string) {
  const results: string[] = [];
  const matcher = glob ? globToRegExp(glob) : null;
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (!matcher || matcher.test(rel)) {
        results.push(rel);
        if (results.length >= MAX_RESULTS) return;
      }
    }
  };
  walk(root, 0);
  return results;
}

function runSearch(cmd: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 256_000 }, (err, stdout, stderr) => {
      if (err && (err as any).code !== 1) {
        reject(err);
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

export function workspaceTool(): ToolDefinition {
  return {
    name: 'workspace',
    description: 'Read and write files inside ~/sparrow-projects with strict sandboxing.',
    permission: 'write',
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'ensure_workspace',
            'list_projects',
            'ensure_project',
            'read_file',
            'write_file',
            'apply_patch',
            'list_files',
            'search',
          ],
        },
        project: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string' },
        glob: { type: 'string' },
        maxDepth: { type: 'number' },
        query: { type: 'string' },
        maxResults: { type: 'number' },
        diff: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: async (args: WorkspaceArgs) => {
      switch (args.action) {
        case 'ensure_workspace': {
          const root = ensureWorkspaceRoot();
          return { root };
        }
        case 'list_projects': {
          const root = ensureWorkspaceRoot();
          const projects = safeListDirs(root);
          return { root, projects };
        }
        case 'ensure_project': {
          if (!args.project) throw new Error('project is required');
          const name = sanitizeProjectName(args.project);
          const dir = ensureProjectDir(name);
          return { project: name, path: dir };
        }
        case 'read_file': {
          if (!args.project || !args.path) throw new Error('project and path are required');
          const target = resolveProjectPath(args.project, args.path);
          const stat = await fs.stat(target);
          if (stat.size > MAX_READ_BYTES) throw new Error('File too large to read.');
          const raw = await fs.readFile(target, 'utf8');
          return redactWorkspaceText(raw);
        }
        case 'write_file': {
          if (!args.project || !args.path) throw new Error('project and path are required');
          if (typeof args.content !== 'string') throw new Error('content is required');
          const bytes = Buffer.byteLength(args.content, 'utf8');
          if (bytes > MAX_WRITE_BYTES) throw new Error('Content too large to write.');
          const target = resolveProjectPath(args.project, args.path);
          await fs.outputFile(target, args.content, 'utf8');
          return { written: true, path: target };
        }
        case 'apply_patch': {
          if (!args.project || !args.diff) throw new Error('project and diff are required');
          const projectDir = resolveProjectDir(args.project);
          await new Promise<void>((resolve, reject) => {
            const child = execFile('git', ['apply', '--whitespace=nowarn', '--unsafe-paths', '-'], { cwd: projectDir }, (err) => {
              if (err) reject(err);
              else resolve();
            });
            child.stdin?.write(args.diff);
            child.stdin?.end();
          });
          return { applied: true };
        }
        case 'list_files': {
          if (!args.project) throw new Error('project is required');
          const projectDir = resolveProjectDir(args.project);
          const files = listFiles(projectDir, args.maxDepth ?? 4, args.glob);
          return { files };
        }
        case 'search': {
          if (!args.project || !args.query) throw new Error('project and query are required');
          const projectDir = resolveProjectDir(args.project);
          const maxResults = Math.min(args.maxResults ?? 50, MAX_RESULTS);
          const rgArgs = ['-n', '--hidden', '--max-count', String(maxResults), args.query, '.'];
          try {
            const { stdout } = await runSearch('rg', rgArgs, projectDir);
            return redactWorkspaceText(stdout.trim());
          } catch (err) {
            const grepArgs = ['-RIn', '--exclude-dir=.git', '--max-count', String(maxResults), args.query, '.'];
            const { stdout } = await runSearch('grep', grepArgs, projectDir);
            return redactWorkspaceText(stdout.trim());
          }
        }
        default:
          throw new Error('Unknown action');
      }
    },
  };
}
