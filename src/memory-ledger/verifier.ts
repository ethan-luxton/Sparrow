import type Database from 'better-sqlite3';
import { canonicalizeBlockForHash, hashContent, sha256Hex } from './hashing.js';
import type { LedgerBlock } from './types.js';

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

export function verifyChain(db: Database.Database, chainId: string) {
  const issues: string[] = [];
  const chain = db
    .prepare('SELECT chain_id, head_hash, head_height FROM chains WHERE chain_id = ?')
    .get(chainId) as { chain_id: string; head_hash: string; head_height: number } | undefined;
  if (!chain) {
    return { ok: false, issues: [`chain not found: ${chainId}`] };
  }

  const rows = db
    .prepare(
      'SELECT block_id, chain_id, height, ts, role, author_id, content, content_hash, prev_hash, header_hash, keywords_json, tags_json, references_json, metadata_json, redacted FROM blocks WHERE chain_id = ? ORDER BY height ASC'
    )
    .all(chainId) as any[];
  if (!rows.length) {
    return { ok: false, issues: [`chain has no blocks: ${chainId}`] };
  }

  let prevHash: string | null = null;
  let expectedHeight = 0;
  for (const row of rows) {
    const block = rowToBlock(row);
    if (block.height !== expectedHeight) {
      issues.push(`height mismatch blockId=${block.blockId} expected=${expectedHeight} got=${block.height}`);
      expectedHeight = block.height;
    }
    if (block.prevHash !== prevHash) {
      issues.push(`prevHash mismatch blockId=${block.blockId}`);
    }
    const contentHash = hashContent(block.content);
    if (contentHash !== block.contentHash) {
      issues.push(`contentHash mismatch blockId=${block.blockId}`);
    }
    const headerHash = sha256Hex(
      canonicalizeBlockForHash({
        chainId: block.chainId,
        height: block.height,
        timestamp: block.timestamp,
        role: block.role,
        authorId: block.authorId ?? null,
        contentHash: block.contentHash,
        prevHash: block.prevHash,
        keywords: block.keywords,
        tags: block.tags,
        references: block.references,
        metadata: block.metadata ?? null,
        redacted: block.redacted,
      })
    );
    if (headerHash !== block.headerHash) {
      issues.push(`headerHash mismatch blockId=${block.blockId}`);
    }
    prevHash = block.headerHash;
    expectedHeight += 1;
  }

  if (chain.head_hash !== prevHash) {
    issues.push(`chain head_hash mismatch chainId=${chainId}`);
  }
  if (chain.head_height !== expectedHeight - 1) {
    issues.push(`chain head_height mismatch chainId=${chainId}`);
  }

  return { ok: issues.length === 0, issues };
}

export function verifyAllChains(db: Database.Database) {
  const chains = db.prepare('SELECT chain_id FROM chains').all() as { chain_id: string }[];
  const results = chains.map((c) => ({ chainId: c.chain_id, ...verifyChain(db, c.chain_id) }));
  const ok = results.every((r) => r.ok);
  return { ok, results };
}
