import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolDefinition } from './registry.js';
import { loadConfig } from '../config/config.js';
import { resolveWithinRoots } from '../lib/safePath.js';

const execFileAsync = promisify(execFile);

export function taskRunnerTool(): ToolDefinition {
  return {
    name: 'task_runner',
    description: 'Run predefined allowlisted tasks (opt-in). Requires confirm=true to execute.',
    permission: 'write',
    schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    handler: async (args: { taskId: string; confirm?: boolean }) => {
      const cfg = loadConfig();
      const tasks = cfg.tasks?.allowlist ?? [];
      const task = tasks.find((t) => t.id === args.taskId);
      if (!task) {
        return {
          error: `Unknown task: ${args.taskId}`,
          available: tasks.map((t) => t.id),
        };
      }
      const cwd = task.cwd ? resolveWithinRoots(task.cwd, process.cwd()) : process.cwd();
      if (args.confirm !== true) {
        return {
          wouldRun: { command: task.command, args: task.args ?? [], cwd },
          note: 'Set confirm=true to execute.',
        };
      }
      const { stdout, stderr } = await execFileAsync(task.command, task.args ?? [], { cwd, timeout: 120000, maxBuffer: 12000 });
      return {
        stdout: (stdout ?? '').trim(),
        stderr: (stderr ?? '').trim(),
      };
    },
  };
}
