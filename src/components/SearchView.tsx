import { useState, useRef } from 'react';
import { search, checkHealth } from '@/features/search/api';
import { ReferenceView } from './ReferenceView';
import type { SearchResultItem } from '@/types/api';

type Status = 'idle' | 'checking' | 'ready' | 'searching' | 'error';

function buildServerUrl(port: string): string {
  const p = port.trim() || '3001';
  return `http://localhost:${p}`;
}

// タイプ別カラー（インラインスタイル用）
const TYPE_BORDER_COLOR: Record<string, string> = {
  method:           '#60a5fa', // blue-400
  singleton_method: '#818cf8', // indigo-400
  class:            '#c084fc', // purple-400
  module:           '#a78bfa', // violet-400
};
const TYPE_BADGE_BG: Record<string, string> = {
  method:           '#eff6ff',
  singleton_method: '#eef2ff',
  class:            '#faf5ff',
  module:           '#f5f3ff',
};
const TYPE_BADGE_COLOR: Record<string, string> = {
  method:           '#2563eb',
  singleton_method: '#4f46e5',
  class:            '#9333ea',
  module:           '#7c3aed',
};

function IconSearch({ size = 24, style = {} }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg style={{ width: size, height: size, minWidth: size, ...style }}
      xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
    </svg>
  );
}

function IconFolder() {
  return (
    <svg style={{ width: 12, height: 12, minWidth: 12, color: '#94a3b8' }}
      xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
    </svg>
  );
}

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg style={{ width: 16, height: 16, minWidth: 16, color: '#94a3b8', transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none' }}
      xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" />
    </svg>
  );
}

export function SearchView() {
  const [status, setStatus]       = useState<Status>('idle');
  const [port, setPort]           = useState('3001');
  const [serverUrl, setServerUrl] = useState('');
  const [query, setQuery]         = useState('');
  const [results, setResults]     = useState<SearchResultItem[]>([]);
  const [errorMsg, setErrorMsg]   = useState('');
  const [expanded, setExpanded]   = useState<Set<string>>(new Set());
  const [searched, setSearched]   = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const handleSearch = async () => {
    if (!query.trim()) return;
    setStatus('searching');
    setResults([]);
    setExpanded(new Set());
    setSearched(false);
    try {
      const res = await search(serverUrl, query.trim());
      setResults(res.results);
      setSearched(true);
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

  // ── 接続前 ────────────────────────────────────────────────
  if (status === 'idle' || status === 'checking') {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        backgroundColor: '#f8fafc',
      }}>
        <div style={{ width: '100%', maxWidth: '384px' }}>

          {/* ロゴ */}
          <div style={{ textAlign: 'center', marginBottom: '40px' }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 64, height: 64, borderRadius: 16, backgroundColor: '#6366f1',
              marginBottom: 20, boxShadow: '0 10px 25px rgba(99,102,241,0.25)',
            }}>
              <IconSearch size={32} style={{ color: 'white' }} />
            </div>
            <h1 style={{ margin: 0, fontSize: '1.875rem', fontWeight: 700, color: '#0f172a', letterSpacing: '-0.02em' }}>
              local-first-rag
            </h1>
            <p style={{ margin: '8px 0 0', fontSize: '0.875rem', color: '#64748b' }}>
              Railsコードベース検索ツール
            </p>
          </div>

          {/* 接続フォーム */}
          <div style={{
            padding: '24px',
            borderRadius: 16,
            backgroundColor: 'white',
            border: '1px solid #e2e8f0',
            boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
          }}>
            <label style={{
              display: 'block', fontSize: '0.75rem', fontWeight: 500,
              color: '#64748b', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>
              サーバーポート
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: '0.875rem', color: '#64748b', whiteSpace: 'nowrap' }}>localhost:</span>
              <input
                type="text"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                placeholder="3001"
                style={{
                  width: 72, padding: '8px 12px', fontSize: '0.875rem',
                  color: '#0f172a', backgroundColor: '#f8fafc',
                  border: '1px solid #e2e8f0', borderRadius: 8, outline: 'none',
                }}
              />
              <button
                onClick={handleConnect}
                disabled={status === 'checking'}
                style={{
                  flex: 1, padding: '8px 16px', fontSize: '0.875rem', fontWeight: 500,
                  color: 'white', backgroundColor: '#6366f1', border: 'none',
                  borderRadius: 8, cursor: 'pointer', opacity: status === 'checking' ? 0.6 : 1,
                }}
              >
                {status === 'checking' ? '接続確認中...' : 'サーバーに接続'}
              </button>
            </div>
          </div>

        </div>
      </div>
    );
  }

  // ── エラー ────────────────────────────────────────────────
  if (status === 'error') {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px',
        backgroundColor: '#f8fafc',
      }}>
        <div style={{ width: '100%', maxWidth: '384px', textAlign: 'center' }}>
          <p style={{ color: '#ef4444', fontSize: '0.875rem', whiteSpace: 'pre-line', marginBottom: 24 }}>{errorMsg}</p>
          <button
            onClick={() => setStatus('idle')}
            style={{
              padding: '8px 20px', fontSize: '0.875rem', color: '#64748b',
              backgroundColor: 'white', border: '1px solid #e2e8f0',
              borderRadius: 8, cursor: 'pointer',
            }}
          >
            戻る
          </button>
        </div>
      </div>
    );
  }

  // ── 検索UI ────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f8fafc' }}>

      {/* ヘッダー */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 10,
        backgroundColor: 'white', borderBottom: '1px solid #e2e8f0',
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
      }}>
        <div style={{
          maxWidth: 896, margin: '0 auto', padding: '0 24px',
          height: 56, display: 'flex', alignItems: 'center', gap: 16,
        }}>

          {/* ロゴ */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: 8, backgroundColor: '#6366f1',
            }}>
              <IconSearch size={14} style={{ color: 'white' }} />
            </div>
            <span style={{ fontWeight: 600, color: '#1e293b', fontSize: '0.875rem' }}>local-first-rag</span>
          </div>

          {/* 検索バー */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="クラス名・メソッド名・処理の概要で検索できます"
              style={{
                flex: 1, padding: '6px 12px', fontSize: '0.875rem', color: '#1e293b',
                backgroundColor: '#f8fafc', border: '1px solid #e2e8f0',
                borderRadius: 8, outline: 'none',
              }}
            />
            <button
              onClick={handleSearch}
              disabled={status === 'searching'}
              style={{
                flexShrink: 0, padding: '6px 16px', fontSize: '0.875rem', fontWeight: 500,
                color: 'white', backgroundColor: '#6366f1', border: 'none',
                borderRadius: 8, cursor: 'pointer', opacity: status === 'searching' ? 0.6 : 1,
              }}
            >
              {status === 'searching' ? '検索中...' : '検索'}
            </button>
          </div>

          {/* 接続情報 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.75rem', color: '#94a3b8' }}>
              <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', backgroundColor: '#34d399' }} />
              {serverUrl}
            </span>
            <button
              style={{ fontSize: '0.75rem', color: '#475569', background: 'none', border: 'none', cursor: 'pointer' }}
              onClick={() => { setStatus('idle'); setResults([]); }}
            >
              切断
            </button>
          </div>

        </div>
      </header>

      {/* メインコンテンツ */}
      <main style={{ maxWidth: 896, margin: '0 auto', padding: '24px 24px' }}>

        {results.length > 0 && (
          <p style={{ marginBottom: 16, fontSize: '0.75rem', color: '#94a3b8', fontWeight: 500 }}>
            {results.length} 件
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {results.map((r) => {
            const isOpen = expanded.has(r.chunkId);
            const borderColor = TYPE_BORDER_COLOR[r.type] ?? '#cbd5e1';
            const badgeBg    = TYPE_BADGE_BG[r.type]    ?? '#f1f5f9';
            const badgeColor = TYPE_BADGE_COLOR[r.type] ?? '#64748b';
            return (
              <div
                key={r.chunkId}
                style={{
                  borderRadius: 12, border: '1px solid #e2e8f0', backgroundColor: 'white',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                  borderLeft: `4px solid ${borderColor}`, overflow: 'hidden',
                }}
              >
                <button
                  style={{ width: '100%', padding: '14px 16px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer' }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f8fafc')}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  onClick={() => toggleExpand(r.chunkId)}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>

                      {/* バッジ行 */}
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <span style={{
                          padding: '2px 6px', fontSize: '0.75rem', fontWeight: 500,
                          borderRadius: 6, backgroundColor: badgeBg, color: badgeColor,
                        }}>
                          {r.type}
                        </span>
                        {r.accessModifier && r.accessModifier !== 'public' && (
                          <span style={{
                            padding: '2px 6px', fontSize: '0.75rem', fontWeight: 500, borderRadius: 6,
                            backgroundColor: r.accessModifier === 'private' ? '#fef2f2' : '#fefce8',
                            color:           r.accessModifier === 'private' ? '#ef4444' : '#ca8a04',
                          }}>
                            {r.accessModifier}
                          </span>
                        )}
                      </div>

                      {/* クラス#メソッド */}
                      <div style={{ fontFamily: 'monospace', fontSize: '0.875rem', fontWeight: 600 }}>
                        {r.className  && <span style={{ color: '#475569' }}>{r.className}</span>}
                        {r.className && r.methodName && <span style={{ color: '#cbd5e1' }}>#</span>}
                        {r.methodName && <span style={{ color: '#1e293b' }}>{r.methodName}</span>}
                        {!r.className && !r.methodName && <span style={{ color: '#64748b' }}>—</span>}
                      </div>

                      {/* ファイルパス */}
                      <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'monospace', fontSize: '0.75rem', color: '#64748b' }}>
                        <IconFolder />
                        <span>{r.filePath}:{r.startLine}</span>
                      </div>

                      {r.docComment && (
                        <p style={{ marginTop: 4, fontSize: '0.75rem', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r.docComment}
                        </p>
                      )}

                    </div>
                    <IconChevron open={isOpen} />
                  </div>
                </button>

                {isOpen && (
                  <div style={{ borderTop: '1px solid #f1f5f9', padding: '12px 16px 16px' }}>
                    <pre style={{
                      overflowX: 'auto', borderRadius: 8, backgroundColor: '#0f172a',
                      padding: 16, fontSize: '0.75rem', lineHeight: 1.6, color: '#e2e8f0', margin: 0,
                    }}>
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

        {status === 'ready' && searched && results.length === 0 && (
          <div style={{ textAlign: 'center', padding: '80px 0', color: '#94a3b8' }}>
            <IconSearch size={40} style={{ color: '#cbd5e1', display: 'block', margin: '0 auto 12px' }} />
            <p style={{ fontSize: '0.875rem', margin: 0 }}>「{query}」に一致する結果が見つかりませんでした</p>
          </div>
        )}

      </main>
    </div>
  );
}
