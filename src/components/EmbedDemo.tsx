import { useState } from 'react';
import { embed } from '@/features/embed/gemma';
import { Button } from '@/components/ui/button';

export default function EmbedDemo() {
    const [status,setStatus] = useState<'idle'|'loading'|'done'|'error'>('idle');
    const [dims,setDims] = useState<number|null>(null);


    const run = async () => {
        try {
            setStatus('loading');
            const vecs = await embed(['こんにちは、世界！','秋の葉っぱ']);
            setDims(vecs[0].length);
            setStatus('done');
            console.log('Embedding sample:', Array.from(vecs[0].slice(0,8)));
        } catch(e){ console.error(e); setStatus('error'); }
    };


    return (
        <div className="space-y-3">
            <div className="text-sm text-slate-600">
                {status==='idle'&&'準備OK：ボタンでモデルをロードして埋め込みを計算します。'}
                {status==='loading'&&'モデル読込中…（初回は数百MB）'}
                {status==='done'&&`成功！次元数:${dims}`}
                {status==='error'&&'エラーが出ました。コンソールを確認してください。'}
            </div>
            <Button onClick={run}>埋め込みを試す</Button>
        </div>
    );
}