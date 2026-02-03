import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'fs-extra';
import Database from 'better-sqlite3';
import { logsDir, dbPath, baseDir } from '../config/paths.js';
import { redactSensitiveObject, redactSensitiveText } from '../lib/redaction.js';
import { logger } from '../lib/logger.js';
import { loadConfig } from '../config/config.js';
import { buildToolRegistry } from '../tools/index.js';
import { OpenAIClient } from '../lib/openaiClient.js';
import { addMessage } from '../lib/db.js';

const DEFAULT_PORT = 5527;
const MAX_LOG_LINES = 500;
const MAX_LOG_BYTES = 500_000;
const MAX_TOOL_LOGS = 200;
const MAX_MESSAGES = 200;
const MAX_FILE_EVENTS = 200;
const MAX_DB_ROWS = 500;
const MAX_USAGE_ROWS = 24;
const MAX_UPLOAD_BYTES = 12_000_000;
const foreignIpsSeen = new Set<string>();

function normalizeRemote(remote?: string | null) {
  if (!remote) return 'unknown';
  if (remote.startsWith('::ffff:')) return remote.slice(7);
  return remote;
}

function isPrivateIPv4(ip: string) {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isLocalAddress(ip: string) {
  if (ip === 'unknown') return true;
  if (ip === '::1') return true;
  if (ip.startsWith('fe80:')) return true; // IPv6 link-local
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // IPv6 ULA
  if (ip.includes('.')) return isPrivateIPv4(ip);
  return false;
}

function logForeignRequest(req: http.IncomingMessage, pathname: string) {
  const remote = normalizeRemote(req.socket.remoteAddress ?? 'unknown');
  if (isLocalAddress(remote)) return;
  if (foreignIpsSeen.has(remote)) return;
  foreignIpsSeen.add(remote);
  const forwarded = String(req.headers['x-forwarded-for'] ?? '');
  const realIp = String(req.headers['x-real-ip'] ?? '');
  const ua = String(req.headers['user-agent'] ?? '');
  const lang = String(req.headers['accept-language'] ?? '');
  logger.warn(
    `dashboard.foreign remote=${remote} path=${pathname} forwarded=${forwarded} real=${realIp} ua=${ua} lang=${lang}`
  );
}

type DashboardOptions = {
  host?: string;
  port?: number;
};

type ToolLogRow = {
  id: number;
  chatId: number;
  tool: string;
  action: string;
  payload: string;
  result: string;
  createdAt: string;
};

type MessageRow = {
  id: number;
  chatId: number;
  role: string;
  content: string;
  createdAt: string;
};

type UsageRow = {
  tool: string;
  count: number;
};

type TokenUsageRow = {
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

type LedgerChainRow = {
  chain_id: string;
  created_at: string;
  genesis_hash: string | null;
  head_hash: string | null;
  head_height: number | null;
};

type LedgerBlockRow = {
  block_id: string;
  chain_id: string;
  height: number;
  ts: string;
  role: string;
  author_id: string | null;
  content: string | null;
  content_hash: string | null;
  prev_hash: string | null;
  header_hash: string | null;
  keywords_json: string | null;
  tags_json: string | null;
  references_json: string | null;
  metadata_json: string | null;
  redacted: number | null;
};

type LedgerKeywordRow = {
  block_id: string;
  chain_id: string;
  keyword: string;
};

type LedgerSummaryRow = {
  chain_id: string;
  up_to_height: number;
  summary_text: string;
  summary_hash: string;
  ts: string;
};

function latestLogFile(): string | null {
  if (!fs.existsSync(logsDir)) return null;
  const files = fs
    .readdirSync(logsDir)
    .filter((f: string) => f.endsWith('.log'))
    .map((f: string) => path.join(logsDir, f))
    .sort();
  return files.length ? files[files.length - 1] : null;
}

function readLogTail(lines: number) {
  const file = latestLogFile();
  if (!file || !fs.existsSync(file)) return { file: null, lines: [] as string[] };
  const raw = fs.readFileSync(file);
  const slice = raw.length > MAX_LOG_BYTES ? raw.slice(raw.length - MAX_LOG_BYTES) : raw;
  const text = slice.toString('utf8');
  const all = text.trim().split('\n');
  const tail = all.slice(-Math.min(lines, MAX_LOG_LINES));
  const redacted = tail.map((line: string) => redactSensitiveText(line));
  return { file: path.basename(file), lines: redacted };
}

function openDb(): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function safeParseJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function formatJsonText(raw: string | null) {
  if (!raw) return '';
  const parsed = safeParseJson(raw);
  if (typeof parsed === 'string') return redactSensitiveText(parsed);
  return JSON.stringify(redactSensitiveObject(parsed), null, 2);
}

function truncateText(text: string, max = 400) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function readDiskUsage(targetPath: string) {
  try {
    const raw = execFileSync('df', ['-k', targetPath]).toString().trim().split('\n')[1]?.split(/\s+/);
    if (!raw || raw.length < 5) return null;
    const total = Number(raw[1]) * 1024;
    const used = Number(raw[2]) * 1024;
    const available = Number(raw[3]) * 1024;
    const usePercent = raw[4];
    return { totalBytes: total, usedBytes: used, availableBytes: available, usePercent };
  } catch {
    return null;
  }
}

function readDirUsage(targetPath: string) {
  try {
    const raw = execFileSync('du', ['-sk', targetPath]).toString().trim().split('\n')[0]?.split(/\s+/);
    if (!raw || raw.length < 1) return null;
    const used = Number(raw[0]) * 1024;
    return Number.isFinite(used) ? used : null;
  } catch {
    return null;
  }
}

function getToolLogs(limit: number) {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db
      .prepare('SELECT id, chatId, tool, action, payload, result, createdAt FROM tool_logs ORDER BY id DESC LIMIT ?')
      .all(limit) as ToolLogRow[];
    return rows.map((row) => ({
      id: row.id,
      chatId: row.chatId,
      tool: row.tool,
      action: row.action,
      createdAt: row.createdAt,
      payload: redactSensitiveObject(safeParseJson(row.payload)),
      result: redactSensitiveObject(safeParseJson(row.result)),
    }));
  } finally {
    db.close();
  }
}

function getRecentFileWrites(limit: number) {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db
      .prepare('SELECT id, chatId, tool, action, payload, result, createdAt FROM tool_logs ORDER BY id DESC LIMIT ?')
      .all(500) as ToolLogRow[];
    const items = [];
    for (const row of rows) {
      const payload = safeParseJson(row.payload);
      const action = typeof payload === 'object' && payload ? (payload as any).action : undefined;
      let pathValue: string | null = null;
      if (row.tool === 'filesystem' && ['write', 'write_pdf', 'write_binary'].includes(action)) {
        pathValue = String((payload as any).path ?? '');
      }
      if (row.tool === 'workspace' && ['write_file', 'apply_patch'].includes(action)) {
        pathValue = String((payload as any).path ?? '(patch)');
      }
      if (!pathValue) continue;
      items.push({
        id: row.id,
        chatId: row.chatId,
        tool: row.tool,
        action,
        createdAt: row.createdAt,
        path: redactSensitiveText(pathValue),
      });
      if (items.length >= limit) break;
    }
    return items;
  } finally {
    db.close();
  }
}

function getMessages(limit: number) {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db
      .prepare('SELECT id, chatId, role, content, createdAt FROM messages ORDER BY id DESC LIMIT ?')
      .all(limit) as MessageRow[];
    return rows.map((row) => ({
      id: row.id,
      chatId: row.chatId,
      role: row.role,
      createdAt: row.createdAt,
      content: truncateText(redactSensitiveText(row.content)),
    }));
  } finally {
    db.close();
  }
}

function getMessageRows(options: {
  limit: number;
  offset: number;
  order: 'asc' | 'desc';
  chatId?: number;
  role?: string;
  search?: string;
}) {
  const db = openDb();
  if (!db) return { items: [], total: 0 };
  try {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (Number.isFinite(options.chatId)) {
      filters.push('chatId = ?');
      params.push(Number(options.chatId));
    }
    if (options.role) {
      filters.push('role = ?');
      params.push(options.role);
    }
    if (options.search) {
      filters.push('content LIKE ?');
      params.push(`%${options.search}%`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const order = options.order === 'asc' ? 'ASC' : 'DESC';
    const countRow = db.prepare(`SELECT COUNT(*) as count FROM messages ${where}`).get(...params) as
      | { count: number }
      | undefined;
    const rows = db
      .prepare(`SELECT id, chatId, role, content, createdAt FROM messages ${where} ORDER BY id ${order} LIMIT ? OFFSET ?`)
      .all(...params, options.limit, options.offset) as MessageRow[];
    return {
      total: countRow?.count ?? 0,
      items: rows.map((row) => ({
        id: row.id,
        chatId: row.chatId,
        role: row.role,
        createdAt: row.createdAt,
        content: redactSensitiveText(row.content),
      })),
    };
  } finally {
    db.close();
  }
}

function getToolLogRows(options: {
  limit: number;
  offset: number;
  order: 'asc' | 'desc';
  chatId?: number;
  tool?: string;
  action?: string;
}) {
  const db = openDb();
  if (!db) return { items: [], total: 0 };
  try {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (Number.isFinite(options.chatId)) {
      filters.push('chatId = ?');
      params.push(Number(options.chatId));
    }
    if (options.tool) {
      filters.push('tool = ?');
      params.push(options.tool);
    }
    if (options.action) {
      filters.push('action = ?');
      params.push(options.action);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const order = options.order === 'asc' ? 'ASC' : 'DESC';
    const countRow = db.prepare(`SELECT COUNT(*) as count FROM tool_logs ${where}`).get(...params) as
      | { count: number }
      | undefined;
    const rows = db
      .prepare(
        `SELECT id, chatId, tool, action, payload, result, createdAt FROM tool_logs ${where} ORDER BY id ${order} LIMIT ? OFFSET ?`
      )
      .all(...params, options.limit, options.offset) as ToolLogRow[];
    return {
      total: countRow?.count ?? 0,
      items: rows.map((row) => {
        const payload = redactSensitiveObject(safeParseJson(row.payload));
        const result = redactSensitiveObject(safeParseJson(row.result));
        return {
          id: row.id,
          chatId: row.chatId,
          tool: row.tool,
          action: row.action,
          createdAt: row.createdAt,
          payload: typeof payload === 'string' ? redactSensitiveText(payload) : JSON.stringify(payload, null, 2),
          result: typeof result === 'string' ? redactSensitiveText(result) : JSON.stringify(result, null, 2),
        };
      }),
    };
  } finally {
    db.close();
  }
}

function getToolUsage(limit: number) {
  const db = openDb();
  if (!db) return { items: [], total: 0 };
  try {
    const totalRow = db.prepare('SELECT COUNT(*) as count FROM tool_logs').get() as { count: number } | undefined;
    const rows = db
      .prepare('SELECT tool, COUNT(*) as count FROM tool_logs GROUP BY tool ORDER BY count DESC LIMIT ?')
      .all(limit) as UsageRow[];
    return {
      total: totalRow?.count ?? 0,
      items: rows.map((row) => ({ name: row.tool, count: row.count })),
    };
  } finally {
    db.close();
  }
}

const API_TOOLS = ['google_drive', 'gmail', 'google_calendar', 'weather', 'n8n', 'whisper_transcribe'];

function getApiUsage(limit: number) {
  const db = openDb();
  if (!db || API_TOOLS.length === 0) return { items: [], total: 0 };
  try {
    const placeholders = API_TOOLS.map(() => '?').join(', ');
    const totalRow = db
      .prepare(`SELECT COUNT(*) as count FROM tool_logs WHERE tool IN (${placeholders})`)
      .get(...API_TOOLS) as { count: number } | undefined;
    const rows = db
      .prepare(
        `SELECT tool, COUNT(*) as count FROM tool_logs WHERE tool IN (${placeholders}) GROUP BY tool ORDER BY count DESC LIMIT ?`
      )
      .all(...API_TOOLS, limit) as UsageRow[];
    return {
      total: totalRow?.count ?? 0,
      items: rows.map((row) => ({ name: row.tool, count: row.count })),
    };
  } finally {
    db.close();
  }
}

function getTokenUsage(limit: number) {
  const db = openDb();
  if (!db) return { items: [], totalTokens: 0 };
  try {
    const totalRow = db.prepare('SELECT SUM(totalTokens) as totalTokens FROM model_usage').get() as
      | { totalTokens: number }
      | undefined;
    const rows = db
      .prepare(
        'SELECT model, SUM(promptTokens) as promptTokens, SUM(completionTokens) as completionTokens, SUM(totalTokens) as totalTokens FROM model_usage GROUP BY model ORDER BY totalTokens DESC LIMIT ?'
      )
      .all(limit) as TokenUsageRow[];
    return {
      totalTokens: totalRow?.totalTokens ?? 0,
      items: rows.map((row) => ({
        model: row.model,
        promptTokens: row.promptTokens ?? 0,
        completionTokens: row.completionTokens ?? 0,
        totalTokens: row.totalTokens ?? 0,
      })),
    };
  } catch {
    return { items: [], totalTokens: 0 };
  } finally {
    db.close();
  }
}

function getLedgerChains(limit: number) {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db
      .prepare('SELECT chain_id, created_at, genesis_hash, head_hash, head_height FROM chains ORDER BY created_at DESC LIMIT ?')
      .all(limit) as LedgerChainRow[];
    return rows.map((row) => ({
      chainId: row.chain_id,
      createdAt: row.created_at,
      genesisHash: row.genesis_hash,
      headHash: row.head_hash,
      headHeight: row.head_height,
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function getLedgerBlocks(options: {
  limit: number;
  offset: number;
  order: 'asc' | 'desc';
  chainId?: string;
  role?: string;
  keyword?: string;
  search?: string;
}) {
  const db = openDb();
  if (!db) return { items: [], total: 0 };
  try {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    const join = options.keyword
      ? 'JOIN block_keywords bk ON bk.block_id = blocks.block_id AND bk.chain_id = blocks.chain_id'
      : '';
    if (options.chainId) {
      filters.push('blocks.chain_id = ?');
      params.push(options.chainId);
    }
    if (options.role) {
      filters.push('blocks.role = ?');
      params.push(options.role);
    }
    if (options.keyword) {
      filters.push('bk.keyword = ?');
      params.push(options.keyword);
    }
    if (options.search) {
      filters.push('blocks.content LIKE ?');
      params.push(`%${options.search}%`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const order = options.order === 'asc' ? 'ASC' : 'DESC';
    const countRow = db
      .prepare(`SELECT COUNT(DISTINCT blocks.block_id) as count FROM blocks ${join} ${where}`)
      .get(...params) as { count: number } | undefined;
    const rows = db
      .prepare(
        `SELECT DISTINCT blocks.block_id, blocks.chain_id, blocks.height, blocks.ts, blocks.role, blocks.author_id,
                blocks.content, blocks.content_hash, blocks.prev_hash, blocks.header_hash,
                blocks.keywords_json, blocks.tags_json, blocks.references_json, blocks.metadata_json, blocks.redacted
         FROM blocks ${join} ${where}
         ORDER BY blocks.ts ${order} LIMIT ? OFFSET ?`
      )
      .all(...params, options.limit, options.offset) as LedgerBlockRow[];
    return {
      total: countRow?.count ?? 0,
      items: rows.map((row) => ({
        blockId: row.block_id,
        chainId: row.chain_id,
        height: row.height,
        ts: row.ts,
        role: row.role,
        authorId: row.author_id,
        content: redactSensitiveText(row.content ?? ''),
        contentHash: row.content_hash,
        prevHash: row.prev_hash,
        headerHash: row.header_hash,
        keywords: formatJsonText(row.keywords_json),
        tags: formatJsonText(row.tags_json),
        references: formatJsonText(row.references_json),
        metadata: formatJsonText(row.metadata_json),
        redacted: row.redacted ? true : false,
      })),
    };
  } catch {
    return { items: [], total: 0 };
  } finally {
    db.close();
  }
}

function getLedgerKeywords(options: {
  limit: number;
  offset: number;
  order: 'asc' | 'desc';
  chainId?: string;
  keyword?: string;
}) {
  const db = openDb();
  if (!db) return { items: [], total: 0 };
  try {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (options.chainId) {
      filters.push('chain_id = ?');
      params.push(options.chainId);
    }
    if (options.keyword) {
      filters.push('keyword = ?');
      params.push(options.keyword);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const order = options.order === 'asc' ? 'ASC' : 'DESC';
    const countRow = db.prepare(`SELECT COUNT(*) as count FROM block_keywords ${where}`).get(...params) as
      | { count: number }
      | undefined;
    const rows = db
      .prepare(`SELECT block_id, chain_id, keyword FROM block_keywords ${where} ORDER BY keyword ${order} LIMIT ? OFFSET ?`)
      .all(...params, options.limit, options.offset) as LedgerKeywordRow[];
    return {
      total: countRow?.count ?? 0,
      items: rows.map((row) => ({
        blockId: row.block_id,
        chainId: row.chain_id,
        keyword: row.keyword,
      })),
    };
  } catch {
    return { items: [], total: 0 };
  } finally {
    db.close();
  }
}

function getLedgerSummaries(options: {
  limit: number;
  offset: number;
  order: 'asc' | 'desc';
  chainId?: string;
}) {
  const db = openDb();
  if (!db) return { items: [], total: 0 };
  try {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (options.chainId) {
      filters.push('chain_id = ?');
      params.push(options.chainId);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const order = options.order === 'asc' ? 'ASC' : 'DESC';
    const countRow = db.prepare(`SELECT COUNT(*) as count FROM summaries ${where}`).get(...params) as
      | { count: number }
      | undefined;
    const rows = db
      .prepare(
        `SELECT chain_id, up_to_height, summary_text, summary_hash, ts FROM summaries ${where} ORDER BY ts ${order} LIMIT ? OFFSET ?`
      )
      .all(...params, options.limit, options.offset) as LedgerSummaryRow[];
    return {
      total: countRow?.count ?? 0,
      items: rows.map((row) => ({
        chainId: row.chain_id,
        upToHeight: row.up_to_height,
        summaryText: redactSensitiveText(row.summary_text ?? ''),
        summaryHash: row.summary_hash,
        ts: row.ts,
      })),
    };
  } catch {
    return { items: [], total: 0 };
  } finally {
    db.close();
  }
}

function getStatus() {
  const mem = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const systemDisk = readDiskUsage(baseDir) ?? readDiskUsage('.');
  const sparrowPath = process.env.SPARROW_STORAGE_PATH ?? path.join(os.homedir(), '.pixeltrailai');
  const sparrowDisk = readDiskUsage(sparrowPath);
  const sparrowUsedBytes = fs.existsSync(sparrowPath) ? readDirUsage(sparrowPath) : null;
  const hasSparrow = Boolean(sparrowDisk) || sparrowUsedBytes !== null;
  return {
    pid: process.pid,
    nodeVersion: process.version,
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    cpuCount: os.cpus().length,
    processUptimeSeconds: Math.round(process.uptime()),
    osUptimeSeconds: Math.round(os.uptime()),
    loadAvg: os.loadavg(),
    memoryMB: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
    systemMemoryMB: {
      total: Math.round(totalMem / 1024 / 1024),
      free: Math.round(freeMem / 1024 / 1024),
      used: Math.round((totalMem - freeMem) / 1024 / 1024),
    },
    disk: systemDisk,
    sparrow: hasSparrow
      ? {
          path: sparrowPath,
          usedBytes: sparrowUsedBytes,
          totalBytes: sparrowDisk?.totalBytes ?? null,
          availableBytes: sparrowDisk?.availableBytes ?? null,
          usePercent: sparrowDisk?.usePercent ?? null,
        }
      : null,
  };
}

function listLanUrls(port: number) {
  const nets = os.networkInterfaces();
  const urls: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (!net || net.internal || net.family !== 'IPv4') continue;
      urls.push(`http://${net.address}:${port}`);
    }
  }
  return urls;
}

function sendJson(res: http.ServerResponse, data: unknown, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res: http.ServerResponse, html: string) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function sendCss(res: http.ServerResponse, css: string) {
  res.writeHead(200, {
    'Content-Type': 'text/css; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(css);
}

function sendJs(res: http.ServerResponse, js: string) {
  res.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(js);
}

function loadAssetText(filename: string) {
  const candidates = [
    path.resolve(process.cwd(), 'src', 'dashboard', 'assets', filename),
    path.resolve(process.cwd(), 'dist', 'dashboard', 'assets', filename),
    path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), 'assets', filename),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, 'utf8');
    }
  }
  return '';
}

function sanitizeFilename(name: string) {
  const base = path.basename(name || 'upload');
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'upload';
}

function decodeBase64(input: string) {
  const trimmed = input.trim();
  const match = trimmed.match(/^data:([^;]+);base64,(.+)$/i);
  if (match) {
    return { mime: match[1], data: match[2] };
  }
  return { mime: '', data: trimmed };
}

const htmlPages = new Map<string, string>([
  ['/', loadAssetText('dashboard.html')],
  ['/index.html', loadAssetText('dashboard.html')],
  ['/logs', loadAssetText('dashboard-logs.html')],
  ['/logs/', loadAssetText('dashboard-logs.html')],
  ['/tool-logs', loadAssetText('dashboard-logs.html')],
  ['/database', loadAssetText('dashboard-database.html')],
  ['/database/', loadAssetText('dashboard-database.html')],
  ['/chat', loadAssetText('dashboard-chat.html')],
  ['/chat/', loadAssetText('dashboard-chat.html')],
]);
const cssCache = loadAssetText('dashboard.css');
const jsCache = loadAssetText('dashboard.js');

function resolveHtmlPage(pathname: string) {
  return htmlPages.get(pathname) ?? '';
}

function missingPage() {
  return '<!doctype html><html><body>Missing dashboard assets.</body></html>';
}


export function startDashboard(options: DashboardOptions = {}) {
  const host = options.host ?? '0.0.0.0';
  const port = options.port ?? DEFAULT_PORT;
  const cfg = loadConfig();
  const tools = buildToolRegistry(cfg);
  const openai = new OpenAIClient(cfg);
  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url ?? '/', true);
    const pathname = parsed.pathname ?? '/';
    logForeignRequest(req, pathname);
    const html = resolveHtmlPage(pathname);
    if (html) {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      return sendHtml(res, html || missingPage());
    }
    if (pathname === '/assets/dashboard.css') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      return sendCss(res, cssCache || '/* missing dashboard.css */');
    }
    if (pathname === '/assets/dashboard.js') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      return sendJs(res, jsCache || '/* missing dashboard.js */');
    }
    if (pathname === '/api/status') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      return sendJson(res, getStatus());
    }
    if (pathname === '/api/logs') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      const lines = Math.min(Number(parsed.query.lines ?? 200), MAX_LOG_LINES);
      const data = readLogTail(lines);
      return sendJson(res, data);
    }
    if (pathname === '/api/tool-logs') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      const limit = Math.min(Number(parsed.query.limit ?? 50), MAX_TOOL_LOGS);
      return sendJson(res, { items: getToolLogs(limit) });
    }
    if (pathname === '/api/messages') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      const limit = Math.min(Number(parsed.query.limit ?? 30), MAX_MESSAGES);
      return sendJson(res, { items: getMessages(limit) });
    }
    if (pathname === '/api/files') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      const limit = Math.min(Number(parsed.query.limit ?? 30), MAX_FILE_EVENTS);
      return sendJson(res, { items: getRecentFileWrites(limit) });
    }
    if (pathname === '/api/db/messages') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      const limit = Math.min(Math.max(Number(parsed.query.limit ?? 120), 1), MAX_DB_ROWS);
      const offset = Math.max(Number(parsed.query.offset ?? 0), 0);
      const order = parsed.query.order === 'asc' ? 'asc' : 'desc';
      const chatId = Number.isFinite(Number(parsed.query.chatId)) ? Number(parsed.query.chatId) : undefined;
      const role = typeof parsed.query.role === 'string' && parsed.query.role ? String(parsed.query.role) : undefined;
      const search = typeof parsed.query.search === 'string' && parsed.query.search ? String(parsed.query.search) : undefined;
      return sendJson(res, getMessageRows({ limit, offset, order, chatId, role, search }));
    }
    if (pathname === '/api/db/tool-logs') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      const limit = Math.min(Math.max(Number(parsed.query.limit ?? 120), 1), MAX_DB_ROWS);
      const offset = Math.max(Number(parsed.query.offset ?? 0), 0);
      const order = parsed.query.order === 'asc' ? 'asc' : 'desc';
      const chatId = Number.isFinite(Number(parsed.query.chatId)) ? Number(parsed.query.chatId) : undefined;
      const tool = typeof parsed.query.tool === 'string' && parsed.query.tool ? String(parsed.query.tool) : undefined;
      const action = typeof parsed.query.action === 'string' && parsed.query.action ? String(parsed.query.action) : undefined;
      return sendJson(res, getToolLogRows({ limit, offset, order, chatId, tool, action }));
    }
    if (pathname === '/api/db/ledger-chains') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      const limit = Math.min(Math.max(Number(parsed.query.limit ?? 50), 1), MAX_DB_ROWS);
      return sendJson(res, { items: getLedgerChains(limit) });
    }
    if (pathname === '/api/db/ledger-blocks') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      const limit = Math.min(Math.max(Number(parsed.query.limit ?? 120), 1), MAX_DB_ROWS);
      const offset = Math.max(Number(parsed.query.offset ?? 0), 0);
      const order = parsed.query.order === 'asc' ? 'asc' : 'desc';
      const chainId = typeof parsed.query.chainId === 'string' && parsed.query.chainId ? String(parsed.query.chainId) : undefined;
      const role = typeof parsed.query.role === 'string' && parsed.query.role ? String(parsed.query.role) : undefined;
      const keyword = typeof parsed.query.keyword === 'string' && parsed.query.keyword ? String(parsed.query.keyword) : undefined;
      const search = typeof parsed.query.search === 'string' && parsed.query.search ? String(parsed.query.search) : undefined;
      return sendJson(res, getLedgerBlocks({ limit, offset, order, chainId, role, keyword, search }));
    }
    if (pathname === '/api/db/ledger-keywords') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      const limit = Math.min(Math.max(Number(parsed.query.limit ?? 120), 1), MAX_DB_ROWS);
      const offset = Math.max(Number(parsed.query.offset ?? 0), 0);
      const order = parsed.query.order === 'asc' ? 'asc' : 'desc';
      const chainId = typeof parsed.query.chainId === 'string' && parsed.query.chainId ? String(parsed.query.chainId) : undefined;
      const keyword = typeof parsed.query.keyword === 'string' && parsed.query.keyword ? String(parsed.query.keyword) : undefined;
      return sendJson(res, getLedgerKeywords({ limit, offset, order, chainId, keyword }));
    }
    if (pathname === '/api/db/ledger-summaries') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      const limit = Math.min(Math.max(Number(parsed.query.limit ?? 120), 1), MAX_DB_ROWS);
      const offset = Math.max(Number(parsed.query.offset ?? 0), 0);
      const order = parsed.query.order === 'asc' ? 'asc' : 'desc';
      const chainId = typeof parsed.query.chainId === 'string' && parsed.query.chainId ? String(parsed.query.chainId) : undefined;
      return sendJson(res, getLedgerSummaries({ limit, offset, order, chainId }));
    }
    if (pathname === '/api/usage') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      const limit = Math.min(Math.max(Number(parsed.query.limit ?? 8), 1), MAX_USAGE_ROWS);
      return sendJson(res, { tools: getToolUsage(limit), apis: getApiUsage(limit) });
    }
    if (pathname === '/api/tokens') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      const limit = Math.min(Math.max(Number(parsed.query.limit ?? 6), 1), MAX_USAGE_ROWS);
      return sendJson(res, getTokenUsage(limit));
    }
    if (pathname === '/api/chat') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const message = String(payload.message ?? '').trim();
          const chatId = Number.isFinite(Number(payload.chatId)) ? Number(payload.chatId) : -1;
          if (!message) return sendJson(res, { error: 'Message required.' }, 400);
          addMessage(chatId, 'user', message);
          logger.info(`dashboard.outbound target=openai chatId=${chatId} chars=${message.length}`);
          const result = await openai.chat(chatId, message, tools);
          return sendJson(res, result);
        } catch (err) {
          const msg = (err as Error).message;
          logger.error(`dashboard.chat.error ${msg}`);
          return sendJson(res, { error: msg }, 500);
        }
      });
      return;
    }
    if (pathname === '/api/chat/upload') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString('utf8');
        if (body.length > MAX_UPLOAD_BYTES * 1.4) {
          req.socket.destroy();
        }
      });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const filename = sanitizeFilename(String(payload.filename ?? 'upload'));
          const { mime, data } = decodeBase64(String(payload.data ?? ''));
          if (!data) return sendJson(res, { error: 'No data provided.' }, 400);
          const buffer = Buffer.from(data, 'base64');
          if (buffer.length > MAX_UPLOAD_BYTES) {
            return sendJson(res, { error: 'File too large.' }, 413);
          }
          const ext = path.extname(filename);
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const safeName = `${stamp}_${crypto.randomUUID()}${ext || ''}`;
          const targetDir = path.join(baseDir, 'uploads');
          await fs.ensureDir(targetDir);
          const targetPath = path.join(targetDir, safeName);
          await fs.writeFile(targetPath, buffer);
          return sendJson(res, {
            name: filename,
            mime: mime || String(payload.mime ?? ''),
            size: buffer.length,
            path: targetPath,
          });
        } catch (err) {
          const msg = (err as Error).message;
          logger.error(`dashboard.upload.error ${msg}`);
          return sendJson(res, { error: msg }, 500);
        }
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  server.listen(port, host, () => {
    const urls = listLanUrls(port);
    const local = `http://127.0.0.1:${port}`;
    const extra = urls.length ? `\nLAN: ${urls.join(' , ')}` : '';
    console.log(`PixelTrail AI dashboard running.\nLocal: ${local}${extra}`);
  });

  return server;
}
