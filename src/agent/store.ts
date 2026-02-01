import type Database from 'better-sqlite3';
import { getDbHandle } from '../lib/db.js';
import { initLedger, recordTaskEvent } from '../memory/ledger.js';

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed';
export type TaskType = 'tool' | 'llm_summary' | 'user_update' | 'patch';

export interface AgentObjective {
  id: number;
  chatId: number;
  text: string;
  status: 'active' | 'completed' | 'canceled';
  createdAt: string;
  updatedAt: string;
}

export interface AgentTask {
  id: number;
  chatId: number;
  objectiveId: number | null;
  type: TaskType;
  payload: string;
  status: TaskStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentState {
  chatId: number;
  paused: number;
  canceled: number;
  lastNotifiedAt: string | null;
  updatedAt: string;
}

export interface EnqueueTaskInput {
  chatId: number;
  objectiveId: number | null;
  type: TaskType;
  payload: Record<string, unknown>;
}

export function initAgentStore(db: Database.Database) {
  initLedger(db);
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
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_objectives_chat ON agent_objectives(chatId, status);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_tasks_chat ON agent_tasks(chatId, status);');
}

export function getAgentState(chatId: number, db: Database.Database = getDbHandle()): AgentState {
  initAgentStore(db);
  const row = db.prepare('SELECT chatId, paused, canceled, lastNotifiedAt, updatedAt FROM agent_state WHERE chatId = ?').get(chatId) as
    | AgentState
    | undefined;
  if (row) return row;
  db.prepare('INSERT INTO agent_state (chatId, paused, canceled) VALUES (?, 0, 0)').run(chatId);
  const created = db.prepare('SELECT chatId, paused, canceled, lastNotifiedAt, updatedAt FROM agent_state WHERE chatId = ?').get(chatId) as AgentState;
  return created;
}

export function updateAgentState(chatId: number, patch: Partial<AgentState>, db: Database.Database = getDbHandle()) {
  initAgentStore(db);
  const current = getAgentState(chatId, db);
  const next = {
    paused: patch.paused ?? current.paused,
    canceled: patch.canceled ?? current.canceled,
    lastNotifiedAt: patch.lastNotifiedAt ?? current.lastNotifiedAt,
  };
  db.prepare(
    'UPDATE agent_state SET paused = ?, canceled = ?, lastNotifiedAt = ?, updatedAt = CURRENT_TIMESTAMP WHERE chatId = ?'
  ).run(next.paused, next.canceled, next.lastNotifiedAt, chatId);
}

export function setActiveObjective(chatId: number, text: string, db: Database.Database = getDbHandle()): AgentObjective {
  initAgentStore(db);
  db.prepare('UPDATE agent_objectives SET status = ?, updatedAt = CURRENT_TIMESTAMP WHERE chatId = ? AND status = ?').run(
    'completed',
    chatId,
    'active'
  );
  const info = db
    .prepare('INSERT INTO agent_objectives (chatId, text, status) VALUES (?, ?, ?)')
    .run(chatId, text, 'active');
  const id = Number(info.lastInsertRowid);
  return db
    .prepare('SELECT id, chatId, text, status, createdAt, updatedAt FROM agent_objectives WHERE id = ?')
    .get(id) as AgentObjective;
}

export function getActiveObjective(chatId: number, db: Database.Database = getDbHandle()): AgentObjective | null {
  initAgentStore(db);
  const row = db
    .prepare('SELECT id, chatId, text, status, createdAt, updatedAt FROM agent_objectives WHERE chatId = ? AND status = ? ORDER BY id DESC LIMIT 1')
    .get(chatId, 'active') as AgentObjective | undefined;
  return row ?? null;
}

export function enqueueTask(input: EnqueueTaskInput, db: Database.Database = getDbHandle()): AgentTask {
  initAgentStore(db);
  const payloadText = JSON.stringify(input.payload ?? {});
  const info = db
    .prepare('INSERT INTO agent_tasks (chatId, objectiveId, type, payload, status) VALUES (?, ?, ?, ?, ?)')
    .run(input.chatId, input.objectiveId, input.type, payloadText, 'queued');
  const id = Number(info.lastInsertRowid);
  recordTaskEvent(input.chatId, 'task_created', { taskId: id, type: input.type, payload: input.payload });
  return db
    .prepare('SELECT id, chatId, objectiveId, type, payload, status, lastError, createdAt, updatedAt FROM agent_tasks WHERE id = ?')
    .get(id) as AgentTask;
}

export function getNextTask(chatId: number, db: Database.Database = getDbHandle()): AgentTask | null {
  initAgentStore(db);
  const row = db
    .prepare('SELECT id, chatId, objectiveId, type, payload, status, lastError, createdAt, updatedAt FROM agent_tasks WHERE chatId = ? AND status = ? ORDER BY id ASC LIMIT 1')
    .get(chatId, 'queued') as AgentTask | undefined;
  return row ?? null;
}

export function markTaskStarted(taskId: number, chatId: number, db: Database.Database = getDbHandle()) {
  initAgentStore(db);
  db.prepare('UPDATE agent_tasks SET status = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?').run('running', taskId);
  recordTaskEvent(chatId, 'task_started', { taskId });
}

export function markTaskCompleted(taskId: number, chatId: number, db: Database.Database = getDbHandle()) {
  initAgentStore(db);
  db.prepare('UPDATE agent_tasks SET status = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?').run('completed', taskId);
  recordTaskEvent(chatId, 'task_completed', { taskId });
}

export function markTaskFailed(taskId: number, chatId: number, error: string, db: Database.Database = getDbHandle()) {
  initAgentStore(db);
  db.prepare('UPDATE agent_tasks SET status = ?, lastError = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?').run(
    'failed',
    error,
    taskId
  );
  recordTaskEvent(chatId, 'task_failed', { taskId, error });
}

export function listChatsWithQueuedTasks(db: Database.Database = getDbHandle()): number[] {
  initAgentStore(db);
  const rows = db.prepare('SELECT DISTINCT chatId FROM agent_tasks WHERE status = ?').all('queued') as { chatId: number }[];
  return rows.map((r) => r.chatId);
}
