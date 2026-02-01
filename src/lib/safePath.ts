import path from 'node:path';
import os from 'node:os';
import { baseDir } from '../config/paths.js';

export function resolveWithinRoots(target: string, baseCwd: string = process.cwd(), extraRoots: string[] = []) {
  const expanded = target.startsWith('~') ? path.join(os.homedir(), target.slice(1)) : target;
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseCwd, expanded);
  const roots = [baseCwd, baseDir, ...extraRoots].map((p) => path.resolve(p));
  for (const root of roots) {
    const rel = path.relative(root, resolved);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return resolved;
  }
  throw new Error('Path outside allowed roots.');
}
