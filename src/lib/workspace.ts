import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { redactSensitiveText } from './redaction.js';

const DEFAULT_ROOT = path.join(os.homedir(), 'pixeltrail-projects');
const PROJECT_NAME_RE = /^[a-zA-Z0-9._-]+$/;

export function getWorkspaceRoot(): string {
  const env = process.env.PIXELTRAIL_WORKSPACE_ROOT;
  return env && env.trim().length > 0 ? env.trim() : DEFAULT_ROOT;
}

export function ensureWorkspaceRoot(): string {
  const root = getWorkspaceRoot();
  fs.ensureDirSync(root);
  return root;
}

export function sanitizeProjectName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Project name is required.');
  if (!PROJECT_NAME_RE.test(trimmed)) {
    const normalized = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!normalized || !PROJECT_NAME_RE.test(normalized)) {
      throw new Error('Invalid project name.');
    }
    return normalized;
  }
  return trimmed;
}

export function resolveProjectDir(project: string): string {
  const root = ensureWorkspaceRoot();
  const safe = sanitizeProjectName(project);
  const dir = path.join(root, safe);
  return assertWithinRoot(root, dir);
}

export function ensureProjectDir(project: string): string {
  const dir = resolveProjectDir(project);
  fs.ensureDirSync(dir);
  return dir;
}

export function assertWithinRoot(root: string, target: string): string {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(target);
  const rel = path.relative(rootResolved, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path outside workspace root.');
  }
  assertNoSymlinkEscape(rootResolved, resolved);
  return resolved;
}

function assertNoSymlinkEscape(rootResolved: string, targetResolved: string) {
  let current = rootResolved;
  const rel = path.relative(rootResolved, targetResolved);
  const parts = rel.split(path.sep).filter(Boolean);
  for (const part of parts) {
    const next = path.join(current, part);
    if (fs.existsSync(next)) {
      const stat = fs.lstatSync(next);
      if (stat.isSymbolicLink()) {
        throw new Error('Symlink escapes are not allowed in the workspace.');
      }
      const real = fs.realpathSync(next);
      const relReal = path.relative(rootResolved, real);
      if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
        throw new Error('Symlink escapes are not allowed in the workspace.');
      }
      current = real;
    } else {
      current = next;
    }
  }
}

export function resolveProjectPath(project: string, relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new Error('Absolute paths are not allowed.');
  }
  if (relPath.includes('..')) {
    throw new Error('Path traversal is not allowed.');
  }
  const projectDir = resolveProjectDir(project);
  const target = path.resolve(projectDir, relPath);
  return assertWithinRoot(projectDir, target);
}

export function redactWorkspaceText(text: string): string {
  return redactSensitiveText(text);
}

export function defaultProjectName(now = new Date()): string {
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `scratch-${year}${month}${day}`;
}

export function inferProjectName(message: string): string | null {
  const text = message.toLowerCase();
  const match =
    /project\s+(?:named|called)?\s*([a-z0-9._-]{2,})/i.exec(text) ||
    /repo\s+(?:named|called)?\s*([a-z0-9._-]{2,})/i.exec(text);
  if (match?.[1]) return sanitizeProjectName(match[1]);
  return null;
}
