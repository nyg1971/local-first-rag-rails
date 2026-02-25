export type ChunkType = 'method' | 'singleton_method' | 'class' | 'module' | 'file';
export type AccessModifier = 'public' | 'private' | 'protected';

export interface Chunk {
  id: string;
  content: string;
  filePath: string;
  startLine: number;
  endLine: number;
  type: ChunkType;
  className?: string;       // 例: Api::V1::PaymentService
  methodName?: string;      // 例: cancel
  docComment?: string;      // メソッド直上のコメント
  accessModifier?: AccessModifier;
  calledMethods?: string[]; // このチャンク内で呼び出しているメソッド名
}

/** "ClassName#method" または "ClassName.method"（クラスメソッド） */
export interface MethodDefinition {
  id: string;
  filePath: string;
  className: string;
  methodName: string;
  startLine: number;
  accessModifier: AccessModifier;
  isClassMethod: boolean;
}

export interface MethodCall {
  callerId: string;          // "ClassName#methodName"
  calleeRaw: string;         // 生テキスト: "order.update!" や "CancelMailer.notify"
  resolvedCallee?: string;   // 解決できた場合: "Order#update!"
  filePath: string;
  line: number;
}

export interface Association {
  sourceClass: string;
  type:
    | 'belongs_to'
    | 'has_many'
    | 'has_one'
    | 'has_and_belongs_to_many'
    | 'include'
    | 'extend'
    | 'prepend';
  target: string;
  filePath: string;  // 削除時の連鎖削除に使用
}

export interface IndexResult {
  chunks: Chunk[];
  definitions: MethodDefinition[];
  calls: MethodCall[];
  associations: Association[];
}

export interface WalkOptions {
  scope?: string[];   // 対象に絞るディレクトリ（相対パス）
  exclude?: string[]; // 除外するディレクトリ（相対パス）
}
