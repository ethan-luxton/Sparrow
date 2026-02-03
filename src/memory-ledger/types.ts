export type LedgerRole = 'user' | 'assistant' | 'tool' | 'system';

export interface LedgerChain {
  chainId: string;
  createdAt: string;
  genesisHash: string;
  headHash: string;
  headHeight: number;
}

export interface LedgerBlock {
  blockId: string;
  chainId: string;
  height: number;
  timestamp: string;
  role: LedgerRole;
  authorId?: string | null;
  content: string;
  contentHash: string;
  prevHash: string | null;
  headerHash: string;
  keywords: string[];
  tags: string[];
  references: string[];
  metadata?: Record<string, unknown> | null;
  redacted: boolean;
}

export interface LedgerBlockRow {
  block_id: string;
  chain_id: string;
  height: number;
  ts: string;
  role: string;
  author_id: string | null;
  content: string;
  content_hash: string;
  prev_hash: string | null;
  header_hash: string;
  keywords_json: string;
  tags_json: string;
  references_json: string;
  metadata_json: string | null;
  redacted: number;
}

export interface SummaryRow {
  chain_id: string;
  up_to_height: number;
  summary_text: string;
  summary_hash: string;
  ts: string;
}

export interface AppendMessageInput {
  chainId: string;
  role: LedgerRole;
  authorId?: string | null;
  content: string;
  tags?: string[];
  references?: string[];
  metadata?: Record<string, unknown> | null;
  timestamp?: string;
}

export interface MemoryCitation {
  blockId: string;
  snippet: string;
}

export interface MemoryBundle {
  citedBlocks: LedgerBlock[];
  summary?: SummaryRow | null;
  facts?: LedgerBlock[];
  citations: MemoryCitation[];
}

export interface MemoryBundleOptions {
  maxBlocks?: number;
  maxContextChars?: number;
  recentLimit?: number;
  timeWindowDays?: number;
}
