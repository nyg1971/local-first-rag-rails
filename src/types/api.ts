/** サーバーAPIの共有型定義 */

export interface ReferenceInfo {
  callers: Array<{ caller_id: string; file_path: string; line: number }>;
  callees: Array<{ callee_raw: string; file_path: string; line: number }>;
  associations: Array<{ type: string; target: string }>;
}

export interface SearchResultItem {
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
  rrfScore: number;
  vectorDistance: number | null;
  ftsScore: number | null;
  references?: ReferenceInfo;
}

export interface SearchResponse {
  query: string;
  results: SearchResultItem[];
}
