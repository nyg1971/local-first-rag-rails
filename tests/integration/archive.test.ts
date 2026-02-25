import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { ArchiveStore } from '../../cli/archive.ts';
import type { ArchivedChunkRow } from '../../cli/archive.ts';

// ──────────────────────────────────────────────────────────────────
// テストヘルパー
// ──────────────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);

/** テスト専用: better-sqlite3 を直接使って archived_chunks を読み取る */
function queryArchivedChunk(dbPath: string, id: string): Record<string, unknown> | undefined {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
  const db = require('better-sqlite3')(dbPath);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const row = db.prepare('SELECT * FROM archived_chunks WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  db.close();
  return row;
}

function makeArchivedChunk(overrides: Partial<ArchivedChunkRow> = {}): ArchivedChunkRow {
  return {
    id: randomUUID(),
    file_path: 'app/models/user.rb',
    start_line: 1,
    end_line: 5,
    type: 'method',
    class_name: 'User',
    method_name: 'greet',
    content: 'def greet; end',
    doc_comment: null,
    access_modifier: null,
    called_methods: null,
    git_hash: null,
    git_message: null,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────
// テストスイート
// ──────────────────────────────────────────────────────────────────

describe('ArchiveStore', () => {
  let tmpDir: string;
  let dbPath: string;
  let archive: ArchiveStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rag-archive-test-'));
    dbPath = join(tmpDir, 'archive.db');
    archive = new ArchiveStore(dbPath);
  });

  afterEach(() => {
    archive.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('archiveChunks', () => {
    it('チャンクをアーカイブできる（例外なし）', () => {
      const chunks = [makeArchivedChunk()];
      expect(() => archive.archiveChunks(chunks, 'file_deleted')).not.toThrow();
    });

    it('複数チャンクを一度にアーカイブできる', () => {
      const chunks = [
        makeArchivedChunk({ method_name: 'greet' }),
        makeArchivedChunk({ method_name: 'farewell' }),
      ];
      expect(() => archive.archiveChunks(chunks, 'file_changed')).not.toThrow();
    });

    it('空配列を渡しても例外が起きない', () => {
      expect(() => archive.archiveChunks([], 'file_deleted')).not.toThrow();
    });

    it('delete_reason = "file_deleted" で保存される', () => {
      const chunk = makeArchivedChunk({ file_path: 'app/models/check.rb' });
      archive.archiveChunks([chunk], 'file_deleted');
      archive.close();

      const row = queryArchivedChunk(dbPath, chunk.id);

      // afterEach でcloseを再度呼ばないよう再オープン
      archive = new ArchiveStore(dbPath);

      expect(row).toBeDefined();
      expect(row!['delete_reason']).toBe('file_deleted');
      expect(row!['file_path']).toBe('app/models/check.rb');
    });

    it('delete_reason = "file_changed" で保存される', () => {
      const chunk = makeArchivedChunk();
      archive.archiveChunks([chunk], 'file_changed');
      archive.close();

      const row = queryArchivedChunk(dbPath, chunk.id);
      archive = new ArchiveStore(dbPath);

      expect(row!['delete_reason']).toBe('file_changed');
    });

    it('git_hash と git_message が保存される', () => {
      const chunk = makeArchivedChunk({
        git_hash: 'deadbeef',
        git_message: 'fix: remove unused method',
      });
      archive.archiveChunks([chunk], 'file_changed');
      archive.close();

      const row = queryArchivedChunk(dbPath, chunk.id);
      archive = new ArchiveStore(dbPath);

      expect(row!['git_hash']).toBe('deadbeef');
      expect(row!['git_message']).toBe('fix: remove unused method');
    });

    it('deleted_at が正の整数として保存される', () => {
      const before = Date.now();
      const chunk = makeArchivedChunk();
      archive.archiveChunks([chunk], 'file_deleted');
      archive.close();

      const row = queryArchivedChunk(dbPath, chunk.id);
      archive = new ArchiveStore(dbPath);

      const deletedAt = row!['deleted_at'] as number;
      expect(deletedAt).toBeGreaterThanOrEqual(before);
      expect(deletedAt).toBeLessThanOrEqual(Date.now());
    });
  });
});
