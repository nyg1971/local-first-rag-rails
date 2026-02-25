import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import cors from 'cors';
import { VectorStore } from '../cli/store.ts';
import { createSearchHandler } from './search.ts';
import { getExtractor, EMBEDDING_MODEL } from '../cli/embedder.ts';

// ────────────────────────────────────────────────────────────────────
// エントリーポイント
// ────────────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<Server> {
  // ── CLI 引数 ──
  const { values } = parseArgs({
    args: argv,
    options: {
      db:   { type: 'string' },
      port: { type: 'string', default: '3001' },
    },
  });

  if (!values.db) {
    console.error('Usage: tsx server/index.ts --db <path/to/index.db> [--port 3001]');
    process.exit(1);
  }

  const dbPath = resolve(values.db);
  const port   = parseInt(values.port ?? '3001', 10);

  // ── サーバー初期化 ──
  const app = express();

  app.use(cors({
    origin: /^http:\/\/localhost(:\d+)?$/,
    methods: ['GET', 'POST'],
  }));
  app.use(express.json());

  // ── DBとモデルをサーバー起動時に1回だけロード ──
  console.log(`[server] Opening DB: ${dbPath}`);
  let store: VectorStore;
  try {
    store = new VectorStore(dbPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[server] DBのオープンに失敗しました: ${dbPath}`);
    console.error(`  原因: ${msg}`);
    console.error('  先に `pnpm index <rails-root>` でインデクシングを実行してください。');
    process.exit(1);
  }

  console.log(`[server] Loading embedding model: ${EMBEDDING_MODEL} ...`);
  try {
    await getExtractor();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[server] 埋め込みモデルのロードに失敗しました。');
    console.error(`  原因: ${msg}`);
    console.error('  ネットワーク接続またはモデルキャッシュを確認してください。');
    store.close();
    process.exit(1);
  }
  console.log('[server] Model ready.');

  // ── ルーティング ──
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', model: EMBEDDING_MODEL, db: dbPath });
  });

  app.post('/search', createSearchHandler(store));

  // ── 起動 ──
  // Promise でラップし、listen 完了後にサーバーインスタンスを返す
  // （テストでの graceful shutdown と、ポート競合エラーの捕捉を可能にするため）
  const server = await new Promise<Server>((resolveServer, rejectServer) => {
    const s = app
      .listen(port, () => {
        console.log(`[server] Listening on http://localhost:${port}`);
        console.log(`[server] Ready. POST /search { "query": "..." }`);
        resolveServer(s);
      })
      .on('error', rejectServer);
  });

  // グレースフルシャットダウン
  process.on('SIGINT', () => {
    console.log('\n[server] Shutting down...');
    server.close();
    store.close();
    process.exit(0);
  });

  return server;
}

// スクリプトとして直接実行された場合のみ main() を呼ぶ
// （import された場合は呼ばない）
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
