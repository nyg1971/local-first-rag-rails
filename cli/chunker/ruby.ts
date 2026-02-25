import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Chunk,
  MethodDefinition,
  MethodCall,
  Association,
  IndexResult,
  AccessModifier,
} from '../types.ts';

// tree-sitter は CJS モジュールのため createRequire 経由でインポート
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const Parser = require('tree-sitter');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const Ruby = require('tree-sitter-ruby');

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
const parser = new Parser();
// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
parser.setLanguage(Ruby);

// tree-sitter SyntaxNode の最低限の型定義
interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
  parent: SyntaxNode | null;
}

const RAILS_ASSOCIATIONS = new Set([
  'belongs_to',
  'has_many',
  'has_one',
  'has_and_belongs_to_many',
]);

const MIXIN_METHODS = new Set(['include', 'extend', 'prepend']);

const ACCESS_MODIFIERS = new Set(['private', 'protected', 'public']);

/**
 * Rubyファイルをパースし、チャンク・定義・呼び出し・アソシエーションを返す
 */
export async function chunkRubyFile(filePath: string, rootDir: string): Promise<IndexResult> {
  const source = await readFile(filePath, 'utf-8');
  const relPath = relative(rootDir, filePath);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const tree = parser.parse(source) as { rootNode: SyntaxNode };

  const chunks: Chunk[] = [];
  const definitions: MethodDefinition[] = [];
  const calls: MethodCall[] = [];
  const associations: Association[] = [];

  // ルートから再帰的に処理
  const sourceLines = source.split('\n');
  processNode(tree.rootNode, []);

  return { chunks, definitions, calls, associations };

  // ────────────────────────────────────────────────────────────────────
  // ノード処理
  // ────────────────────────────────────────────────────────────────────

  function processNode(node: SyntaxNode, classStack: string[]): void {
    switch (node.type) {
      case 'class':
      case 'module':
        processClassOrModule(node, classStack);
        break;
      default:
        // トップレベルのメソッドなど
        for (const child of node.children) {
          processNode(child, classStack);
        }
    }
  }

  /**
   * class / module ノードを処理する。
   * ① クラス/モジュール宣言 + DSL行（belongs_to, enum, validates, include 等）を
   *    1チャンクとして先に追加する（クラス名でのセマンティック検索を可能にするため）。
   * ② body_statement の子を順に走査してアクセス修飾子を追跡しながら
   *    メソッドチャンク・参照インデックスを構築する。
   */
  function processClassOrModule(node: SyntaxNode, classStack: string[]): void {
    const nameNode = node.childForFieldName('name');
    const className = nameNode?.text ?? 'Unknown';
    const fullName = [...classStack, className].join('::');

    const bodyNode = node.childForFieldName('body');
    if (!bodyNode) return;

    const bodyChildren = bodyNode.children;
    let currentAccess: AccessModifier = 'public';

    // ── ① クラス/モジュール 概要チャンク ──
    // クラス宣言ヘッダー + DSL 行（メソッド・ネストを除く）を content に含める
    {
      const superclassNode = node.childForFieldName('superclass');
      const headerLine =
        node.type === 'module'
          ? `module ${className}`
          : superclassNode
            ? `class ${className} ${superclassNode.text}`
            : `class ${className}`;

      const dslLines: string[] = [headerLine];
      for (const child of bodyChildren) {
        if (
          child.type === 'method' ||
          child.type === 'singleton_method' ||
          child.type === 'class' ||
          child.type === 'module'
        ) continue;
        const text = child.text.trim();
        if (text) dslLines.push(text);
      }

      chunks.push({
        id: randomUUID(),
        content: dslLines.join('\n'),
        filePath: relPath,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        type: node.type === 'module' ? 'module' : 'class',
        className: fullName,
        accessModifier: 'public',
        calledMethods: [],
      });
    }

    // ── ② メソッド・ネスト・参照インデックスの処理 ──
    for (let i = 0; i < bodyChildren.length; i++) {
      const child = bodyChildren[i];

      // アクセス修飾子の更新（standalone: private / protected / public）
      if (child.type === 'identifier' && ACCESS_MODIFIERS.has(child.text)) {
        currentAccess = child.text as AccessModifier;
        continue;
      }

      // インスタンスメソッド
      if (child.type === 'method') {
        const docComment = getPrecedingComments(sourceLines, child.startPosition.row);
        processMethod(child, fullName, false, currentAccess, docComment);
        continue;
      }

      // クラスメソッド (def self.xxx)
      if (child.type === 'singleton_method') {
        const docComment = getPrecedingComments(sourceLines, child.startPosition.row);
        processMethod(child, fullName, true, currentAccess, docComment);
        continue;
      }

      // ネストした class / module
      if (child.type === 'class' || child.type === 'module') {
        processClassOrModule(child, [...classStack, className]);
        continue;
      }

      // Rails DSL / Mixin
      if (child.type === 'call') {
        processCall(child, fullName);
      }
    }
  }

  /**
   * method / singleton_method ノードをチャンク化し、
   * 定義・呼び出しインデックスを更新する
   */
  function processMethod(
    node: SyntaxNode,
    className: string,
    isClassMethod: boolean,
    accessModifier: AccessModifier,
    docComment: string | undefined,
  ): void {
    const nameNode = node.childForFieldName('name');
    const methodName = nameNode?.text ?? 'unknown';
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const defId = `${className}${isClassMethod ? '.' : '#'}${methodName}`;

    // 呼び出しているメソッドを抽出
    const calledMethods = extractCalledMethods(node);

    // チャンク
    const chunk: Chunk = {
      id: randomUUID(),
      content: node.text,
      filePath: relPath,
      startLine,
      endLine,
      type: isClassMethod ? 'singleton_method' : 'method',
      className,
      methodName,
      docComment,
      accessModifier,
      calledMethods,
    };
    chunks.push(chunk);

    // メソッド定義インデックス
    definitions.push({
      id: defId,
      filePath: relPath,
      className,
      methodName,
      startLine,
      accessModifier,
      isClassMethod,
    });

    // 呼び出しインデックス
    for (const calleeRaw of calledMethods) {
      calls.push({
        callerId: defId,
        calleeRaw,
        filePath: relPath,
        line: startLine,
      });
    }
  }

  /**
   * call ノードから Rails DSL / Mixin を抽出する
   */
  function processCall(node: SyntaxNode, className: string): void {
    const methodNode = node.childForFieldName('method');
    const methodName = methodNode?.text;
    if (!methodName) return;

    const argsNode = node.childForFieldName('arguments');
    const firstArg = argsNode?.children.find(
      (c) => c.type !== '(' && c.type !== ')' && c.type !== ',',
    );
    if (!firstArg) return;

    // Rails アソシエーション
    if (RAILS_ASSOCIATIONS.has(methodName)) {
      const target = firstArg.text.replace(/^:/, '');
      associations.push({
        sourceClass: className,
        type: methodName as Association['type'],
        target: snakeToPascal(target),
        filePath: relPath,
      });
      return;
    }

    // Mixin (include / extend / prepend)
    if (MIXIN_METHODS.has(methodName)) {
      associations.push({
        sourceClass: className,
        type: methodName as Association['type'],
        target: firstArg.text,
        filePath: relPath,
      });
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// ユーティリティ
// ────────────────────────────────────────────────────────────────────

/**
 * メソッドの開始行（0-indexed row）の直前にある
 * 連続したコメント行をソーステキストから取得して返す。
 *
 * tree-sitter@0.20+ では comment (extra) ノードが node.children に
 * 含まれなくなったため、ソーステキストを直接参照する方式に変更。
 */
function getPrecedingComments(lines: string[], startRow: number): string | undefined {
  const comments: string[] = [];
  let i = startRow - 1;
  while (i >= 0) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('#')) {
      comments.unshift(lines[i]);
      i--;
    } else {
      break;
    }
  }
  return comments.length > 0 ? comments.join('\n') : undefined;
}

/**
 * メソッドノード内の call ノードを再帰的に収集し、
 * 呼び出しメソッド名の一覧（重複なし）を返す
 */
function extractCalledMethods(node: SyntaxNode): string[] {
  const result = new Set<string>();

  function collect(n: SyntaxNode): void {
    if (n.type === 'call') {
      const method = n.childForFieldName('method');
      const receiver = n.childForFieldName('receiver');
      if (method) {
        const callStr = receiver ? `${receiver.text}.${method.text}` : method.text;
        result.add(callStr);
      }
    }
    for (const child of n.children) {
      collect(child);
    }
  }

  collect(node);
  return [...result];
}

/** snake_case → PascalCase 変換（アソシエーションのターゲット名解決用） */
function snakeToPascal(str: string): string {
  return str
    .split('_')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}
