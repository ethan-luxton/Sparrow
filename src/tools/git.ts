import { execFile } from 'node:child_process';
import { ToolDefinition } from './registry.js';
import { resolveProjectDir } from '../lib/workspace.js';

type GitAction =
  | 'status'
  | 'log'
  | 'diff'
  | 'show'
  | 'branch_list'
  | 'branch_create'
  | 'checkout'
  | 'switch'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'add'
  | 'commit'
  | 'stash'
  | 'restore'
  | 'reset'
  | 'merge'
  | 'rebase'
  | 'tag'
  | 'init'
  | 'config_list';

interface GitArgs {
  action: GitAction;
  project: string;
  message?: string;
  paths?: string[];
  staged?: boolean;
  maxCount?: number;
  ref?: string;
  branch?: string;
  name?: string;
  remote?: string;
  tag?: string;
  hard?: boolean;
  force?: boolean;
  confirm?: boolean;
}

const MAX_OUTPUT = 200_000;

function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: MAX_OUTPUT }, (err, stdout, stderr) => {
      const code = (err as any)?.code ?? 0;
      if (err && typeof code !== 'number') {
        reject(err);
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: code });
    });
  });
}

function summarize(stdout: string, stderr: string) {
  const text = stdout.trim() || stderr.trim();
  if (!text) return '(no output)';
  const lines = text.split('\n');
  return lines.slice(0, 6).join('\n');
}

function assertSafeFlag(flag: boolean | undefined, name: string) {
  if (flag) throw new Error(`Flag ${name} is not allowed.`);
}

export function gitTool(): ToolDefinition {
  return {
    name: 'git',
    description: 'Run allowlisted git commands inside a workspace project directory.',
    permission: 'write',
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'status',
            'log',
            'diff',
            'show',
            'branch_list',
            'branch_create',
            'checkout',
            'switch',
            'fetch',
            'pull',
            'push',
            'add',
            'commit',
            'stash',
            'restore',
            'reset',
            'merge',
            'rebase',
            'tag',
            'init',
            'config_list',
          ],
        },
        project: { type: 'string' },
        message: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
        staged: { type: 'boolean' },
        maxCount: { type: 'number' },
        ref: { type: 'string' },
        branch: { type: 'string' },
        name: { type: 'string' },
        remote: { type: 'string' },
        tag: { type: 'string' },
        hard: { type: 'boolean' },
        force: { type: 'boolean' },
        confirm: { type: 'boolean' },
      },
      required: ['action', 'project'],
      additionalProperties: false,
    },
    handler: async (args: GitArgs) => {
      const cwd = resolveProjectDir(args.project);
      assertSafeFlag(args.force, 'force');
      assertSafeFlag(args.hard, 'hard');
      const action = args.action;
      let gitArgs: string[] = [];
      switch (action) {
        case 'init':
          gitArgs = ['init', '-b', args.branch ?? 'main'];
          break;
        case 'status':
          gitArgs = ['status', '--short', '--branch'];
          break;
        case 'log':
          gitArgs = ['log', '--oneline', '--decorate', `-n`, String(args.maxCount ?? 20)];
          break;
        case 'diff':
          gitArgs = ['diff', ...(args.staged ? ['--staged'] : [])];
          break;
        case 'show':
          gitArgs = ['show', args.ref ?? 'HEAD'];
          break;
        case 'branch_list':
          gitArgs = ['branch', '--list'];
          break;
        case 'branch_create':
          if (!args.branch && !args.name) throw new Error('branch is required');
          gitArgs = ['branch', args.branch ?? args.name ?? ''];
          break;
        case 'checkout':
          if (!args.branch && !args.ref) throw new Error('branch or ref is required');
          gitArgs = ['checkout', args.branch ?? args.ref ?? ''];
          break;
        case 'switch':
          if (!args.branch) throw new Error('branch is required');
          gitArgs = ['switch', args.branch];
          break;
        case 'fetch':
          gitArgs = ['fetch', args.remote ?? '--all'];
          break;
        case 'pull':
          gitArgs = ['pull', args.remote ?? 'origin', args.branch ?? 'HEAD'];
          break;
        case 'push':
          gitArgs = ['push', args.remote ?? 'origin', args.branch ?? 'HEAD'];
          break;
        case 'add':
          gitArgs = ['add', ...(args.paths?.length ? args.paths : ['.'])];
          break;
        case 'commit':
          if (!args.message) throw new Error('message is required');
          gitArgs = ['commit', '-m', args.message];
          break;
        case 'stash':
          gitArgs = ['stash', 'push', '--include-untracked'];
          break;
        case 'restore':
          gitArgs = ['restore', ...(args.paths?.length ? args.paths : ['.'])];
          break;
        case 'reset':
          if (args.hard) throw new Error('hard reset is not allowed');
          gitArgs = ['reset', args.ref ?? 'HEAD'];
          break;
        case 'merge':
          if (!args.ref) throw new Error('ref is required');
          gitArgs = ['merge', args.ref];
          break;
        case 'rebase':
          if (!args.ref) throw new Error('ref is required');
          gitArgs = ['rebase', args.ref];
          break;
        case 'tag':
          if (!args.tag) throw new Error('tag is required');
          gitArgs = ['tag', args.tag];
          break;
        case 'config_list':
          gitArgs = ['config', '--list'];
          break;
        default:
          throw new Error('Unsupported git action');
      }
      const result = await runGit(cwd, gitArgs);
      return {
        exitCode: result.exitCode,
        summary: summarize(result.stdout, result.stderr),
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      };
    },
  };
}
