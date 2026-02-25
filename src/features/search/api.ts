import type { SearchResponse } from '@/types/api';

export async function search(
  serverUrl: string,
  query: string,
  topK = 10,
): Promise<SearchResponse> {
  const res = await fetch(`${serverUrl}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, topK, includeRefs: true }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error ?? res.statusText);
  }

  return res.json() as Promise<SearchResponse>;
}

export async function checkHealth(serverUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
