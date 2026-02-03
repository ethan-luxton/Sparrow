import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { applyLedgerMigrations } from '../schema.js';
import { appendMessage } from '../writer.js';
import { canonicalizeBlockForHash } from '../hashing.js';
import { verifyChain } from '../verifier.js';
import { MemoryRetriever } from '../retriever.js';

test('canonicalization is stable with unordered arrays', () => {
  const a = canonicalizeBlockForHash({
    chainId: 'c',
    height: 1,
    timestamp: '2025-01-01T00:00:00Z',
    role: 'user',
    authorId: null,
    contentHash: 'abc',
    prevHash: 'prev',
    keywords: ['beta', 'alpha'],
    tags: ['Decision', 'fact'],
    references: ['b2', 'a1'],
    metadata: { b: 2, a: 1 },
    redacted: false,
  });
  const b = canonicalizeBlockForHash({
    chainId: 'c',
    height: 1,
    timestamp: '2025-01-01T00:00:00Z',
    role: 'user',
    authorId: null,
    contentHash: 'abc',
    prevHash: 'prev',
    keywords: ['alpha', 'beta'],
    tags: ['fact', 'decision'],
    references: ['a1', 'b2'],
    metadata: { a: 1, b: 2 },
    redacted: false,
  });
  assert.equal(a, b);
});

test('append and verify chain', () => {
  const db = new Database(':memory:');
  applyLedgerMigrations(db);
  appendMessage(db, { chainId: 'c', role: 'user', content: 'hello' });
  appendMessage(db, { chainId: 'c', role: 'assistant', content: 'hi there' });
  const result = verifyChain(db, 'c');
  assert.equal(result.ok, true);
});

test('append-only enforcement blocks updates/deletes', () => {
  const db = new Database(':memory:');
  applyLedgerMigrations(db);
  appendMessage(db, { chainId: 'c', role: 'user', content: 'hello' });
  assert.throws(() => {
    db.prepare('UPDATE blocks SET content = ? WHERE chain_id = ?').run('tamper', 'c');
  });
  assert.throws(() => {
    db.prepare('DELETE FROM blocks WHERE chain_id = ?').run('c');
  });
});

test('tampering detection', () => {
  const db = new Database(':memory:');
  applyLedgerMigrations(db);
  appendMessage(db, { chainId: 'c', role: 'user', content: 'hello' });
  appendMessage(db, { chainId: 'c', role: 'assistant', content: 'hi there' });
  db.exec('DROP TRIGGER prevent_update_blocks');
  db.prepare('UPDATE blocks SET content = ? WHERE chain_id = ? AND height = 1').run('tampered', 'c');
  const result = verifyChain(db, 'c');
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('contentHash')));
});

test('retrieval ranking prefers keyword overlap and tags', () => {
  const db = new Database(':memory:');
  applyLedgerMigrations(db);
  appendMessage(db, { chainId: 'c', role: 'user', content: 'Plan the Q3 roadmap for Sparrow' });
  appendMessage(db, { chainId: 'c', role: 'assistant', content: 'Roadmap draft for Sparrow', tags: ['decision'] });
  appendMessage(db, { chainId: 'c', role: 'assistant', content: 'Random unrelated note about lunch' });

  const retriever = new MemoryRetriever(db);
  const bundle = retriever.getRelevantMemoryBundle('c', 'Sparrow roadmap decision');
  assert.ok(bundle.citedBlocks.length > 0);
  assert.ok(bundle.citedBlocks[0].content.toLowerCase().includes('roadmap'));
});

test('summary checkpointing', () => {
  const db = new Database(':memory:');
  applyLedgerMigrations(db);
  appendMessage(db, { chainId: 'c', role: 'user', content: 'First' }, { summaryEvery: 2 });
  appendMessage(db, { chainId: 'c', role: 'assistant', content: 'Second' }, { summaryEvery: 2 });
  const summary = db.prepare('SELECT summary_text FROM summaries WHERE chain_id = ?').get('c') as { summary_text: string } | undefined;
  assert.ok(summary?.summary_text);
});
