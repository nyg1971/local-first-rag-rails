# local-first-rag-Poc

Rails コードベースを、ローカルで RAG 検索できる開発者向けツールのPoC。

*現在は、検索精度の向上が課題

Tree-sitter による AST ベースのチャンキングと、ベクトル検索 + 全文検索のハイブリッド方式で、Rails リポジトリのコードを自然言語で検索する。

---

## 特徴

- **完全ローカル動作** — インデクシング・検索ともに外部 API 不使用。機密コードがネットワークを通じることはない
- **Rails 特化チャンキング** — Tree-sitter（AST）でクラス・メソッド・DSL 行を正確に抽出。正規表現では対応困難なネストやヒアドキュメントも処理できる
- **ハイブリッド検索** — ベクトル検索（sqlite-vec）と全文検索（FTS5）を RRF で統合。FTS5 が機能しない場合のデグレードにも対応
- **差分インデクシング** — mtime + SHA1 の二段階検出により、変更ファイルのみを再処理。2 回目以降は数秒で完了
- **複数プロジェクト対応** — `--port` オプションで複数インスタンスを起動し、ブラウザのタブで使い分ける
- **git 連携** — インデクシング時に各ファイルの直近コミット情報を記録

---

## 動作の流れ

```
Rails リポジトリ
      |
   [CLI: pnpm index]
      |
  Tree-sitter でチャンキング
  （クラス概要・メソッド・DSL / ERB / YAML / Gemfile）
      |
  multilingual-e5-base で埋め込み生成（768dim、完全ローカル）
      |
  SQLite に保存（sqlite-vec + FTS5）
      |
   [Server: pnpm serve]
      |
  ハイブリッド検索 API（ベクトル + FTS5 → RRF）
      |
   [Browser: pnpm dev]
      |
  React 検索 UI（コードスニペット・参照情報）
```

---

## 必要な環境

| 項目 | 要件 |
|------|------|
| OS | macOS（主ターゲット） |
| Node.js | v20 以上 |
| pnpm | v10 以上 |
| Xcode CLT | tree-sitter / sqlite-vec のネイティブ拡張ビルドに必要 |
| ディスク空き容量 | 埋め込みモデル約 280MB + DB（プロジェクト規模に応じて） |

```bash
# Xcode CLT のインストール（未導入の場合）
xcode-select --install
```

---

## インストール

```bash
git clone <repository-url> local-first-rag
cd local-first-rag
pnpm install
```

`pnpm install` 中に tree-sitter・sqlite-vec のネイティブバイナリがビルドされる。

---

## クイックスタート

### 1. インデクシング

```bash
pnpm index /path/to/your-rails-app
```

初回はモデル（約 280MB）が自動ダウンロードされる。2 回目以降はキャッシュから読み込む。

```
[local-first-rag] Indexing: /path/to/your-rails-app
  Model:   Xenova/multilingual-e5-base (768dims)
  DB:      /path/to/your-rails-app/.rag/index.db
  Git:     enabled

[local-first-rag] Done.
  Added  : 312 files
  Chunks : 8431
  DB     : /path/to/your-rails-app/.rag/index.db
```

### 2. サーバー起動

```bash
pnpm serve --db /path/to/your-rails-app/.rag/index.db
```

### 3. 検索 UI を開く

```bash
pnpm dev
# → http://localhost:5173 をブラウザで開く
```

接続設定画面でサーバー URL（`http://localhost:3001`）を入力して、検索できる状態になる。

---

## CLI オプション

### `pnpm index <rails-root>`

| オプション | 短縮形 | デフォルト | 説明 |
|-----------|------|----------|------|
| `--scope` | `-s` | — | 対象ディレクトリをカンマ区切りで指定 |
| `--exclude` | `-e` | — | 除外ディレクトリをカンマ区切りで追加 |
| `--db` | — | `<rails-root>/.rag/index.db` | DB ファイルの出力パス |

```bash
# 特定ディレクトリのみをインデクシング
pnpm index /path/to/your-rails-app --scope app/models,app/services

# ディレクトリを追加除外
pnpm index /path/to/your-rails-app --exclude spec,app/assets

# DB の出力先を指定
pnpm index /path/to/your-rails-app --db ~/rag-indexes/your-rails-app.db
```

### `pnpm serve`

| オプション | デフォルト | 説明 |
|-----------|----------|------|
| `--db` | （必須） | インデックス DB ファイルのパス |
| `--port` | `3001` | リッスンするポート番号 |

---

## 複数プロジェクトの管理

プロジェクトごとにサーバーを別ポートで起動し、ブラウザのタブで使い分ける。

```bash
# プロジェクト A
pnpm serve --db /path/to/app-a/.rag/index.db --port 3001

# プロジェクト B
pnpm serve --db /path/to/app-b/.rag/index.db --port 3002
```

---

## インデクシング対象ファイル

| 種別 | パターン | チャンク粒度 |
|------|---------|------------|
| Ruby | `**/*.rb` | クラス概要・メソッド単位 |
| ERB | `**/*.erb` | ファイル単位 |
| YAML | `**/*.yml`, `**/*.yaml` | トップキー単位 |
| Gemfile | `Gemfile` | ファイル全体 |

デフォルトで除外されるディレクトリ: `node_modules`, `.git`, `tmp`, `log`, `vendor/bundle`, `public/assets`, `coverage`, `.bundle`

---

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| CLI | Node.js + TypeScript（tsx） |
| チャンキング | tree-sitter + tree-sitter-ruby |
| 埋め込みモデル | @xenova/transformers / Xenova/multilingual-e5-base（768dim） |
| ベクトル DB | better-sqlite3 + sqlite-vec + FTS5 |
| サーバー | Express |
| フロントエンド | React + Vite + Tailwind CSS v4 + shadcn/ui |
| テスト | vitest（178 テスト） |

---

## ライセンス

MIT
