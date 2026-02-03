import crypto from 'node:crypto';
import type { LedgerBlock } from './types.js';

export function sha256Hex(input: string | Buffer) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function stableStringify(value: unknown): string {
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

export function canonicalizeBlockForHash(block: {
  chainId: string;
  height: number;
  timestamp: string;
  role: string;
  authorId?: string | null;
  contentHash: string;
  prevHash: string | null;
  keywords: string[];
  tags: string[];
  references: string[];
  metadata?: Record<string, unknown> | null;
  redacted: boolean;
}) {
  const keywords = [...(block.keywords ?? [])].map((k) => k.toLowerCase()).sort();
  const tags = [...(block.tags ?? [])].map((t) => t.toLowerCase()).sort();
  const references = [...(block.references ?? [])].sort();
  const payload = {
    chainId: block.chainId,
    height: block.height,
    timestamp: block.timestamp,
    role: block.role,
    authorId: block.authorId ?? null,
    contentHash: block.contentHash,
    prevHash: block.prevHash ?? null,
    keywords,
    tags,
    references,
    metadata: block.metadata ?? null,
    redacted: block.redacted ? 1 : 0,
  };
  return stableStringify(payload);
}

export function hashContent(content: string) {
  return sha256Hex(content ?? '');
}

export function hashHeader(block: Omit<LedgerBlock, 'blockId' | 'content'>) {
  return sha256Hex(canonicalizeBlockForHash(block));
}
