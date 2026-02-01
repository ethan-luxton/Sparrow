import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  appendLedgerEvents,
  computeBlockHash,
  computeMerkleRoot,
  initLedger,
  sealPendingBlocks,
  sha256Hex,
  verifyLedger,
} from '../ledger.js';

test('deterministic block hashing', () => {
  const h1 = sha256Hex('alpha');
  const h2 = sha256Hex('beta');
  const root1 = computeMerkleRoot([h1, h2]);
  const root2 = computeMerkleRoot([h1, h2]);
  assert.equal(root1, root2);
  const block1 = computeBlockHash('0'.repeat(64), root1, 2);
  const block2 = computeBlockHash('0'.repeat(64), root1, 2);
  assert.equal(block1, block2);
  const root3 = computeMerkleRoot([h2, h1]);
  assert.notEqual(root1, root3);
});

test('ledger integrity detects tampering', () => {
  const db = new Database(':memory:');
  initLedger(db);
  const ids = appendLedgerEvents(
    db,
    [
      { chatId: 1, type: 'user_message', payload: { text: 'hello' }, createdAt: '2025-01-01T00:00:00Z' },
      { chatId: 1, type: 'assistant_message', payload: { text: 'hi' }, createdAt: '2025-01-01T00:00:01Z' },
    ],
    { now: '2025-01-01T00:00:00Z' }
  );
  sealPendingBlocks(db, { force: true });
  const ok = verifyLedger(db);
  assert.equal(ok.ok, true);

  db.prepare('UPDATE ledger_events SET payload = ? WHERE id = ?').run('{"text":"tampered"}', ids[0]);
  const tampered = verifyLedger(db);
  assert.equal(tampered.ok, false);
  assert.ok(tampered.issues.length > 0);
});
