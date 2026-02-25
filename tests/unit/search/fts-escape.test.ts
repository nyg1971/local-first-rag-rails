import { describe, it, expect } from 'vitest';
import { escapeFtsQuery } from '../../../server/search.ts';

describe('escapeFtsQuery', () => {
  describe('基本的なトークン化', () => {
    it('英単語を小文字化してスペース区切りで返す', () => {
      expect(escapeFtsQuery('Hello World')).toBe('hello world');
    });

    it('複数スペースは 1 トークンとして扱われる', () => {
      expect(escapeFtsQuery('cancel  payment')).toBe('cancel payment');
    });

    it('空文字列を渡すと空文字列を返す', () => {
      expect(escapeFtsQuery('')).toBe('');
    });

    it('空白のみを渡すと空文字列を返す', () => {
      expect(escapeFtsQuery('   ')).toBe('');
    });
  });

  describe('特殊文字の除去', () => {
    it('FTS5 の特殊文字 " * ^ ( ) が除去される', () => {
      expect(escapeFtsQuery('"cancel"')).toBe('cancel');
      expect(escapeFtsQuery('pay*ment')).toBe('payment');
      expect(escapeFtsQuery('(refund)')).toBe('refund');
    });

    it('特殊文字のみのトークンは結果から除かれる', () => {
      expect(escapeFtsQuery('cancel * payment')).toBe('cancel payment');
    });

    it('アンダースコアは保持される', () => {
      expect(escapeFtsQuery('cancel_payment')).toBe('cancel_payment');
    });
  });

  describe('日本語対応', () => {
    it('日本語文字（ひらがな・漢字）はそのまま保持される', () => {
      expect(escapeFtsQuery('キャンセル処理')).toBe('キャンセル処理');
    });

    it('日本語と英語の混在クエリを処理できる', () => {
      expect(escapeFtsQuery('cancel キャンセル')).toBe('cancel キャンセル');
    });
  });
});
