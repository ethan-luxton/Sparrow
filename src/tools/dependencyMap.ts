import fs from 'fs-extra';
import path from 'node:path';
import { ToolDefinition } from './registry.js';
import { resolveWithinRoots } from '../lib/safePath.js';

export function dependencyMapTool(): ToolDefinition {
  return {
    name: 'dependency_map',
    description: 'Summarize dependencies from a package.json file.',
    permission: 'read',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args: { path: string }) => {
      const target = resolveWithinRoots(args.path, process.cwd());
      const stat = await fs.stat(target);
      const filePath = stat.isDirectory() ? path.join(target, 'package.json') : target;
      if (!fs.existsSync(filePath)) return `No package.json found at ${filePath}`;
      const data = await fs.readJSON(filePath);
      const deps = Object.keys(data.dependencies ?? {}).sort();
      const devDeps = Object.keys(data.devDependencies ?? {}).sort();
      const scripts = Object.keys(data.scripts ?? {}).sort();
      return {
        package: data.name ?? path.basename(path.dirname(filePath)),
        version: data.version ?? 'unknown',
        dependencies: deps,
        devDependencies: devDeps,
        scripts,
      };
    },
  };
}
