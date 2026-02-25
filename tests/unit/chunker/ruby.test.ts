import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkRubyFile } from '../../../cli/chunker/ruby.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../../fixtures/ruby');

describe('chunkRubyFile', () => {
  // ──────────────────────────────────────────────────────────────────
  // 基本的なクラスとメソッド
  // ──────────────────────────────────────────────────────────────────
  describe('基本的なクラスとメソッド', () => {
    it('クラス名とメソッド名を抽出する', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'basic.rb'), FIXTURES);
      const methodChunks = result.chunks.filter((c) => c.type === 'method');
      expect(methodChunks).toHaveLength(2);
      expect(methodChunks[0].className).toBe('User');
      expect(methodChunks[0].methodName).toBe('greet');
      expect(methodChunks[1].methodName).toBe('farewell');
    });

    it('メソッドチャンクの type が "method" である', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'basic.rb'), FIXTURES);
      const methodChunks = result.chunks.filter((c) => c.type === 'method');
      expect(methodChunks).toHaveLength(2);
      expect(methodChunks.every((c) => c.type === 'method')).toBe(true);
    });

    it('デフォルトのアクセス修飾子は public', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'basic.rb'), FIXTURES);
      const methodChunks = result.chunks.filter((c) => c.type === 'method');
      expect(methodChunks.every((c) => c.accessModifier === 'public')).toBe(true);
    });

    it('filePath が rootDir からの相対パスになっている', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'basic.rb'), FIXTURES);
      expect(result.chunks.every((c) => c.filePath === 'basic.rb')).toBe(true);
    });

    it('startLine と endLine が正しく設定される', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'basic.rb'), FIXTURES);
      const greet = result.chunks.find((c) => c.methodName === 'greet')!;
      expect(greet.startLine).toBeGreaterThan(0);
      expect(greet.endLine).toBeGreaterThanOrEqual(greet.startLine);
    });

    it('メソッド内の呼び出しを calledMethods に収集する', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'basic.rb'), FIXTURES);
      // farewell メソッドが say_goodbye を呼ぶ
      const farewell = result.chunks.find((c) => c.methodName === 'farewell');
      expect(farewell?.calledMethods).toContain('say_goodbye');
    });

    it('メソッド定義インデックスが生成される', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'basic.rb'), FIXTURES);
      expect(result.definitions).toHaveLength(2);
      expect(result.definitions[0].id).toBe('User#greet');
      expect(result.definitions[1].id).toBe('User#farewell');
    });

    it('呼び出しインデックスが生成される', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'basic.rb'), FIXTURES);
      // farewell が say_goodbye を呼ぶ → calls に記録される
      const call = result.calls.find((c) => c.calleeRaw === 'say_goodbye');
      expect(call).toBeDefined();
      expect(call?.callerId).toBe('User#farewell');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // クラスメソッド（singleton_method）
  // ──────────────────────────────────────────────────────────────────
  describe('クラスメソッド（singleton_method）', () => {
    it('def self.xxx が singleton_method タイプになる', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'class_method.rb'), FIXTURES);
      const classMethod = result.chunks.find((c) => c.type === 'singleton_method');
      expect(classMethod).toBeDefined();
      expect(classMethod?.methodName).toBe('find_by_email');
    });

    it('インスタンスメソッドは method タイプになる', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'class_method.rb'), FIXTURES);
      const instanceMethod = result.chunks.find((c) => c.type === 'method');
      expect(instanceMethod).toBeDefined();
      expect(instanceMethod?.methodName).toBe('instance_method');
    });

    it('クラスメソッドの定義 ID がドット区切りになる', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'class_method.rb'), FIXTURES);
      const def = result.definitions.find((d) => d.isClassMethod);
      expect(def?.id).toBe('User.find_by_email');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // アクセス修飾子
  // ──────────────────────────────────────────────────────────────────
  describe('アクセス修飾子', () => {
    it('private 宣言前のメソッドは public', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'access_modifiers.rb'), FIXTURES);
      const method = result.chunks.find((c) => c.methodName === 'public_action');
      expect(method?.accessModifier).toBe('public');
    });

    it('private 宣言後のメソッドは private', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'access_modifiers.rb'), FIXTURES);
      const method = result.chunks.find((c) => c.methodName === 'secret_action');
      expect(method?.accessModifier).toBe('private');
    });

    it('protected 宣言後のメソッドは protected', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'access_modifiers.rb'), FIXTURES);
      const method = result.chunks.find((c) => c.methodName === 'guarded_action');
      expect(method?.accessModifier).toBe('protected');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Rails アソシエーション
  // ──────────────────────────────────────────────────────────────────
  describe('Rails アソシエーション', () => {
    it('belongs_to が抽出され、ターゲットが PascalCase になる', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'associations.rb'), FIXTURES);
      const assoc = result.associations.find((a) => a.type === 'belongs_to');
      expect(assoc).toMatchObject({ sourceClass: 'Order', target: 'User' });
    });

    it('has_many が抽出され、ターゲットが PascalCase になる', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'associations.rb'), FIXTURES);
      const assoc = result.associations.find((a) => a.type === 'has_many');
      expect(assoc).toMatchObject({ sourceClass: 'Order', target: 'OrderItems' });
    });

    it('has_one が抽出される', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'associations.rb'), FIXTURES);
      const assoc = result.associations.find((a) => a.type === 'has_one');
      expect(assoc).toMatchObject({ sourceClass: 'Order', target: 'Invoice' });
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Mixin (include / extend)
  // ──────────────────────────────────────────────────────────────────
  describe('Mixin (include / extend)', () => {
    it('include が抽出される', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'associations.rb'), FIXTURES);
      const mixin = result.associations.find((a) => a.type === 'include');
      expect(mixin).toMatchObject({ sourceClass: 'Order', target: 'Searchable' });
    });

    it('extend が抽出される', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'associations.rb'), FIXTURES);
      const mixin = result.associations.find((a) => a.type === 'extend');
      expect(mixin).toMatchObject({ sourceClass: 'Order', target: 'ClassMethods' });
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // ドキュメントコメント
  // ──────────────────────────────────────────────────────────────────
  describe('ドキュメントコメント', () => {
    it('メソッド直前の連続コメントが docComment に入る', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'doc_comments.rb'), FIXTURES);
      const method = result.chunks.find((c) => c.methodName === 'formatted_title');
      expect(method?.docComment).toContain('Returns the post title formatted');
      expect(method?.docComment).toContain('for display purposes');
    });

    it('コメントがないメソッドは docComment が undefined', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'doc_comments.rb'), FIXTURES);
      const method = result.chunks.find((c) => c.methodName === 'body_text');
      expect(method?.docComment).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // ネストしたクラス
  // ──────────────────────────────────────────────────────────────────
  describe('ネストしたクラス', () => {
    it('className が "::" 区切りになる', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'nested.rb'), FIXTURES);
      const method = result.chunks.find((c) => c.type === 'method');
      expect(method?.className).toBe('Api::V1::UsersController');
    });

    it('ネストしたクラス内のメソッドが抽出される', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'nested.rb'), FIXTURES);
      const method = result.chunks.find((c) => c.type === 'method');
      expect(method?.methodName).toBe('index');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // クラス概要チャンク
  // ──────────────────────────────────────────────────────────────────
  describe('クラス概要チャンク', () => {
    it('クラスヘッダーを含む class チャンクが生成される', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'basic.rb'), FIXTURES);
      const classChunk = result.chunks.find((c) => c.type === 'class');
      expect(classChunk).toBeDefined();
      expect(classChunk?.content).toContain('class User < ApplicationRecord');
      expect(classChunk?.className).toBe('User');
    });

    it('DSL 宣言が class チャンクの content に含まれる', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'associations.rb'), FIXTURES);
      const classChunk = result.chunks.find((c) => c.type === 'class');
      expect(classChunk).toBeDefined();
      expect(classChunk?.content).toContain('belongs_to :user');
      expect(classChunk?.content).toContain('has_many :order_items');
      expect(classChunk?.content).toContain('include Searchable');
    });

    it('DSL のみのクラスも class チャンク 1 つを生成する', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'associations.rb'), FIXTURES);
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].type).toBe('class');
    });

    it('module は type が "module" の概要チャンクを生成する', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'nested.rb'), FIXTURES);
      const moduleChunk = result.chunks.find((c) => c.type === 'module');
      expect(moduleChunk).toBeDefined();
      expect(moduleChunk?.className).toBe('Api::V1');
    });

    it('メソッドボディは class チャンクの content に含まれない', async () => {
      const result = await chunkRubyFile(resolve(FIXTURES, 'basic.rb'), FIXTURES);
      const classChunk = result.chunks.find((c) => c.type === 'class');
      expect(classChunk?.content).not.toContain('def greet');
      expect(classChunk?.content).not.toContain('def farewell');
    });
  });
});
