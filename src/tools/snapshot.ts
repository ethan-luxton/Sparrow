import os from 'node:os';
import { ToolDefinition } from './registry.js';
import { projectSummaryTool } from './projectSummary.js';

export function snapshotTool(): ToolDefinition {
  return {
    name: 'snapshot',
    description: 'Quick system + projects snapshot (OS info + git summaries).',
    permission: 'read',
    schema: {
      type: 'object',
      properties: {
        root: { type: 'string' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 6 },
      },
      additionalProperties: false,
    },
    handler: async (args: { root?: string; maxDepth?: number }) => {
      const osInfo = {
        platform: os.platform(),
        type: os.type(),
        release: os.release(),
        version: typeof os.version === 'function' ? os.version() : undefined,
        arch: os.arch(),
        cpus: os.cpus().length,
      };
      const memory = { total: os.totalmem(), free: os.freemem(), used: os.totalmem() - os.freemem() };
      const loadAvg = os.loadavg();
      const uptimeSeconds = os.uptime();
      const projects = await projectSummaryTool().handler({ root: args.root, maxDepth: args.maxDepth, includeGit: true }, 0);
      return { os: osInfo, memory, loadAvg, uptimeSeconds, projects };
    },
  };
}
