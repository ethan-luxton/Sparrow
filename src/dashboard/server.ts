import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import fs from 'fs-extra';
import Database from 'better-sqlite3';
import { logsDir, dbPath } from '../config/paths.js';
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

function truncateText(text: string, max = 400) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
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

function getStatus() {
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    nodeVersion: process.version,
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    processUptimeSeconds: Math.round(process.uptime()),
    osUptimeSeconds: Math.round(os.uptime()),
    loadAvg: os.loadavg(),
    memoryMB: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
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

const htmlCache = loadAssetText('dashboard.html');
const cssCache = loadAssetText('dashboard.css');

function htmlPage() {
  return htmlCache || '<!doctype html><html><body>Missing dashboard assets.</body></html>';
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
    const remote = req.socket.remoteAddress ?? 'unknown';
    logger.info(`dashboard.inbound remote=${remote} method=${req.method} path=${pathname}`);
    if (pathname === '/' || pathname === '/index.html') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      return sendHtml(res, htmlPage());
    }
    if (pathname === '/assets/dashboard.css') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      return sendCss(res, cssCache || '/* missing dashboard.css */');
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
          const reply = await openai.chat(chatId, message, tools);
          return sendJson(res, { reply });
        } catch (err) {
          const msg = (err as Error).message;
          logger.error(`dashboard.chat.error ${msg}`);
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
    console.log(`Sparrow dashboard running.\nLocal: ${local}${extra}`);
  });

  return server;
}
