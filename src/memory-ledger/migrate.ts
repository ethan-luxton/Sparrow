import type Database from 'better-sqlite3';
import { appendMessage, chainIdFromChatId } from './writer.js';
import { verifyChain } from './verifier.js';

export function migrateMessagesToLedger(db: Database.Database, opts?: { chatIds?: number[]; summaryEvery?: number }) {
  const chats =
    opts?.chatIds ??
    (db.prepare('SELECT DISTINCT chatId FROM messages').all() as { chatId: number }[]).map((r) => r.chatId);

  const migrated: { chatId: number; chainId: string; ok: boolean; issues: string[] }[] = [];
  for (const chatId of chats) {
    const chainId = chainIdFromChatId(chatId);
    const rows = db
      .prepare('SELECT role, content, createdAt FROM messages WHERE chatId = ? ORDER BY id ASC')
      .all(chatId) as { role: string; content: string; createdAt: string }[];
    if (!rows.length) continue;
    for (const row of rows) {
      appendMessage(
        db,
        {
          chainId,
          role: row.role as any,
          content: row.content,
          timestamp: row.createdAt,
        },
        { summaryEvery: opts?.summaryEvery }
      );
    }
    const verify = verifyChain(db, chainId);
    migrated.push({ chatId, chainId, ok: verify.ok, issues: verify.issues });
  }
  return migrated;
}
