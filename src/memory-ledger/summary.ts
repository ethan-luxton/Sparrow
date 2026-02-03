import type Database from 'better-sqlite3';
import { sha256Hex } from './hashing.js';
import type { LedgerBlock, SummaryRow } from './types.js';

export function shouldCheckpointSummary(height: number, interval: number) {
  if (interval <= 0) return false;
  return height > 0 && height % interval === 0;
}

export function buildSummaryText(blocks: LedgerBlock[]) {
  const lines = blocks
    .filter((b) => b.role === 'user' || b.role === 'assistant')
    .slice(-8)
    .map((b) => `- (${b.role}) ${b.content.replace(/\s+/g, ' ').slice(0, 200)}`);
  const summary = lines.join('\n');
  return summary.length > 1200 ? summary.slice(0, 1200) + '\n…[truncated]' : summary;
}

export function writeSummary(db: Database.Database, chainId: string, upToHeight: number, summaryText: string) {
  const summaryHash = sha256Hex(summaryText);
  db.prepare(
    'INSERT INTO summaries (chain_id, up_to_height, summary_text, summary_hash, ts) VALUES (?, ?, ?, ?, ?)'
  ).run(chainId, upToHeight, summaryText, summaryHash, new Date().toISOString());
}

export function getLatestSummary(db: Database.Database, chainId: string): SummaryRow | null {
  const row = db
    .prepare('SELECT chain_id, up_to_height, summary_text, summary_hash, ts FROM summaries WHERE chain_id = ? ORDER BY up_to_height DESC LIMIT 1')
    .get(chainId) as SummaryRow | undefined;
  return row ?? null;
}
