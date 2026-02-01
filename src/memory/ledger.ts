import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDbHandle } from '../lib/db.js';
import { embedText } from './embeddings.js';

export type LedgerEventType =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'decision'
  | 'observation'
  | 'derived_fact'
  | 'task_created'
  | 'task_started'
  | 'task_completed'
  | 'task_failed';
export type MemoryKind = 'summary' | 'fact' | 'preference';

export interface LedgerEventInput {
  chatId?: number;
  type: LedgerEventType;
  payload: unknown;
  createdAt?: string;
}

export interface LedgerEventRow {
  id: number;
  chatId: number | null;
  type: LedgerEventType;
  payload: string;
  eventHash: string;
  blockId: number | null;
  blockIndex: number | null;
  createdAt: string;
}

export interface LedgerBlockRow {
  id: number;
  prevHash: string;
  merkleRoot: string;
  blockHash: string;
  eventCount: number;
  createdAt: string;
}

export interface MemoryItemInput {
  chatId: number;
  kind: MemoryKind;
  text: string;
  eventId: number;
  embedding?: number[];
  project?: string | null;
}

export interface RetrievedMemory {
  id: number;
  kind: MemoryKind;
  text: string;
  score: number;
  citation: { blockId: number; eventId: number };
}

export const LEDGER_BLOCK_SIZE = 25;
export const GENESIS_HASH = '0'.repeat(64);

export function initLedger(db: Database.Database) {
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
      project TEXT,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    );`);
  db.exec(`CREATE TABLE IF NOT EXISTS working_state (
      chatId INTEGER PRIMARY KEY,
      state TEXT,
      updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
    );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ledger_events_block ON ledger_events(blockId, blockIndex);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_items_chat ON memory_items(chatId);');
  try {
    db.exec('ALTER TABLE memory_items ADD COLUMN project TEXT;');
  } catch {
    // ignore if column exists
  }
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  const body = entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',');
  return `{${body}}`;
}

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function computeEventHash(input: { chatId?: number; type: LedgerEventType; payloadText: string; createdAt: string }) {
  const normalized = {
    chatId: input.chatId ?? null,
    type: input.type,
    payload: input.payloadText,
    createdAt: input.createdAt,
  };
  return sha256Hex(stableStringify(normalized));
}

export function computeMerkleRoot(hashes: string[]): string {
  if (hashes.length === 0) return sha256Hex('');
  let level: Uint8Array[] = hashes.map((h) => Buffer.from(h, 'hex'));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? level[i];
      next.push(Buffer.from(sha256Hex(Buffer.concat([left, right])), 'hex'));
    }
    level = next;
  }
  return Buffer.from(level[0]).toString('hex');
}

export function computeBlockHash(prevHash: string, merkleRoot: string, eventCount: number): string {
  return sha256Hex(`${prevHash}|${merkleRoot}|${eventCount}`);
}

export function appendLedgerEvents(
  db: Database.Database,
  events: LedgerEventInput[],
  opts?: { now?: string }
): number[] {
  initLedger(db);
  const stmt = db.prepare('INSERT INTO ledger_events (chatId, type, payload, eventHash, createdAt) VALUES (?, ?, ?, ?, ?)');
  const ids: number[] = [];
  for (const event of events) {
    const createdAt = event.createdAt ?? opts?.now ?? new Date().toISOString();
    const payloadText = stableStringify(event.payload);
    const eventHash = computeEventHash({ chatId: event.chatId, type: event.type, payloadText, createdAt });
    const info = stmt.run(event.chatId ?? null, event.type, payloadText, eventHash, createdAt);
    ids.push(Number(info.lastInsertRowid));
  }
  return ids;
}

export function appendLedgerEvent(db: Database.Database, event: LedgerEventInput, opts?: { now?: string }): number {
  return appendLedgerEvents(db, [event], opts)[0]!;
}

export function sealPendingBlocks(
  db: Database.Database,
  opts?: { maxEventsPerBlock?: number; force?: boolean }
): LedgerBlockRow[] {
  initLedger(db);
  const maxEvents = opts?.maxEventsPerBlock ?? LEDGER_BLOCK_SIZE;
  const force = opts?.force ?? false;
  const blocks: LedgerBlockRow[] = [];
  while (true) {
    const pending = db
      .prepare(
        'SELECT id, eventHash FROM ledger_events WHERE blockId IS NULL ORDER BY id ASC LIMIT ?'
      )
      .all(maxEvents) as { id: number; eventHash: string }[];
    if (pending.length === 0) break;
    if (!force && pending.length < maxEvents) break;

    const merkleRoot = computeMerkleRoot(pending.map((p) => p.eventHash));
    const prev = db.prepare('SELECT blockHash FROM ledger_blocks ORDER BY id DESC LIMIT 1').get() as
      | { blockHash: string }
      | undefined;
    const prevHash = prev?.blockHash ?? GENESIS_HASH;
    const blockHash = computeBlockHash(prevHash, merkleRoot, pending.length);
    const info = db
      .prepare('INSERT INTO ledger_blocks (prevHash, merkleRoot, blockHash, eventCount) VALUES (?, ?, ?, ?)')
      .run(prevHash, merkleRoot, blockHash, pending.length);
    const blockId = Number(info.lastInsertRowid);
    const update = db.prepare('UPDATE ledger_events SET blockId = ?, blockIndex = ? WHERE id = ?');
    pending.forEach((row, idx) => update.run(blockId, idx, row.id));
    blocks.push({
      id: blockId,
      prevHash,
      merkleRoot,
      blockHash,
      eventCount: pending.length,
      createdAt: new Date().toISOString(),
    });
    if (!force) break;
  }
  return blocks;
}

function redactSecrets(text: string) {
  return text
    .replace(/sk-[a-z0-9]{16,}/gi, 'sk-REDACTED')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/(\"?(apiKey|token|secret|password)\"?\s*:\s*\")([^\"]+)(\")/gi, '$1***$4')
    .replace(/\b([A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=([^\s]+)/g, '$1=***');
}

export function redactValue(value: unknown, maxLen = 800): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = redactSecrets(text);
  if (text.length > maxLen) text = text.slice(0, maxLen) + '…';
  return text;
}

export function recordToolCall(chatId: number, tool: string, action: string | undefined, payload: unknown) {
  const db = getDbHandle();
  return appendLedgerEvent(db, {
    chatId,
    type: 'tool_call',
    payload: { tool, action: action ?? null, payload: redactValue(payload) },
  });
}

export function recordToolResult(chatId: number, tool: string, action: string | undefined, result: unknown) {
  const db = getDbHandle();
  return appendLedgerEvent(db, {
    chatId,
    type: 'tool_result',
    payload: { tool, action: action ?? null, result: redactValue(result) },
  });
}

export function recordUserMessage(chatId: number, text: string) {
  const db = getDbHandle();
  return appendLedgerEvent(db, { chatId, type: 'user_message', payload: { text } });
}

export function recordAssistantMessage(chatId: number, text: string) {
  const db = getDbHandle();
  return appendLedgerEvent(db, { chatId, type: 'assistant_message', payload: { text } });
}

export function recordDecision(chatId: number, rationale: string) {
  const db = getDbHandle();
  return appendLedgerEvent(db, { chatId, type: 'decision', payload: { rationale } });
}

export function recordObservation(chatId: number, text: string, source?: { tool?: string; taskId?: number }) {
  const db = getDbHandle();
  return appendLedgerEvent(db, {
    chatId,
    type: 'observation',
    payload: { text, source: source ?? null },
  });
}

export function recordDerivedFact(chatId: number, text: string, sourceEventId?: number) {
  const db = getDbHandle();
  return appendLedgerEvent(db, {
    chatId,
    type: 'derived_fact',
    payload: { text, sourceEventId: sourceEventId ?? null },
  });
}

export function recordTaskEvent(chatId: number, type: 'task_created' | 'task_started' | 'task_completed' | 'task_failed', payload: unknown) {
  const db = getDbHandle();
  return appendLedgerEvent(db, { chatId, type, payload });
}

export function addMemoryItem(db: Database.Database, input: MemoryItemInput): number {
  initLedger(db);
  const embedding = input.embedding ?? embedText(input.text);
  const info = db
    .prepare('INSERT INTO memory_items (chatId, kind, text, embedding, eventId, project) VALUES (?, ?, ?, ?, ?, ?)')
    .run(input.chatId, input.kind, input.text, JSON.stringify(embedding), input.eventId, input.project ?? null);
  return Number(info.lastInsertRowid);
}

function cosineSimilarity(a: number[], b: number[]) {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function searchMemory(
  db: Database.Database,
  chatId: number,
  query: string,
  limit = 5,
  scanLimit = 200,
  project?: string
): RetrievedMemory[] {
  initLedger(db);
  const queryEmbedding = embedText(query);
  const rows = db
    .prepare(
      `SELECT mi.id, mi.kind, mi.text, mi.embedding, mi.eventId, le.blockId
       FROM memory_items mi
       LEFT JOIN ledger_events le ON mi.eventId = le.id
       WHERE mi.chatId = ?
       ORDER BY mi.id DESC
       LIMIT ?`
    )
    .all(chatId, scanLimit) as {
    id: number;
    kind: MemoryKind;
    text: string;
    embedding: string;
    eventId: number;
    blockId: number | null;
  }[];

  const scored: RetrievedMemory[] = [];
  for (const row of rows) {
    if (!row.blockId) continue;
    let vec: number[] | null = null;
    try {
      const parsed = JSON.parse(row.embedding);
      if (Array.isArray(parsed)) vec = parsed.map((v) => Number(v));
    } catch {
      vec = null;
    }
    if (!vec) continue;
    const score = cosineSimilarity(queryEmbedding, vec);
    scored.push({
      id: row.id,
      kind: row.kind,
      text: row.text,
      score,
      citation: { blockId: row.blockId, eventId: row.eventId },
    });
  }
  if (project) {
    const projectRows = db
      .prepare(
        `SELECT mi.id, mi.kind, mi.text, mi.embedding, mi.eventId, le.blockId
         FROM memory_items mi
         LEFT JOIN ledger_events le ON mi.eventId = le.id
         WHERE mi.chatId = ? AND mi.project = ?
         ORDER BY mi.id DESC
         LIMIT ?`
      )
      .all(chatId, project, scanLimit) as {
      id: number;
      kind: MemoryKind;
      text: string;
      embedding: string;
      eventId: number;
      blockId: number | null;
    }[];
    const projectScored: RetrievedMemory[] = [];
    for (const row of projectRows) {
      if (!row.blockId) continue;
      let vec: number[] | null = null;
      try {
        const parsed = JSON.parse(row.embedding);
        if (Array.isArray(parsed)) vec = parsed.map((v) => Number(v));
      } catch {
        vec = null;
      }
      if (!vec) continue;
      const score = cosineSimilarity(queryEmbedding, vec);
      projectScored.push({
        id: row.id,
        kind: row.kind,
        text: row.text,
        score,
        citation: { blockId: row.blockId, eventId: row.eventId },
      });
    }
    const combined = [...projectScored, ...scored];
    return combined.sort((a, b) => b.score - a.score).slice(0, limit);
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function getRecentEvents(db: Database.Database, chatId: number, limit = 20): LedgerEventRow[] {
  initLedger(db);
  const rows = db
    .prepare('SELECT id, chatId, type, payload, eventHash, blockId, blockIndex, createdAt FROM ledger_events WHERE chatId = ? ORDER BY id DESC LIMIT ?')
    .all(chatId, limit) as LedgerEventRow[];
  return rows.reverse();
}

export function verifyLedger(db: Database.Database): { ok: boolean; issues: string[] } {
  initLedger(db);
  const issues: string[] = [];
  const events = db
    .prepare('SELECT id, chatId, type, payload, eventHash, blockId, blockIndex, createdAt FROM ledger_events')
    .all() as LedgerEventRow[];
  for (const e of events) {
    const expected = computeEventHash({ chatId: e.chatId ?? undefined, type: e.type, payloadText: e.payload, createdAt: e.createdAt });
    if (expected !== e.eventHash) {
      issues.push(`eventHash mismatch eventId=${e.id}`);
    }
  }
  const blocks = db.prepare('SELECT id, prevHash, merkleRoot, blockHash, eventCount, createdAt FROM ledger_blocks ORDER BY id ASC').all() as LedgerBlockRow[];
  let prevHash = GENESIS_HASH;
  for (const block of blocks) {
    if (block.prevHash !== prevHash) {
      issues.push(`block prevHash mismatch blockId=${block.id}`);
    }
    const blockEvents = db
      .prepare(
        'SELECT eventHash FROM ledger_events WHERE blockId = ? ORDER BY blockIndex ASC'
      )
      .all(block.id) as { eventHash: string }[];
    const merkleRoot = computeMerkleRoot(blockEvents.map((e) => e.eventHash));
    if (merkleRoot !== block.merkleRoot) {
      issues.push(`merkleRoot mismatch blockId=${block.id}`);
    }
    const blockHash = computeBlockHash(block.prevHash, block.merkleRoot, block.eventCount);
    if (blockHash !== block.blockHash) {
      issues.push(`blockHash mismatch blockId=${block.id}`);
    }
    if (block.eventCount !== blockEvents.length) {
      issues.push(`eventCount mismatch blockId=${block.id}`);
    }
    prevHash = block.blockHash;
  }
  return { ok: issues.length === 0, issues };
}
