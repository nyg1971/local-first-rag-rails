import { useState, useRef } from 'react';
import { search, checkHealth } from '@/features/search/api';
import { ReferenceView } from './ReferenceView';
import { Button } from '@/components/ui/button';
import type { SearchResultItem } from '@/types/api';

type Status = 'idle' | 'checking' | 'ready' | 'searching' | 'error';

const ACCESS_BADGE: Record<string, string> = {
  private:   'bg-red-100 text-red-700',
  protected: 'bg-yellow-100 text-yellow-700',
  public:    'bg-green-100 text-green-700',
};

const TYPE_BADGE: Record<string, string> = {
  method:           'bg-blue-100 text-blue-700',
  singleton_method: 'bg-indigo-100 text-indigo-700',
  class:            'bg-purple-100 text-purple-700',
  module:           'bg-violet-100 text-violet-700',
  file:             'bg-slate-100 text-slate-600',
};

function buildServerUrl(port: string): string {
  const p = port.trim() || '3001';
  return `http://localhost:${p}`;
}

export function SearchView() {
  const [status, setStatus]     = useState<Status>('idle');
  const [port, setPort]         = useState('3001');
  const [serverUrl, setServerUrl] = useState('');
  const [query, setQuery]       = useState('');
  const [results, setResults]   = useState<SearchResultItem[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  // ── サーバー接続確認 ──
  const handleConnect = async () => {
    setStatus('checking');
    const url = buildServerUrl(port);
    const ok = await checkHealth(url);
    if (ok) {
      setServerUrl(url);
      setStatus('ready');
      inputRef.current?.focus();
    } else {
      setStatus('error');
      setErrorMsg(`サーバーに接続できません（${url}）。\npnpm serve --db <path> [--port ${port}] で起動してください。`);
    }
  };

  // ── 検索実行 ──
  const handleSearch = async () => {
    if (!query.trim()) return;
    setStatus('searching');
    setResults([]);
    setExpanded(new Set());
    try {
      const res = await search(serverUrl, query.trim());
      setResults(res.results);
      setStatus('ready');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // ── 接続前 ──
  if (status === 'idle' || status === 'checking') {
    return (
      <div className="flex flex-col items-center gap-4 pt-24">
        <h1 className="text-2xl font-bold text-slate-800">local-first-rag</h1>
        <p className="text-sm text-slate-500">Railsコードベース検索ツール</p>
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-500">localhost:</span>
          <input
            type="text"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
            placeholder="3001"
            className="w-20 rounded-md border border-slate-300 px-2 py-1.5 text-sm shadow-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
          />
          <Button onClick={handleConnect} disabled={status === 'checking'}>
            {status === 'checking' ? '接続確認中...' : 'サーバーに接続'}
          </Button>
        </div>
      </div>
    );
  }

  // ── エラー ──
  if (status === 'error') {
    return (
      <div className="flex flex-col items-center gap-4 pt-24">
        <p className="whitespace-pre-line text-center text-red-600">{errorMsg}</p>
        <Button variant="outline" onClick={() => setStatus('idle')}>戻る</Button>
      </div>
    );
  }

  // ── 検索UI ──
  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      {/* 接続先表示 */}
      <div className="mb-4 flex items-center justify-between">
        <span className="text-xs text-slate-400">{serverUrl}</span>
        <button
          className="text-xs text-slate-400 underline hover:text-slate-600"
          onClick={() => { setStatus('idle'); setResults([]); }}
        >
          切断
        </button>
      </div>

      {/* 検索バー */}
      <div className="mb-6 flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="例: キャンセル処理はどこ？  / PaymentService の refund"
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
        />
        <Button onClick={handleSearch} disabled={status === 'searching'}>
          {status === 'searching' ? '検索中...' : '検索'}
        </Button>
      </div>

      {/* 件数 */}
      {results.length > 0 && (
        <p className="mb-4 text-xs text-slate-400">{results.length} 件</p>
      )}

      {/* 結果一覧 */}
      <div className="space-y-4">
        {results.map((r) => {
          const isOpen = expanded.has(r.chunkId);
          return (
            <div
              key={r.chunkId}
              className="rounded-lg border border-slate-200 bg-white shadow-sm"
            >
              {/* ヘッダー */}
              <button
                className="w-full px-4 py-3 text-left"
                onClick={() => toggleExpand(r.chunkId)}
              >
                {/* Row 1: タイプ・アクセス修飾子バッジ */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${TYPE_BADGE[r.type] ?? TYPE_BADGE.file}`}>
                    {r.type}
                  </span>
                  {/* private / protected のみ表示（public はデフォルトのためノイズになるため省略） */}
                  {r.accessModifier && r.accessModifier !== 'public' && (
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${ACCESS_BADGE[r.accessModifier] ?? ''}`}>
                      {r.accessModifier}
                    </span>
                  )}
                </div>

                {/* Row 2: クラス名 # メソッド名 */}
                <div className="mt-1.5 font-mono text-sm font-semibold text-slate-800">
                  {r.className && <span className="text-slate-500">{r.className}</span>}
                  {r.className && r.methodName && <span className="text-slate-400">#</span>}
                  {r.methodName && <span>{r.methodName}</span>}
                </div>

                {/* Row 3: ファイルパス · スコア */}
                <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-400">
                  <span className="font-mono">{r.filePath}:{r.startLine}</span>
                  <span>·</span>
                  <span>score: {r.rrfScore.toFixed(4)}</span>
                  {r.vectorDistance !== null && (
                    <>
                      <span>·</span>
                      <span>vec: {r.vectorDistance.toFixed(3)}</span>
                    </>
                  )}
                </div>

                {/* Row 4: docコメント */}
                {r.docComment && (
                  <p className="mt-1 text-xs text-slate-500 line-clamp-1">
                    {r.docComment}
                  </p>
                )}
              </button>

              {/* 展開: コード + 参照情報 */}
              {isOpen && (
                <div className="border-t border-slate-100 px-4 pb-4 pt-3">
                  <pre className="overflow-x-auto rounded bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
                    <code>{r.content}</code>
                  </pre>
                  {r.references && (
                    <ReferenceView
                      references={r.references}
                      className={r.className}
                      methodName={r.methodName}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
