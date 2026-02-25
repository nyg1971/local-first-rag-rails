import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const Database = require('better-sqlite3');

// better-sqlite3 の最低限の型定義（store.ts と共通）
interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  pragma(sql: string): unknown;
  close(): void;
}
interface Statement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(...args: any[]): void;
}

export type DeleteReason = 'file_deleted' | 'file_changed';

export interface ArchivedChunkRow {
  id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  type: string;
  class_name: string | null;
  method_name: string | null;
  content: string;
  doc_comment: string | null;
  access_modifier: string | null;
  called_methods: string | null;
  git_hash: string | null;      // 削除・変更時の最終コミットハッシュ
  git_message: string | null;   // 削除・変更時の最終コミットメッセージ
}

/**
 * 削除・変更されたチャンクを退避するアーカイブDB。
 * メインDBとは別ファイル（index.archive.db）に保存し、
 * 検索精度に影響を与えずに過去の実装の痕跡を保持する。
 */
export class ArchiveStore {
  private db: Db;

  constructor(archivePath: string) {
    mkdirSync(dirname(archivePath), { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    this.db = new Database(archivePath) as Db;
    this.db.pragma('journal_mode = WAL');
    this._createTables();
  }

  private _createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS archived_chunks (
        id              TEXT NOT NULL,
        file_path       TEXT NOT NULL,
        start_line      INTEGER NOT NULL,
        end_line        INTEGER NOT NULL,
        type            TEXT NOT NULL,
        class_name      TEXT,
        method_name     TEXT,
        content         TEXT NOT NULL,
        doc_comment     TEXT,
        access_modifier TEXT,
        called_methods  TEXT,
        deleted_at      INTEGER NOT NULL,
        delete_reason   TEXT NOT NULL,
        git_hash        TEXT,   -- 削除・変更時の最終コミットハッシュ（git連携時のみ）
        git_message     TEXT    -- 削除・変更時の最終コミットメッセージ（git連携時のみ）
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_archived_file
        ON archived_chunks(file_path);
      CREATE INDEX IF NOT EXISTS idx_archived_deleted_at
        ON archived_chunks(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_archived_class
        ON archived_chunks(class_name);
      CREATE INDEX IF NOT EXISTS idx_archived_method
        ON archived_chunks(method_name);
    `);
  }

  /**
   * チャンク群をアーカイブDBに保存する。
   * メインDBから削除する前に呼び出すこと。
   */
  archiveChunks(chunks: ArchivedChunkRow[], reason: DeleteReason): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO archived_chunks
        (id, file_path, start_line, end_line, type, class_name, method_name,
         content, doc_comment, access_modifier, called_methods,
         deleted_at, delete_reason, git_hash, git_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of chunks) {
      stmt.run(
        c.id,
        c.file_path,
        c.start_line,
        c.end_line,
        c.type,
        c.class_name,
        c.method_name,
        c.content,
        c.doc_comment,
        c.access_modifier,
        c.called_methods,
        now,
        reason,
        c.git_hash ?? null,
        c.git_message ?? null,
      );
    }
  }

  close(): void {
    this.db.close();
  }
}
