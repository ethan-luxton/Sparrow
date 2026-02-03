import type Database from 'better-sqlite3';
import { MemoryRetriever } from './retriever.js';
import type { MemoryBundleOptions } from './types.js';

export class MemoryContextBuilder {
  private retriever: MemoryRetriever;

  constructor(db: Database.Database) {
    this.retriever = new MemoryRetriever(db);
  }

  build(chainId: string, userText: string, options?: MemoryBundleOptions) {
    const bundle = this.retriever.getRelevantMemoryBundle(chainId, userText, options);
    const maxChars = options?.maxContextChars ?? 2000;
    const lines: string[] = [];

    if (bundle.citedBlocks.length) {
      lines.push('Relevant prior messages (verbatim, cited):');
      for (const block of bundle.citedBlocks) {
        const header = `[${block.blockId} h=${block.height} ${block.timestamp} ${block.role}]`;
        lines.push(`${header} ${block.content}`);
      }
    }

    if (bundle.facts && bundle.facts.length) {
      lines.push('Stable facts (cited):');
      for (const block of bundle.facts) {
        lines.push(`- [${block.blockId}] ${block.content}`);
      }
    }

    if (bundle.summary) {
      lines.push(`Rolling summary (up to height ${bundle.summary.up_to_height}):`);
      lines.push(bundle.summary.summary_text);
    }

    const text = lines.join('\n');
    return text.length > maxChars ? text.slice(0, maxChars) + '\n…[truncated]' : text;
  }
}
