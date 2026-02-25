import type { ReferenceInfo } from '@/types/api';

interface Props {
  references: ReferenceInfo;
  className?: string | null;
  methodName?: string | null;
}

export function ReferenceView({ references, className, methodName }: Props) {
  const { callers, callees, associations } = references;
  const hasAny = callers.length > 0 || callees.length > 0 || associations.length > 0;

  if (!hasAny) return null;

  return (
    <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-xs">
      <p className="mb-2 font-semibold text-slate-500">
        参照情報
        {className && methodName && (
          <span className="ml-1 font-normal text-slate-400">
            ({className}#{methodName})
          </span>
        )}
      </p>

      {callers.length > 0 && (
        <div className="mb-2">
          <p className="mb-1 text-slate-500">呼び出し元</p>
          <ul className="space-y-0.5">
            {callers.map((c, i) => (
              <li key={i} className="font-mono text-blue-700">
                {c.caller_id}
                <span className="ml-1 text-slate-400">({c.file_path}:{c.line})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {callees.length > 0 && (
        <div className="mb-2">
          <p className="mb-1 text-slate-500">呼び出し先</p>
          <ul className="space-y-0.5">
            {callees.map((c, i) => (
              <li key={i} className="font-mono text-emerald-700">
                {c.callee_raw}
              </li>
            ))}
          </ul>
        </div>
      )}

      {associations.length > 0 && (
        <div>
          <p className="mb-1 text-slate-500">アソシエーション</p>
          <ul className="flex flex-wrap gap-1.5">
            {associations.map((a, i) => (
              <li
                key={i}
                className="rounded bg-violet-100 px-2 py-0.5 font-mono text-violet-800"
              >
                {a.type} {a.target}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
