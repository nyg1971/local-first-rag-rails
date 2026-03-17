import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EMBEDDING_DIMS } from './embedder.ts';
import type { Chunk, MethodDefinition, MethodCall, Association } from './types.ts';
import type { GitCommitInfo } from './git.ts';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const Database = require('better-sqlite3');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const sqliteVec = require('sqlite-vec');

// better-sqlite3 の最低限の型定義
interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  pragma(sql: string): unknown;
  close(): void;
}
interface Statement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(...args: any[]): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  all(...args: any[]): any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(...args: any[]): any;
}

export interface SearchResult {
  rowid: number;
  chunkId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  type: string;
  className: string | null;
  methodName: string | null;
  content: string;
  docComment: string | null;
  accessModifier: string | null;
  distance: number;
  gitHash: string | null;
  gitMessage: string | null;
}

export class VectorStore {
  private db: Db;

  constructor(dbPath: string) {
    // DBファイルのディレクトリを自動作成
    mkdirSync(dirname(dbPath), { recursive: true });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    this.db = new Database(dbPath) as Db;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    sqliteVec.load(this.db);

    this.db.pragma('journal_mode = WAL');
    this._createTables();
  }

  // ────────────────────────────────────────────────────────────────────
  // テーブル初期化
  // ────────────────────────────────────────────────────────────────────

  private _createTables(): void {
    // チャンクのメタデータ（通常テーブル）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id            TEXT PRIMARY KEY,
        file_path     TEXT NOT NULL,
        start_line    INTEGER NOT NULL,
        end_line      INTEGER NOT NULL,
        type          TEXT NOT NULL,
        class_name    TEXT,
        method_name   TEXT,
        content       TEXT NOT NULL,
        doc_comment   TEXT,
        access_modifier TEXT,
        called_methods  TEXT,  -- JSON配列として保存
        git_hash        TEXT,  -- インデクシング時点の最終コミットハッシュ（git連携時のみ）
        git_message     TEXT   -- インデクシング時点の最終コミットメッセージ（git連携時のみ）
      )
    `);

    // ベクトルテーブル（sqlite-vec）
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec
      USING vec0(embedding float[${EMBEDDING_DIMS}])
    `);

    // 全文検索テーブル（BM25 / FTS5）
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
      USING fts5(
        chunk_id UNINDEXED,
        content,
        file_path,
        class_name,
        method_name
      )
    `);

    // rowid → chunk_id のマッピングテーブル
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vec_rowid_map (
        rowid   INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id TEXT NOT NULL UNIQUE
      )
    `);

    // 参照インデックス: メソッド定義
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS method_definitions (
        id              TEXT PRIMARY KEY,
        file_path       TEXT NOT NULL,
        class_name      TEXT NOT NULL,
        method_name     TEXT NOT NULL,
        start_line      INTEGER NOT NULL,
        access_modifier TEXT NOT NULL,
        is_class_method INTEGER NOT NULL  -- 0 or 1
      )
    `);

    // 参照インデックス: 呼び出し関係
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS method_calls (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        caller_id     TEXT NOT NULL,
        callee_raw    TEXT NOT NULL,
        file_path     TEXT NOT NULL,
        line          INTEGER NOT NULL
      )
    `);

    // 参照インデックス: アソシエーション
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS associations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        source_class  TEXT NOT NULL,
        type          TEXT NOT NULL,
        target        TEXT NOT NULL,
        source_file   TEXT NOT NULL DEFAULT ''
      )
    `);

    // 差分インデクシング用ファイル管理テーブル
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_index (
        file_path   TEXT    PRIMARY KEY,
        mtime       INTEGER NOT NULL,
        hash        TEXT    NOT NULL,
        indexed_at  INTEGER NOT NULL
      )
    `);

    // インデックス
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_method_defs_class
        ON method_definitions(class_name);
      CREATE INDEX IF NOT EXISTS idx_method_calls_caller
        ON method_calls(caller_id);
      CREATE INDEX IF NOT EXISTS idx_assoc_source
        ON associations(source_class);
      CREATE INDEX IF NOT EXISTS idx_assoc_target
        ON associations(target);
      CREATE INDEX IF NOT EXISTS idx_chunks_file
        ON chunks(file_path);
      CREATE INDEX IF NOT EXISTS idx_method_defs_file
        ON method_definitions(file_path);
      CREATE INDEX IF NOT EXISTS idx_method_calls_file
        ON method_calls(file_path);
      CREATE INDEX IF NOT EXISTS idx_assoc_file
        ON associations(source_file);
    `);
  }

  // ────────────────────────────────────────────────────────────────────
  // 書き込み
  // ────────────────────────────────────────────────────────────────────

  /**
   * チャンクとそのベクトルを保存する。
   * メモリ効率のため1件ずつ書き込む（ストリーミング設計）。
   */
  saveChunk(chunk: Chunk, embedding: Float32Array, gitInfo?: GitCommitInfo | null): void {
    // 1. メタデータ保存
    this.db.prepare(`
      INSERT OR REPLACE INTO chunks
        (id, file_path, start_line, end_line, type, class_name, method_name,
         content, doc_comment, access_modifier, called_methods, git_hash, git_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chunk.id,
      chunk.filePath,
      chunk.startLine,
      chunk.endLine,
      chunk.type,
      chunk.className ?? null,
      chunk.methodName ?? null,
      chunk.content,
      chunk.docComment ?? null,
      chunk.accessModifier ?? null,
      chunk.calledMethods ? JSON.stringify(chunk.calledMethods) : null,
      gitInfo?.hash ?? null,
      gitInfo?.message ?? null,
    );

    // 2. rowidマッピング登録
    this.db.prepare(`
      INSERT OR IGNORE INTO vec_rowid_map (chunk_id) VALUES (?)
    `).run(chunk.id);

    const row = this.db.prepare(
      `SELECT rowid FROM vec_rowid_map WHERE chunk_id = ?`,
    ).get(chunk.id) as { rowid: number };

    // 3. ベクトル保存（rowidはBigIntで渡す）
    // vec0 仮想テーブルは INSERT OR REPLACE が非対応のため DELETE + INSERT で上書きする
    this.db.prepare(`DELETE FROM chunks_vec WHERE rowid = ?`).run(BigInt(row.rowid));
    this.db.prepare(`
      INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)
    `).run(BigInt(row.rowid), Buffer.from(embedding.buffer));

    // 4. FTS5 保存
    this.db.prepare(`
      INSERT OR REPLACE INTO chunks_fts
        (chunk_id, content, file_path, class_name, method_name)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      chunk.id,
      chunk.content,
      chunk.filePath,
      chunk.className ?? '',
      chunk.methodName ?? '',
    );
  }

  saveDefinition(def: MethodDefinition): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO method_definitions
        (id, file_path, class_name, method_name, start_line, access_modifier, is_class_method)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      def.id,
      def.filePath,
      def.className,
      def.methodName,
      def.startLine,
      def.accessModifier,
      def.isClassMethod ? 1 : 0,
    );
  }

  saveCall(call: MethodCall): void {
    this.db.prepare(`
      INSERT INTO method_calls (caller_id, callee_raw, file_path, line)
      VALUES (?, ?, ?, ?)
    `).run(call.callerId, call.calleeRaw, call.filePath, call.line);
  }

  saveAssociation(assoc: Association): void {
    this.db.prepare(`
      INSERT INTO associations (source_class, type, target, source_file)
      VALUES (?, ?, ?, ?)
    `).run(assoc.sourceClass, assoc.type, assoc.target, assoc.filePath);
  }

  // ────────────────────────────────────────────────────────────────────
  // 検索
  // ────────────────────────────────────────────────────────────────────

  /**
   * ベクトル検索（KNN）: クエリベクトルに近いチャンクをtopK件返す
   */
  vectorSearch(queryVec: Float32Array, topK: number = 10): SearchResult[] {
    const rows = this.db.prepare(`
      SELECT
        v.rowid,
        v.distance,
        m.chunk_id,
        c.file_path,
        c.start_line,
        c.end_line,
        c.type,
        c.class_name,
        c.method_name,
        c.content,
        c.doc_comment,
        c.access_modifier,
        c.git_hash,
        c.git_message
      FROM chunks_vec v
      JOIN vec_rowid_map m ON m.rowid = v.rowid
      JOIN chunks c ON c.id = m.chunk_id
      WHERE v.embedding MATCH ?
        AND k = ?
      ORDER BY v.distance
    `).all(Buffer.from(queryVec.buffer), topK) as Array<{
      rowid: number;
      distance: number;
      chunk_id: string;
      file_path: string;
      start_line: number;
      end_line: number;
      type: string;
      class_name: string | null;
      method_name: string | null;
      content: string;
      doc_comment: string | null;
      access_modifier: string | null;
      git_hash: string | null;
      git_message: string | null;
    }>;

    return rows.map((r) => ({
      rowid: r.rowid,
      chunkId: r.chunk_id,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      type: r.type,
      className: r.class_name,
      methodName: r.method_name,
      content: r.content,
      docComment: r.doc_comment,
      accessModifier: r.access_modifier,
      distance: r.distance,
      gitHash: r.git_hash,
      gitMessage: r.git_message,
    }));
  }

  /**
   * BM25全文検索: キーワードに一致するチャンクをtopK件返す
   */
  ftsSearch(query: string, topK: number = 10): SearchResult[] {
    const rows = this.db.prepare(`
      SELECT
        f.chunk_id,
        f.content,
        f.file_path,
        f.class_name,
        f.method_name,
        bm25(chunks_fts) AS score,
        c.start_line,
        c.end_line,
        c.type,
        c.doc_comment,
        c.access_modifier,
        c.git_hash,
        c.git_message
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.chunk_id
      WHERE chunks_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(query, topK) as Array<{
      chunk_id: string;
      content: string;
      file_path: string;
      class_name: string;
      method_name: string;
      score: number;
      start_line: number;
      end_line: number;
      type: string;
      doc_comment: string | null;
      access_modifier: string | null;
      git_hash: string | null;
      git_message: string | null;
    }>;

    return rows.map((r, i) => ({
      rowid: i,
      chunkId: r.chunk_id,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      type: r.type,
      className: r.class_name,
      methodName: r.method_name,
      content: r.content,
      docComment: r.doc_comment,
      accessModifier: r.access_modifier,
      distance: r.score,
      gitHash: r.git_hash,
      gitMessage: r.git_message,
    }));
  }

  /**
   * 参照情報取得: 指定メソッドの呼び出し元・呼び出し先・アソシエーションを返す
   */
  getReferences(className: string, methodName: string) {
    const defId = `${className}#${methodName}`;

    const callers = this.db.prepare(`
      SELECT DISTINCT caller_id, file_path, line
      FROM method_calls
      WHERE callee_raw LIKE ?
      LIMIT 20
    `).all(`%${methodName}%`) as Array<{ caller_id: string; file_path: string; line: number }>;

    const callees = this.db.prepare(`
      SELECT DISTINCT callee_raw, file_path, line
      FROM method_calls
      WHERE caller_id = ?
      LIMIT 20
    `).all(defId) as Array<{ callee_raw: string; file_path: string; line: number }>;

    const associations = this.db.prepare(`
      SELECT type, target
      FROM associations
      WHERE source_class = ?
    `).all(className) as Array<{ type: string; target: string }>;

    return { callers, callees, associations };
  }

  // ────────────────────────────────────────────────────────────────────
  // グラフ拡張用クエリ
  // ────────────────────────────────────────────────────────────────────

  /**
   * chunk_id の配列からチャンクを一括取得する。
   * グラフ拡張で新規に追加するチャンクの取得に使用する。
   */
  getChunksByIds(ids: string[]): SearchResult[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT
        c.id       AS chunk_id,
        c.file_path,
        c.start_line,
        c.end_line,
        c.type,
        c.class_name,
        c.method_name,
        c.content,
        c.doc_comment,
        c.access_modifier,
        c.git_hash,
        c.git_message
      FROM chunks c
      WHERE c.id IN (${placeholders})
    `).all(...ids) as Array<{
      chunk_id: string;
      file_path: string;
      start_line: number;
      end_line: number;
      type: string;
      class_name: string | null;
      method_name: string | null;
      content: string;
      doc_comment: string | null;
      access_modifier: string | null;
      git_hash: string | null;
      git_message: string | null;
    }>;

    return rows.map((r) => ({
      rowid: 0,
      chunkId: r.chunk_id,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      type: r.type,
      className: r.class_name,
      methodName: r.method_name,
      content: r.content,
      docComment: r.doc_comment,
      accessModifier: r.access_modifier,
      distance: 0,
      gitHash: r.git_hash,
      gitMessage: r.git_message,
    }));
  }

  /**
   * className を起点にアソシエーション先クラスのチャンク ID を返す。
   * include / extend / prepend の対象が汎用 Concern（多数クラスから include される）の場合は除外する。
   */
  getAssociatedChunkIds(
    className: string,
    includeCountThreshold = 10,
  ): Array<{ chunkId: string; type: string }> {
    const assocRows = this.db.prepare(`
      SELECT type, target FROM associations WHERE source_class = ?
    `).all(className) as Array<{ type: string; target: string }>;

    const result: Array<{ chunkId: string; type: string }> = [];

    for (const assoc of assocRows) {
      // include / extend / prepend は汎用 Concern を除外
      if (assoc.type === 'include' || assoc.type === 'extend' || assoc.type === 'prepend') {
        const countRow = this.db.prepare(`
          SELECT COUNT(DISTINCT source_class) AS cnt
          FROM associations WHERE type = 'include' AND target = ?
        `).get(assoc.target) as { cnt: number };
        if (countRow.cnt > includeCountThreshold) continue;
      }

      // target クラス / モジュールの概要チャンクを取得
      const chunkRows = this.db.prepare(`
        SELECT id FROM chunks WHERE class_name = ? AND type IN ('class', 'module')
      `).all(assoc.target) as Array<{ id: string }>;

      for (const c of chunkRows) {
        result.push({ chunkId: c.id, type: assoc.type });
      }
    }

    return result;
  }

  /**
   * className#methodName を呼び出しているチャンクの ID を返す（callers）。
   */
  getCallerChunkIds(className: string, methodName: string): string[] {
    const callerRows = this.db.prepare(`
      SELECT DISTINCT caller_id FROM method_calls
      WHERE callee_raw LIKE ?
      LIMIT 50
    `).all(`%${methodName}%`) as Array<{ caller_id: string }>;

    const chunkIds: string[] = [];
    for (const { caller_id } of callerRows) {
      // caller_id 形式: "ClassName#method"（インスタンス）または "ClassName.method"（クラス）
      const sepIdx = caller_id.includes('#')
        ? caller_id.lastIndexOf('#')
        : caller_id.lastIndexOf('.');
      if (sepIdx === -1) continue;
      const callerClass = caller_id.slice(0, sepIdx);
      const callerMethod = caller_id.slice(sepIdx + 1);

      const chunks = this.db.prepare(`
        SELECT id FROM chunks WHERE class_name = ? AND method_name = ?
      `).all(callerClass, callerMethod) as Array<{ id: string }>;

      chunkIds.push(...chunks.map((c) => c.id));
    }

    return [...new Set(chunkIds)];
  }

  /**
   * className#methodName が呼び出しているチャンクの ID を返す（callees）。
   * 定数レシーバー（大文字始まりのクラス名.メソッド名）のみを対象とする。
   */
  getCalleeConstantChunkIds(className: string, methodName: string): string[] {
    const callerIds = [`${className}#${methodName}`, `${className}.${methodName}`];
    const placeholders = callerIds.map(() => '?').join(',');

    const calleeRows = this.db.prepare(`
      SELECT DISTINCT callee_raw FROM method_calls
      WHERE caller_id IN (${placeholders})
    `).all(...callerIds) as Array<{ callee_raw: string }>;

    const chunkIds: string[] = [];
    for (const { callee_raw } of calleeRows) {
      // 定数レシーバー: "ClassName.method" 形式（大文字始まり）
      const match = /^([A-Z][A-Za-z0-9_]*)\./.exec(callee_raw);
      if (!match) continue;
      const receiverClass = match[1];

      const chunks = this.db.prepare(`
        SELECT id FROM chunks WHERE class_name = ? AND type IN ('class', 'module')
      `).all(receiverClass) as Array<{ id: string }>;

      chunkIds.push(...chunks.map((c) => c.id));
    }

    return [...new Set(chunkIds)];
  }

  // ────────────────────────────────────────────────────────────────────
  // 差分インデクシング
  // ────────────────────────────────────────────────────────────────────

  /**
   * 指定ファイルのチャンクをアーカイブ用に取得する。
   * deleteFileData() を呼ぶ前に実行すること。
   */
  getChunksForFile(filePath: string): Array<{
    id: string; file_path: string; start_line: number; end_line: number;
    type: string; class_name: string | null; method_name: string | null;
    content: string; doc_comment: string | null; access_modifier: string | null;
    called_methods: string | null;
  }> {
    return this.db.prepare(`
      SELECT id, file_path, start_line, end_line, type, class_name, method_name,
             content, doc_comment, access_modifier, called_methods
      FROM chunks WHERE file_path = ?
    `).all(filePath) as Array<{
      id: string; file_path: string; start_line: number; end_line: number;
      type: string; class_name: string | null; method_name: string | null;
      content: string; doc_comment: string | null; access_modifier: string | null;
      called_methods: string | null;
    }>;
  }

  /** 既知ファイルパスの一覧を取得（差分検出の基準） */
  getAllKnownPaths(): Set<string> {
    const rows = this.db.prepare(
      `SELECT file_path FROM file_index`,
    ).all() as Array<{ file_path: string }>;
    return new Set(rows.map((r) => r.file_path));
  }

  /** ファイルの前回記録（mtime・hash）を取得 */
  getFileRecord(filePath: string): { mtime: number; hash: string } | null {
    const row = this.db.prepare(
      `SELECT mtime, hash FROM file_index WHERE file_path = ?`,
    ).get(filePath) as { mtime: number; hash: string } | undefined;
    return row ?? null;
  }

  /** file_index を挿入または更新 */
  upsertFileIndex(filePath: string, mtime: number, hash: string): void {
    this.db.prepare(`
      INSERT INTO file_index (file_path, mtime, hash, indexed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        mtime      = excluded.mtime,
        hash       = excluded.hash,
        indexed_at = excluded.indexed_at
    `).run(filePath, mtime, hash, Date.now());
  }

  /**
   * 指定ファイルに紐づく全データを削除する。
   * chunks_vec は rowid 経由での削除が必要。
   */
  deleteFileData(filePath: string): void {
    // 1. 対象チャンクの chunk_id を取得
    const chunkIds = (this.db.prepare(
      `SELECT id FROM chunks WHERE file_path = ?`,
    ).all(filePath) as Array<{ id: string }>).map((r) => r.id);

    if (chunkIds.length > 0) {
      // 2. vec_rowid_map から vec_rowid を取得
      const placeholders = chunkIds.map(() => '?').join(',');
      const vecRowids = (this.db.prepare(
        `SELECT rowid FROM vec_rowid_map WHERE chunk_id IN (${placeholders})`,
      ).all(...chunkIds) as Array<{ rowid: number }>).map((r) => r.rowid);

      // 3. chunks_vec を rowid で削除
      for (const rowid of vecRowids) {
        this.db.prepare(
          `DELETE FROM chunks_vec WHERE rowid = ?`,
        ).run(BigInt(rowid));
      }

      // 4. FTS・rowidマップを削除
      this.db.prepare(
        `DELETE FROM chunks_fts WHERE chunk_id IN (${placeholders})`,
      ).run(...chunkIds);
      this.db.prepare(
        `DELETE FROM vec_rowid_map WHERE chunk_id IN (${placeholders})`,
      ).run(...chunkIds);
    }

    // 5. chunks・参照テーブル・file_index を削除
    this.db.prepare(`DELETE FROM chunks             WHERE file_path   = ?`).run(filePath);
    this.db.prepare(`DELETE FROM method_definitions WHERE file_path   = ?`).run(filePath);
    this.db.prepare(`DELETE FROM method_calls       WHERE file_path   = ?`).run(filePath);
    this.db.prepare(`DELETE FROM associations       WHERE source_file = ?`).run(filePath);
    this.db.prepare(`DELETE FROM file_index         WHERE file_path   = ?`).run(filePath);
  }

  close(): void {
    this.db.close();
  }
}
