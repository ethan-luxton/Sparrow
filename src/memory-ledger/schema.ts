import type Database from 'better-sqlite3';

const MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: '20260203_chat_ledger_init',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS chains (
        chain_id TEXT PRIMARY KEY,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        genesis_hash TEXT,
        head_hash TEXT,
        head_height INTEGER
      );

      CREATE TABLE IF NOT EXISTS blocks (
        block_id TEXT PRIMARY KEY,
        chain_id TEXT,
        height INTEGER,
        ts TEXT,
        role TEXT,
        author_id TEXT,
        content TEXT,
        content_hash TEXT,
        prev_hash TEXT,
        header_hash TEXT,
        keywords_json TEXT,
        tags_json TEXT,
        references_json TEXT,
        metadata_json TEXT,
        redacted INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS block_keywords (
        block_id TEXT,
        chain_id TEXT,
        keyword TEXT
      );

      CREATE TABLE IF NOT EXISTS summaries (
        chain_id TEXT,
        up_to_height INTEGER,
        summary_text TEXT,
        summary_hash TEXT,
        ts TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_blocks_chain_height ON blocks(chain_id, height);
      CREATE INDEX IF NOT EXISTS idx_blocks_chain_ts ON blocks(chain_id, ts);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_chain_header ON blocks(chain_id, header_hash);
      CREATE INDEX IF NOT EXISTS idx_block_keywords_chain_kw ON block_keywords(chain_id, keyword);
      CREATE INDEX IF NOT EXISTS idx_summaries_chain_height ON summaries(chain_id, up_to_height);

      CREATE TRIGGER IF NOT EXISTS prevent_update_blocks
      BEFORE UPDATE ON blocks
      BEGIN
        SELECT RAISE(ABORT, 'blocks are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS prevent_delete_blocks
      BEFORE DELETE ON blocks
      BEGIN
        SELECT RAISE(ABORT, 'blocks are append-only');
      END;
    `,
  },
];

export function applyLedgerMigrations(db: Database.Database) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP);');
  const appliedRows = db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[];
  const applied = new Set(appliedRows.map((r) => r.id));
  const insert = db.prepare('INSERT INTO schema_migrations (id) VALUES (?)');
  const tx = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      db.exec(migration.sql);
      insert.run(migration.id);
    }
  });
  tx();
}
