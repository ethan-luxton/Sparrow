import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolDefinition } from './registry.js';
import { baseDir } from '../config/paths.js';

const execFileAsync = promisify(execFile);

const ALLOWED_COMMANDS = new Set([
  'ls',
  'pwd',
  'whoami',
  'date',
  'uname',
  'uptime',
  'df',
  'free',
  'id',
  'echo',
  'cd',
  'git',
  'rg',
  'find',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'sort',
  'uniq',
  'cut',
  'tr',
  'sed',
  'grep',
]);
const DISALLOWED_TOKENS = ['sudo', 'su', 'rm', 'mv', 'cp', 'chmod', 'chown', 'dd', 'mkfs', 'mount', 'tee', 'touch'];
const MAX_OUTPUT_BYTES = 12_000;
const MAX_COMMANDS = 8;
const ALLOWED_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'branch', 'rev-parse', 'show', 'ls-files', 'remote']);

type ShellSession = {
  id: string;
  cwd: string;
  createdAt: number;
  lastUsed: number;
  commandCount: number;
};

const sessions = new Map<string, ShellSession>();

function newSessionId() {
  return crypto.randomBytes(8).toString('hex');
}

function cleanupSessions() {
  const now = Date.now();
  for (const [id, sess] of sessions.entries()) {
    if (now - sess.lastUsed > 30 * 60 * 1000) {
      sessions.delete(id);
    }
  }
}

function hasShellMeta(value: string) {
  return /[;&|`$><]/.test(value);
}

function isPathLike(arg: string) {
  return arg.startsWith('.') || arg.includes('/') || arg.startsWith('~');
}

function resolveWithinRoots(target: string, roots: string[], baseCwd: string) {
  const expanded = target.startsWith('~') ? path.join(os.homedir(), target.slice(1)) : target;
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseCwd, expanded);
  for (const root of roots) {
    const rootResolved = path.resolve(root);
    const rel = path.relative(rootResolved, resolved);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return resolved;
  }
  throw new Error('Path outside allowed roots.');
}

function sanitizeArgs(args: string[], baseCwd: string) {
  const roots = [process.cwd(), baseDir];
  return args.map((arg) => {
    if (hasShellMeta(arg)) throw new Error('Shell metacharacters are not allowed.');
    const lowered = arg.toLowerCase();
    if (DISALLOWED_TOKENS.some((token) => lowered === token || lowered.startsWith(`${token}`))) {
      throw new Error(`Argument not allowed: ${arg}`);
    }
    if (isPathLike(arg)) {
      const resolved = resolveWithinRoots(arg, roots, baseCwd);
      return resolved;
    }
    return arg;
  });
}

function splitArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        current += input[i + 1];
        i++;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (quote) throw new Error('Unclosed quote in command.');
  if (current) tokens.push(current);
  return tokens;
}

function parseCommandLine(cmdline: string) {
  if (hasShellMeta(cmdline) || cmdline.includes('&&') || cmdline.includes('||') || cmdline.includes(';')) {
    throw new Error('Shell operators are not allowed. Use the commands array to run multiple commands.');
  }
  const parts = splitArgs(cmdline);
  if (!parts.length) throw new Error('Empty command.');
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);
  return { command, args };
}

function ensureAllowedCommand(command: string) {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(`Command not allowed: ${command}`);
  }
  if (DISALLOWED_TOKENS.includes(command)) {
    throw new Error(`Command not allowed: ${command}`);
  }
}

function normalizeGitArgs(args: string[], baseCwd: string) {
  let i = 0;
  let cwd = baseCwd;
  const normalized: string[] = [];
  while (i < args.length && args[i].startsWith('-')) {
    const flag = args[i];
    if (flag === '-C') {
      const dir = args[i + 1];
      if (!dir) throw new Error('git -C requires a path.');
      cwd = resolveWithinRoots(dir, [process.cwd(), baseDir], baseCwd);
      i += 2;
      continue;
    }
    if (flag === '-c') {
      const kv = args[i + 1];
      if (!kv) throw new Error('git -c requires key=value.');
      normalized.push(flag, kv);
      i += 2;
      continue;
    }
    throw new Error(`Git option not allowed: ${flag}`);
  }
  const sub = args[i]?.toLowerCase();
  if (!sub || !ALLOWED_GIT_SUBCOMMANDS.has(sub)) {
    throw new Error('Git subcommand not allowed. Allowed: status, diff, log, branch, rev-parse, show, ls-files, remote');
  }
  normalized.push(sub, ...args.slice(i + 1));
  if (sub === 'remote' && normalized.length > 1 && normalized[1] !== '-v') {
    throw new Error('Only "git remote -v" is allowed.');
  }
  return { cwd, args: normalized };
}

export function cliTool(): ToolDefinition {
  return {
    name: 'cli',
    description:
      'Run a sandboxed, read-only shell. Supports multiple commands, cd, and git read-only operations. Allowed: ls, pwd, whoami, date, uname, uptime, df, free, id, echo, rg, find, cat, head, tail, wc, stat, sort, uniq, cut, tr, sed (no -i), grep, git (status|diff|log|branch|rev-parse|show|ls-files|remote -v).',
    permission: 'read',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'run', 'end', 'pwd'] },
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
        commands: { type: 'array', items: { type: 'string' }, maxItems: MAX_COMMANDS },
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: async (args: {
      action?: 'start' | 'run' | 'end' | 'pwd';
      sessionId?: string;
      cwd?: string;
      commands?: string[];
      command?: string;
      args?: string[];
    }) => {
      cleanupSessions();
      const action = args.action ?? 'run';
      if (action === 'start') {
        const baseCwd = resolveWithinRoots(args.cwd ?? process.cwd(), [process.cwd(), baseDir], process.cwd());
        const id = newSessionId();
        sessions.set(id, { id, cwd: baseCwd, createdAt: Date.now(), lastUsed: Date.now(), commandCount: 0 });
        return `session=${id} cwd=${baseCwd}`;
      }
      if (action === 'end') {
        if (!args.sessionId) throw new Error('sessionId is required for end');
        sessions.delete(args.sessionId);
        return `session ${args.sessionId} closed`;
      }

      const sessionId = args.sessionId;
      let session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) {
        const baseCwd = resolveWithinRoots(args.cwd ?? process.cwd(), [process.cwd(), baseDir], process.cwd());
        session = { id: sessionId ?? newSessionId(), cwd: baseCwd, createdAt: Date.now(), lastUsed: Date.now(), commandCount: 0 };
        if (sessionId) sessions.set(sessionId, session);
      }
      if (action === 'pwd') {
        return session.cwd;
      }

      const commands: string[] = [];
      if (Array.isArray(args.commands) && args.commands.length) {
        commands.push(...args.commands);
      } else if (args.command) {
        const cmd = String(args.command).trim();
        const extra = Array.isArray(args.args) ? args.args.map(String) : [];
        commands.push([cmd, ...extra].join(' ').trim());
      } else {
        throw new Error('commands or command is required');
      }
      if (commands.length > MAX_COMMANDS) {
        throw new Error(`Too many commands. Max ${MAX_COMMANDS}.`);
      }

      const outputs: string[] = [];
      for (const raw of commands) {
        if (!raw.trim()) continue;
        const { command, args: parsedArgs } = parseCommandLine(raw);
        ensureAllowedCommand(command);
        session.lastUsed = Date.now();
        session.commandCount += 1;

        if (command === 'cd') {
          const target = parsedArgs[0];
          if (!target) throw new Error('cd requires a path.');
          session.cwd = resolveWithinRoots(target, [process.cwd(), baseDir], session.cwd);
          outputs.push(`$ cd ${target}\n${session.cwd}`);
          continue;
        }
        if (command === 'pwd') {
          outputs.push(`$ pwd\n${session.cwd}`);
          continue;
        }

        if (command === 'sed' && parsedArgs.some((a) => a === '-i' || a.startsWith('-i'))) {
          throw new Error('sed -i is not allowed.');
        }

        let execArgs = parsedArgs;
        let execCwd = session.cwd;
        if (command === 'git') {
          const normalized = normalizeGitArgs(parsedArgs, session.cwd);
          execArgs = normalized.args;
          execCwd = normalized.cwd;
        }

        const safeArgs = sanitizeArgs(execArgs, execCwd);
        const { stdout, stderr } = await execFileAsync(command, safeArgs, {
          cwd: execCwd,
          timeout: 5000,
          maxBuffer: MAX_OUTPUT_BYTES,
        });
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim() || 'ok';
        outputs.push(`$ ${command} ${execArgs.join(' ')}`.trim() + `\n${output}`);
      }
      return outputs.join('\n\n');
    },
  };
}
