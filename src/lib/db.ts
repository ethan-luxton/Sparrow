import Database from 'better-sqlite3';
import fs from 'fs-extra';
import { dbPath } from '../config/paths.js';

let db: Database.Database | null = null;

export interface StoredMessage {
  id: number;
  chatId: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: string;
}

export interface Note {
  id: number;
  chatId: number;
  title: string;
  content: string;
  createdAt: string;
}

function ensureDb() {
  fs.ensureFileSync(dbPath);
  if (!db) {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId INTEGER UNIQUE,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId INTEGER,
      role TEXT,
      content TEXT,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS tool_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId INTEGER,
      tool TEXT,
      action TEXT,
      payload TEXT,
      result TEXT,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS checkins (
      chatId INTEGER PRIMARY KEY,
      lastCheckin TEXT
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId INTEGER,
      title TEXT,
      content TEXT,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS user_profiles (
      chatId INTEGER PRIMARY KEY,
      content TEXT,
      updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS ledger_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId INTEGER,
      type TEXT,
      payload TEXT,
      eventHash TEXT,
      blockId INTEGER,
      blockIndex INTEGER,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS ledger_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prevHash TEXT,
      merkleRoot TEXT,
      blockHash TEXT,
      eventCount INTEGER,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS memory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId INTEGER,
      kind TEXT,
      text TEXT,
      embedding TEXT,
      eventId INTEGER,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS working_state (
      chatId INTEGER PRIMARY KEY,
      state TEXT,
      updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS agent_objectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId INTEGER,
      text TEXT,
      status TEXT,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS agent_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId INTEGER,
      objectiveId INTEGER,
      type TEXT,
      payload TEXT,
      status TEXT,
      lastError TEXT,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS agent_state (
      chatId INTEGER PRIMARY KEY,
      paused INTEGER DEFAULT 0,
      canceled INTEGER DEFAULT 0,
      lastNotifiedAt TEXT,
      updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS model_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId INTEGER,
      model TEXT,
      promptTokens INTEGER,
      completionTokens INTEGER,
      totalTokens INTEGER,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    );`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_objectives_chat ON agent_objectives(chatId, status);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_tasks_chat ON agent_tasks(chatId, status);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ledger_events_block ON ledger_events(blockId, blockIndex);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_memory_items_chat ON memory_items(chatId);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_model_usage_created ON model_usage(createdAt);');
  }
  return db;
}

export function addMessage(chatId: number, role: StoredMessage['role'], content: string) {
  const database = ensureDb();
  database.prepare('INSERT OR IGNORE INTO chats (chatId) VALUES (?)').run(chatId);
  database.prepare('INSERT INTO messages (chatId, role, content) VALUES (?, ?, ?)').run(chatId, role, content);
}

export function getMessages(chatId: number, limit = 10): StoredMessage[] {
  const database = ensureDb();
  const rows = database
    .prepare('SELECT id, chatId, role, content, createdAt FROM messages WHERE chatId = ? ORDER BY id DESC LIMIT ?')
    .all(chatId, limit) as StoredMessage[];
  return rows.reverse();
}

export function clearChat(chatId: number) {
  const database = ensureDb();
  database.prepare('DELETE FROM messages WHERE chatId = ?').run(chatId);
}

export function logTool(chatId: number, tool: string, action: string, payload: unknown, result: unknown) {
  const database = ensureDb();
  database
    .prepare('INSERT INTO tool_logs (chatId, tool, action, payload, result) VALUES (?, ?, ?, ?, ?)')
    .run(chatId, tool, action, JSON.stringify(payload), JSON.stringify(result));
}

export function recordModelUsage(
  chatId: number,
  model: string,
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
) {
  const database = ensureDb();
  database
    .prepare(
      'INSERT INTO model_usage (chatId, model, promptTokens, completionTokens, totalTokens) VALUES (?, ?, ?, ?, ?)'
    )
    .run(
      chatId,
      model,
      Number.isFinite(usage.promptTokens) ? usage.promptTokens : null,
      Number.isFinite(usage.completionTokens) ? usage.completionTokens : null,
      Number.isFinite(usage.totalTokens) ? usage.totalTokens : null
    );
}

export function listChats(): number[] {
  const database = ensureDb();
  const rows = database.prepare('SELECT chatId FROM chats').all() as { chatId: number }[];
  return rows.map((r) => r.chatId);
}

export function getLastMessageTimestamp(chatId: number): string | null {
  const database = ensureDb();
  const row = database
    .prepare('SELECT createdAt FROM messages WHERE chatId = ? ORDER BY id DESC LIMIT 1')
    .get(chatId) as { createdAt: string } | undefined;
  return row?.createdAt ?? null;
}

export function getLastCheckin(chatId: number): string | null {
  const database = ensureDb();
  const row = database.prepare('SELECT lastCheckin FROM checkins WHERE chatId = ?').get(chatId) as
    | { lastCheckin: string }
    | undefined;
  return row?.lastCheckin ?? null;
}

export function setLastCheckin(chatId: number, iso: string) {
  const database = ensureDb();
  database.prepare('INSERT INTO checkins (chatId, lastCheckin) VALUES (?, ?) ON CONFLICT(chatId) DO UPDATE SET lastCheckin=excluded.lastCheckin').run(chatId, iso);
}

export function addNote(chatId: number, title: string, content: string) {
  const database = ensureDb();
  database.prepare('INSERT INTO notes (chatId, title, content) VALUES (?, ?, ?)').run(chatId, title, content);
}

export function listNotes(chatId: number, limit = 20): Note[] {
  const database = ensureDb();
  const rows = database
    .prepare('SELECT id, chatId, title, content, createdAt FROM notes WHERE chatId = ? ORDER BY id DESC LIMIT ?')
    .all(chatId, limit) as Note[];
  return rows;
}

export function getUserProfile(chatId: number): string | null {
  const database = ensureDb();
  const row = database.prepare('SELECT content FROM user_profiles WHERE chatId = ?').get(chatId) as
    | { content: string }
    | undefined;
  return row?.content ?? null;
}

export function setUserProfile(chatId: number, content: string) {
  const database = ensureDb();
  database
    .prepare(
      'INSERT INTO user_profiles (chatId, content, updatedAt) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(chatId) DO UPDATE SET content=excluded.content, updatedAt=CURRENT_TIMESTAMP'
    )
    .run(chatId, content);
}

export function getDbHandle() {
  return ensureDb();
}
