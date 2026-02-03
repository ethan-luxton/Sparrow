import type Database from 'better-sqlite3';
import { normalizeKeywords, extractReferencedBlockIds } from './keywords.js';
import type { LedgerBlock, MemoryBundle, MemoryBundleOptions } from './types.js';
import { getLatestSummary } from './summary.js';

function parseJsonArray(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
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

function recencyScore(iso: string) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  const hours = (Date.now() - t) / 3_600_000;
  return 1 / (1 + hours / 24);
}

export class MemoryRetriever {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  getBlockById(blockId: string) {
    const row = this.db
      .prepare(
        'SELECT block_id, chain_id, height, ts, role, author_id, content, content_hash, prev_hash, header_hash, keywords_json, tags_json, references_json, metadata_json, redacted FROM blocks WHERE block_id = ?'
      )
      .get(blockId) as any;
    return row ? rowToBlock(row) : null;
  }

  getRecentBlocks(chainId: string, limit = 10): LedgerBlock[] {
    const rows = this.db
      .prepare(
        'SELECT block_id, chain_id, height, ts, role, author_id, content, content_hash, prev_hash, header_hash, keywords_json, tags_json, references_json, metadata_json, redacted FROM blocks WHERE chain_id = ? ORDER BY height DESC LIMIT ?'
      )
      .all(chainId, limit) as any[];
    return rows.reverse().map(rowToBlock);
  }

  searchByKeywords(chainId: string, keywords: string[], limit = 20, timeWindowDays?: number) {
    if (!keywords.length) return [];
    const placeholders = keywords.map(() => '?').join(',');
    const params: any[] = [chainId, ...keywords];
    let timeClause = '';
    if (timeWindowDays && timeWindowDays > 0) {
      const since = new Date(Date.now() - timeWindowDays * 24 * 60 * 60 * 1000).toISOString();
      timeClause = 'AND b.ts >= ?';
      params.push(since);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT b.block_id, b.chain_id, b.height, b.ts, b.role, b.author_id, b.content, b.content_hash, b.prev_hash, b.header_hash,
                b.keywords_json, b.tags_json, b.references_json, b.metadata_json, b.redacted,
                COUNT(*) as match_count
         FROM block_keywords bk
         JOIN blocks b ON b.block_id = bk.block_id
         WHERE bk.chain_id = ? AND bk.keyword IN (${placeholders}) ${timeClause}
         GROUP BY b.block_id
         ORDER BY match_count DESC, b.height DESC
         LIMIT ?`
      )
      .all(...params) as any[];
    return rows.map(rowToBlock);
  }

  getTaggedBlocks(chainId: string, tags: string[], limit = 10) {
    const clauses = tags.map(() => 'tags_json LIKE ?').join(' OR ');
    const params: Array<string | number> = tags.map((t) => `%"${t}"%`);
    params.unshift(chainId);
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT block_id, chain_id, height, ts, role, author_id, content, content_hash, prev_hash, header_hash, keywords_json, tags_json, references_json, metadata_json, redacted
         FROM blocks
         WHERE chain_id = ? AND (${clauses})
         ORDER BY height DESC
         LIMIT ?`
      )
      .all(...params) as any[];
    return rows.map(rowToBlock);
  }

  getRelevantMemoryBundle(chainId: string, currentUserText: string, options?: MemoryBundleOptions): MemoryBundle {
    const opts = options ?? {};
    const maxBlocks = opts.maxBlocks ?? 6;
    const recentLimit = opts.recentLimit ?? 6;
    const timeWindowDays = opts.timeWindowDays ?? 45;

    const queryKeywords = normalizeKeywords(currentUserText);
    const referenced = new Set(extractReferencedBlockIds(currentUserText));

    const candidates = new Map<string, LedgerBlock>();
    for (const block of this.searchByKeywords(chainId, queryKeywords, 30, timeWindowDays)) {
      candidates.set(block.blockId, block);
    }
    for (const block of this.getRecentBlocks(chainId, recentLimit)) {
      candidates.set(block.blockId, block);
    }
    for (const blockId of referenced) {
      const block = this.getBlockById(blockId);
      if (block) candidates.set(block.blockId, block);
    }

    const scored = Array.from(candidates.values()).map((block) => {
      const overlap = block.keywords.filter((k) => queryKeywords.includes(k)).length;
      const tagBoost = block.tags.includes('fact') || block.tags.includes('decision') ? 1.5 : 0;
      const refBoost = referenced.has(block.blockId) ? 2.5 : 0;
      const roleBoost = block.role === 'user' || block.role === 'assistant' ? 0.5 : 0;
      const score = overlap * 2 + recencyScore(block.timestamp) + tagBoost + refBoost + roleBoost;
      return { block, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const citedBlocks = scored.slice(0, maxBlocks).map((s) => s.block);
    const facts = this.getTaggedBlocks(chainId, ['fact', 'decision', 'preference'], 6);
    const summary = getLatestSummary(this.db, chainId);

    return {
      citedBlocks,
      summary,
      facts,
      citations: citedBlocks.map((b) => ({
        blockId: b.blockId,
        snippet: b.content.replace(/\s+/g, ' ').slice(0, 180),
      })),
    };
  }
}
