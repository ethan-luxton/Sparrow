import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { ToolDefinition } from './registry.js';
import { baseDir } from '../config/paths.js';

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
  'true',
  'git',
  'rg',
  'grep',
  'awk',
  'jq',
  'tree',
  'fd',
  'bat',
  'find',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'realpath',
  'readlink',
  'du',
  'ps',
  'top',
  'lsblk',
  'sort',
  'uniq',
  'cut',
  'tr',
  'sed',
]);
const DISALLOWED_TOKENS = ['sudo', 'su', 'rm', 'mv', 'cp', 'chmod', 'chown', 'dd', 'mkfs', 'mount', 'tee', 'touch'];
const MAX_OUTPUT_BYTES = 12_000;
const MAX_COMMANDS = 20;
const ALLOWED_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'branch', 'rev-parse', 'show', 'ls-files', 'remote', 'blame']);

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
  return /[;&`$><]/.test(value);
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

function tokenize(input: string): string[] {
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
    if (ch === '|') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      if (input[i + 1] === '|') {
        tokens.push('||');
        i++;
      } else {
        tokens.push('|');
      }
      continue;
    }
    if (ch === '&' && input[i + 1] === '&') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      tokens.push('&&');
      i++;
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

type CmdSegment = { command: string; args: string[] };
type CmdPipeline = CmdSegment[];
type CmdChain = { type: 'single'; pipeline: CmdPipeline } | { type: 'and'; pipelines: CmdPipeline[] } | { type: 'or'; primary: CmdPipeline; fallback: CmdPipeline };

function parsePipeline(tokens: string[]) {
  if (!tokens.length) throw new Error('Empty command.');
  const segments: CmdSegment[] = [];
  let current: string[] = [];
  for (const tok of tokens) {
    if (tok === '|') {
      if (!current.length) throw new Error('Invalid pipeline.');
      const cmd = current[0]?.toLowerCase();
      if (!cmd) throw new Error('Empty command segment.');
      segments.push({ command: cmd, args: current.slice(1) });
      current = [];
      continue;
    }
    current.push(tok);
  }
  if (!current.length) throw new Error('Invalid pipeline.');
  const cmd = current[0]?.toLowerCase();
  if (!cmd) throw new Error('Empty command segment.');
  segments.push({ command: cmd, args: current.slice(1) });
  return segments;
}

function stripDevNullRedirects(cmdline: string) {
  let stdout = false;
  let stderr = false;
  let cleaned = cmdline;
  const patterns = [
    { re: /(^|\s)2>\s*\/dev\/null(\s|$)/g, type: 'stderr' },
    { re: /(^|\s)1>\s*\/dev\/null(\s|$)/g, type: 'stdout' },
    { re: /(^|\s)>\s*\/dev\/null(\s|$)/g, type: 'stdout' },
  ];
  for (const p of patterns) {
    if (p.re.test(cleaned)) {
      cleaned = cleaned.replace(p.re, ' ');
      if (p.type === 'stdout') stdout = true;
      else stderr = true;
    }
  }
  return { cleaned: cleaned.trim(), redirectStdout: stdout, redirectStderr: stderr };
}

function parseCommandChain(cmdline: string): { chain: CmdChain; redirectStdout: boolean; redirectStderr: boolean } {
  const stripped = stripDevNullRedirects(cmdline);
  const cleaned = stripped.cleaned;
  if (hasShellMeta(cleaned) || cleaned.includes(';')) {
    throw new Error('Shell operators are not allowed (only |, &&, and cmd1 || cmd2 are permitted). Use the commands array to run multiple commands.');
  }
  const tokens = tokenize(cleaned);
  if (!tokens.length) throw new Error('Empty command.');
  const hasOr = tokens.includes('||');
  const hasAnd = tokens.includes('&&');
  if (hasOr && hasAnd) throw new Error('Do not mix || with && in a single command.');
  if (hasOr) {
    const orIndices = tokens.reduce<number[]>((acc, t, idx) => {
      if (t === '||') acc.push(idx);
      return acc;
    }, []);
    if (orIndices.length > 1) throw new Error('Only one "||" fallback is allowed.');
    const idx = orIndices[0];
    const left = tokens.slice(0, idx);
    const right = tokens.slice(idx + 1);
    if (!left.length || !right.length) throw new Error('Invalid "||" usage.');
    return { chain: { type: 'or', primary: parsePipeline(left), fallback: parsePipeline(right) }, redirectStdout: stripped.redirectStdout, redirectStderr: stripped.redirectStderr };
  }
  if (hasAnd) {
    const segments: CmdPipeline[] = [];
    let current: string[] = [];
    for (const tok of tokens) {
      if (tok === '&&') {
        if (!current.length) throw new Error('Invalid "&&" usage.');
        segments.push(parsePipeline(current));
        current = [];
        continue;
      }
      current.push(tok);
    }
    if (!current.length) throw new Error('Invalid "&&" usage.');
    segments.push(parsePipeline(current));
    return { chain: { type: 'and', pipelines: segments }, redirectStdout: stripped.redirectStdout, redirectStderr: stripped.redirectStderr };
  }
  return { chain: { type: 'single', pipeline: parsePipeline(tokens) }, redirectStdout: stripped.redirectStdout, redirectStderr: stripped.redirectStderr };
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
    if (flag === '--no-pager') {
      i += 1;
      continue;
    }
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

async function execCommand(command: string, args: string[], cwd: string, input?: string, opts?: { discardStdout?: boolean; discardStderr?: boolean }) {
  const run = (cmd: string) =>
    new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
      const child = execFile(
        cmd,
        args,
        {
          cwd,
          timeout: 5000,
          maxBuffer: MAX_OUTPUT_BYTES,
        },
        (err: any, stdout: string, stderr: string) => {
          if (err && err.code === 'ENOENT') return reject(err);
          if (err && typeof err.code !== 'number') return reject(err);
          const code = typeof err?.code === 'number' ? err.code : 0;
          resolve({
            stdout: opts?.discardStdout ? '' : stdout ?? '',
            stderr: opts?.discardStderr ? '' : stderr ?? '',
            code,
          });
        }
      );
      if (input) {
        child.stdin?.write(input);
      }
      child.stdin?.end();
    });

  try {
    return await run(command);
  } catch (err: any) {
    if (command === 'git' && err?.code === 'ENOENT') {
      for (const alt of ['/usr/bin/git', '/bin/git']) {
        try {
          return await run(alt);
        } catch {
          // try next
        }
      }
    }
    throw err;
  }
}

export function cliTool(): ToolDefinition {
  return {
    name: 'cli',
    description:
      'Run a sandboxed, read-only shell. Supports multiple commands, cd, pipelines (|), &&, and one safe fallback (cmd1 || cmd2). Redirects only to /dev/null are allowed. Allowed: ls, pwd, whoami, date, uname, uptime, df, free, id, echo, true, rg, grep, awk, jq, tree, fd, bat, find, cat, head, tail, wc, stat, realpath, readlink, du, ps, top, lsblk, sort, uniq, cut, tr, sed (no -i), git (status|diff|log|branch|rev-parse|show|ls-files|remote -v).',
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
        session.lastUsed = Date.now();
        session.commandCount += 1;

        const parsed = parseCommandChain(raw);
        const runPipeline = async (pipeline: CmdPipeline, redir?: { out: boolean; err: boolean }) => {
          let input: string | undefined;
          let finalStdout = '';
          let finalStderr = '';
          for (let i = 0; i < pipeline.length; i++) {
            const seg = pipeline[i];
            ensureAllowedCommand(seg.command);
            if (seg.command === 'cd') {
              throw new Error('cd must be a standalone command.');
            }
            if (seg.command === 'pwd') {
              finalStdout = session.cwd + '\n';
              input = finalStdout;
              continue;
            }
            if (seg.command === 'sed' && seg.args.some((a) => a === '-i' || a.startsWith('-i'))) {
              throw new Error('sed -i is not allowed.');
            }
            if (
              seg.command === 'find' &&
              seg.args.some((a) => ['-exec', '-execdir', '-ok', '-okdir', '-delete'].includes(a))
            ) {
              throw new Error('find -exec/-delete is not allowed.');
            }
            let execArgs = seg.args;
            let execCwd = session.cwd;
            if (seg.command === 'git') {
              const normalized = normalizeGitArgs(seg.args, session.cwd);
              execArgs = normalized.args;
              execCwd = normalized.cwd;
            }
            const safeArgs = sanitizeArgs(execArgs, execCwd);
            const isLast = i === pipeline.length - 1;
            const { stdout, stderr, code } = await execCommand(seg.command, safeArgs, execCwd, input, {
              discardStdout: Boolean(redir?.out && isLast),
              discardStderr: Boolean(redir?.err && isLast),
            });
            finalStdout = stdout ?? '';
            finalStderr += stderr ?? '';
            if (code !== 0) {
              return { ok: false, output: `${finalStdout}${finalStderr}`.trim() };
            }
            input = stdout ?? '';
          }
          const output = `${finalStdout}${finalStderr}`.trim() || 'ok';
          return { ok: true, output };
        };

        const isSingleCd = (pipeline: CmdPipeline) => pipeline.length === 1 && pipeline[0].command === 'cd';
        const execCd = (pipeline: CmdPipeline) => {
          const target = pipeline[0]?.args[0];
          if (!target) throw new Error('cd requires a path.');
          session.cwd = resolveWithinRoots(target, [process.cwd(), baseDir], session.cwd);
          return { ok: true, output: `$ cd ${target}\n${session.cwd}` };
        };

        if (parsed.chain.type === 'single') {
          if (isSingleCd(parsed.chain.pipeline)) {
            const res = execCd(parsed.chain.pipeline);
            outputs.push(res.output);
          } else {
            const primary = await runPipeline(parsed.chain.pipeline, { out: parsed.redirectStdout, err: parsed.redirectStderr });
            outputs.push(`$ ${raw}\n${primary.output}`);
          }
        } else if (parsed.chain.type === 'or') {
          if (isSingleCd(parsed.chain.primary)) {
            try {
              const res = execCd(parsed.chain.primary);
              outputs.push(res.output);
            } catch {
              const fallback = await runPipeline(parsed.chain.fallback, { out: parsed.redirectStdout, err: parsed.redirectStderr });
              outputs.push(`$ ${raw}\n${fallback.output}`);
            }
          } else {
            const primary = await runPipeline(parsed.chain.primary, { out: parsed.redirectStdout, err: parsed.redirectStderr });
            if (!primary.ok) {
              const fallback = await runPipeline(parsed.chain.fallback, { out: parsed.redirectStdout, err: parsed.redirectStderr });
              outputs.push(`$ ${raw}\n${fallback.output}`);
            } else {
              outputs.push(`$ ${raw}\n${primary.output}`);
            }
          }
        } else {
          let lastOutput = '';
          let failed = false;
          for (const pipe of parsed.chain.pipelines) {
            if (isSingleCd(pipe)) {
              try {
                const res = execCd(pipe);
                lastOutput = res.output;
                continue;
              } catch {
                failed = true;
                break;
              }
            } else {
              const result = await runPipeline(pipe, { out: parsed.redirectStdout, err: parsed.redirectStderr });
              lastOutput = result.output;
              if (!result.ok) {
                failed = true;
                break;
              }
            }
          }
          outputs.push(`$ ${raw}\n${lastOutput}`);
          if (failed) continue;
        }
      }
      return outputs.join('\n\n');
    },
  };
}
