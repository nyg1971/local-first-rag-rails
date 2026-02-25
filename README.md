# 🧭 Local-First RAG 構想〜PoC構築サマリー

## 🏁 プロジェクト概要
**目的：**  
個人〜小規模利用者（50名未満）を対象に、  
外部サーバーへ機密文書を送らず「ローカルで完結するRAG（Retrieval-Augmented Generation）」を実現する。  
生成は外部APIでも、検索・ベクトル化はローカル（WASM）で行う。

**理念：**
> “Startpage.comのように、あなたのデータには興味がありません。”

---

## 1️⃣ 技術・構想フェーズ

| 項目 | 内容 |
|------|------|
| コア思想 | 「Local-First」＋「Privacy-Preserving」＋「User-Owned Knowledge」 |
| 構成パターン | A. 完全ローカル／B. ハイブリッド（採用）／C. 完全クラウド |
| 採用方針 | 検索＝ローカル、生成＝外部API（※オプション） |
| WebAssemblyの役割 | 埋め込み・検索・PDF処理をブラウザで完結 |
| 代表的比較対象 | NotebookLM、Perplexity Pages、Rewind.ai、LlamaIndex.TS、AnythingLLM |
| 埋め込み候補 | **Embedding Gemma**（Google Gemma 2b int8）＋ @xenova/transformers |

---

## 2️⃣ アーキテクチャ設計

### 🧩 構成図（概念）

```
PDF / TXT Upload
     ↓
Chunking（分割）
     ↓
Embedding (Gemma / WASM)
     ↓
Store in IndexedDB
     ↓
Query + Vector Search (cosine)
     ↓
Context Inject → (optional) API Generate
     ↓
UI Display (React / shadcn)
```

### 📁 提案リポジトリ構成
```
local-first-rag/
 ├─ src/
 │   ├─ components/
 │   ├─ features/
 │   │   ├─ embed/
 │   │   ├─ search/
 │   │   └─ ui/
 │   ├─ lib/
 │   └─ assets/
 ├─ public/
 ├─ tailwind.config.ts
 ├─ postcss.config.js
 ├─ vite.config.ts
 └─ tsconfig.json
```

---

## 3️⃣ 開発環境構築

### 🧰 ベース環境
- Node.js v20+
- pnpm v10
- React + TypeScript + Vite
- Tailwind CSS v4（CLI分離版）
- shadcn (new CLI)
- @xenova/transformers (WASM埋め込み)

### 📦 初期化手順
```bash
pnpm create vite@latest local-first-rag -- --template react-ts
pnpm add -D @tailwindcss/cli @tailwindcss/postcss postcss autoprefixer
pnpm add -D prettier prettier-plugin-tailwindcss
pnpm add class-variance-authority clsx tailwind-variants lucide-react
```

---

## 4️⃣ 設定ファイル一覧

**tailwind.config.ts**
```ts
import type { Config } from "tailwindcss";
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
```

**postcss.config.js**
```js
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
```

**src/index.css**
```css
@import "tailwindcss";
@tailwind base;
@tailwind components;
@tailwind utilities;
@plugin "tailwindcss-animate";
@custom-variant dark (&:is(.dark *));
```

**vite.config.ts**
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
})
```

**tsconfig.json**
```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  }
}
```

---

## 5️⃣ UI構築（Tailwind + shadcn）

### shadcn初期化
```bash
pnpm dlx shadcn@latest init -y
pnpm dlx shadcn@latest add button
```

### src/App.tsx（UIテスト）
```tsx
import { Button } from "@/components/ui/button";

export default function App() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="space-y-4 text-center">
        <h1 className="text-2xl font-semibold text-slate-800">
          🎶 Local-First RAG + Tailwind v4 + shadcn
        </h1>
        <Button>Primary</Button>
        <Button variant="ghost">Ghost</Button>
      </div>
    </div>
  );
}
```

## 7️⃣ 運用モード設計：ローカル完結 vs API連携

### 🎯 方針
- **デフォルトは完全ローカルモード**（ネットワーク非依存）。
- 生成機能は **任意オプション**。
- ユーザーが明示的に切り替えたときのみAPI通信を許可。
- すべての送信内容は送信前にプレビュー表示。

### ⚖️ モード比較表

| 観点 | 🔒 ローカル完結モード | 🌐 LLM API呼び出しモード |
|------|----------------------|-------------------------|
| 目的 | 安全・抽出的 QA | 要約・翻訳・推論など生成的回答 |
| 処理 | 埋め込み・検索・抜粋整形（抽出的） | 抜粋＋生成（要約・構造化） |
| 出力 | スニペット＋出典リンク | 自然文＋要約＋出典脚注 |
| プライバシー | 完全ローカル（ネット不要） | 抜粋を外部送信（マスク可） |
| コスト | 無料 | トークン課金 |
| オフライン可否 | ✅ 可 | ❌ 不可 |
| 幻覚リスク | 極小 | あり（プロンプト設計依存） |
| 速度 | 高速（端末性能依存） | 遅延あり（API往復） |
| UI差分 | 出典ビュー中心 | 要約ビュー中心＋費用トースト |
| ガバナンス | 端末内ポリシーのみ | キー管理／送信監査必須 |



### 💡 ローカルモードのリッチ化策
- 抜粋テンプレ整形（ハイライト／見出し付）
- 軽量再ランク（ONNX cross-encoder Top-N）
- 音楽譜面・契約文などドメイン特化辞書
- 複数抜粋のルール合成（順序＋重複除去）
- **“半生成”整形** ＝ JSのみで構文補完、創作文なし

### ✅ 受け入れ基準
- [ ] Network requests = 0 で検索完結
- [ ] 出典明示・正確
- [ ] 100〜300 チャンクで < 300 ms 応答
- [ ] PII フィルタはローカル実行
- [ ] APIキーUI OFF 時は送信機能も完全無効化

### 💬 結論
> 「普段は抽出的・安全に。  
>  必要な時だけ生成的に。」

---

## 8️⃣ 今後のフェーズ

| フェーズ | 内容 |
|-----------|-------|
| **RAG 2：検索PoC編** | ベクトル格納と Flat コサイン検索の実装 |
| **RAG 3：PDF解析編** | PDF→テキスト抽出→チャンク分割→埋め込み |
| **RAG 4：生成連携（オプション）編** | コンテキスト注入 + LLM API呼び出し（※任意／完全クローズド運用可） |
| **RAG 5：PWA／設定UI編** | IndexedDB管理、APIキー入力UI、オフライン化 |

---

## 🧩 メモ
- Tailwind v4：CLI分離 + PostCSS別パッケージ
- pnpm 9〜10 ：approve-builds 仕様変更（対話式）
- shadcn ：新CLI版へ完全移行
- WASM transformers：ブラウザ推論が実用域
- Local-First ＝ 技術＋思想の融合

---

✅ **まとめ一句：**
> RAGをローカルに。  
> データはあなたの手の中に。  

