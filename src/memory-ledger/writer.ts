import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { applyLedgerMigrations } from './schema.js';
import { normalizeKeywords } from './keywords.js';
import { canonicalizeBlockForHash, hashContent, sha256Hex, stableStringify } from './hashing.js';
import type { AppendMessageInput, LedgerBlock } from './types.js';
import { hasSensitiveIndicators, redactSensitiveText } from '../lib/redaction.js';
import { buildSummaryText, shouldCheckpointSummary, writeSummary } from './summary.js';

export function chainIdFromChatId(chatId: number) {
  return `chat:${chatId}`;
}

function toJson(value: unknown) {
  return stableStringify(value ?? null);
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

function rowToBlock(row: any): LedgerBlock {
  return {
    blockId: row.block_id,
    chainId: row.chain_id,
    height: row.height,
    timestamp: row.ts,
    role: row.role,
    authorId: row.author_id,
    content: row.content,
    contentHash: row.content_hash,
    prevHash: row.prev_hash,
    headerHash: row.header_hash,
    keywords: parseJsonArray(row.keywords_json),
    tags: parseJsonArray(row.tags_json),
    references: parseJsonArray(row.references_json),
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
    redacted: Boolean(row.redacted),
  };
}

function ensureChain(db: Database.Database, chainId: string) {
  const existing = db
    .prepare('SELECT chain_id, head_hash, head_height FROM chains WHERE chain_id = ?')
    .get(chainId) as { chain_id: string; head_hash: string; head_height: number } | undefined;
  if (existing) return existing;

  const now = new Date().toISOString();
  const blockId = crypto.randomUUID();
  const content = 'GENESIS';
  const contentHash = hashContent(content);
  const keywords = ['genesis'];
  const tags = ['genesis'];
  const references: string[] = [];
  const metadata = { note: 'genesis' };
  const headerHash = sha256Hex(
    canonicalizeBlockForHash({
      chainId,
      height: 0,
      timestamp: now,
      role: 'system',
      authorId: null,
      contentHash,
      prevHash: null,
      keywords,
      tags,
      references,
      metadata,
      redacted: false,
    })
  );

  db.prepare(
    `INSERT INTO blocks
      (block_id, chain_id, height, ts, role, author_id, content, content_hash, prev_hash, header_hash, keywords_json, tags_json, references_json, metadata_json, redacted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    blockId,
    chainId,
    0,
    now,
    'system',
    null,
    content,
    contentHash,
    null,
    headerHash,
    JSON.stringify(keywords),
    JSON.stringify(tags),
    JSON.stringify(references),
    JSON.stringify(metadata),
    0
  );

  keywords.forEach((k) => {
    db.prepare('INSERT INTO block_keywords (block_id, chain_id, keyword) VALUES (?, ?, ?)').run(blockId, chainId, k);
  });

  db.prepare(
    'INSERT INTO chains (chain_id, created_at, genesis_hash, head_hash, head_height) VALUES (?, ?, ?, ?, ?)'
  ).run(chainId, now, headerHash, headerHash, 0);

  return { chain_id: chainId, head_hash: headerHash, head_height: 0 };
}

export function appendMessage(
  db: Database.Database,
  input: AppendMessageInput,
  opts?: { summaryEvery?: number }
) {
  applyLedgerMigrations(db);
  const summaryEvery = opts?.summaryEvery ?? 25;

  const tx = db.transaction(() => {
    const chain = ensureChain(db, input.chainId);
    const now = input.timestamp ?? new Date().toISOString();
    const raw = input.content ?? '';
    const redacted = hasSensitiveIndicators(raw);
    const content = redacted ? redactSensitiveText(raw) : raw;
    const keywords = normalizeKeywords(content);
    const tags = (input.tags ?? []).map((t) => t.toLowerCase());
    const references = (input.references ?? []).map((r) => r.toLowerCase());
    const metadata = input.metadata ?? null;
    const contentHash = hashContent(content);
    const prevHash = chain.head_hash ?? null;
    const height = Number(chain.head_height ?? 0) + 1;
    const headerHash = sha256Hex(
      canonicalizeBlockForHash({
        chainId: input.chainId,
        height,
        timestamp: now,
        role: input.role,
        authorId: input.authorId ?? null,
        contentHash,
        prevHash,
        keywords,
        tags,
        references,
        metadata,
        redacted,
      })
    );
    const blockId = crypto.randomUUID();

    db.prepare(
      `INSERT INTO blocks
        (block_id, chain_id, height, ts, role, author_id, content, content_hash, prev_hash, header_hash, keywords_json, tags_json, references_json, metadata_json, redacted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      blockId,
      input.chainId,
      height,
      now,
      input.role,
      input.authorId ?? null,
      content,
      contentHash,
      prevHash,
      headerHash,
      JSON.stringify(keywords),
      JSON.stringify(tags),
      JSON.stringify(references),
      toJson(metadata),
      redacted ? 1 : 0
    );

    if (keywords.length) {
      const insertKeyword = db.prepare('INSERT INTO block_keywords (block_id, chain_id, keyword) VALUES (?, ?, ?)');
      for (const kw of new Set(keywords)) {
        insertKeyword.run(blockId, input.chainId, kw);
      }
    }

    db.prepare('UPDATE chains SET head_hash = ?, head_height = ? WHERE chain_id = ?').run(
      headerHash,
      height,
      input.chainId
    );

    if (shouldCheckpointSummary(height, summaryEvery)) {
      const rows = db
        .prepare(
          'SELECT block_id, chain_id, height, ts, role, author_id, content, content_hash, prev_hash, header_hash, keywords_json, tags_json, references_json, metadata_json, redacted FROM blocks WHERE chain_id = ? ORDER BY height ASC LIMIT ?'
        )
        .all(input.chainId, height) as any[];
      const blocks = rows.map((row) => rowToBlock(row));
      const summaryText = buildSummaryText(blocks);
      writeSummary(db, input.chainId, height, summaryText);
    }

    return { blockId, height, headerHash };
  });

  return tx();
}
