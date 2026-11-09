import { useEffect, useRef, useState } from 'react';
import { get, type Quote } from './api.ts';

type Sort = 'name' | 'gain' | 'loss';

export default function Watchlist({ symbol, onSelect, held }: { symbol: string; onSelect: (s: string) => void; held: Set<string> }) {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [text, setText] = useState('');
  const [sort, setSort] = useState<Sort>('name');
  const [found, setFound] = useState<{ symbol: string; ltp?: number }[]>([]);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const load = () => get<Quote[]>('/api/quotes').then((q) => alive && setQuotes(q)).catch(() => undefined);
    void load();
    const t = setInterval(load, 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Search ALL shares (not only the chosen list) after a short pause in typing.
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (text.trim().length < 2) { setFound([]); return; }
    timer.current = window.setTimeout(() => {
      get<{ symbol: string; ltp?: number }[]>(`/api/search?q=${encodeURIComponent(text.trim())}`).then(setFound).catch(() => setFound([]));
    }, 250);
    return () => window.clearTimeout(timer.current);
  }, [text]);

  const pct = (q: Quote) => (q.prevClose > 0 ? ((q.ltp - q.prevClose) / q.prevClose) * 100 : 0);
  const filter = text.trim().toUpperCase();
  const rows = quotes
    .filter((q) => !filter || q.symbol.includes(filter))
    .sort((a, b) => (sort === 'name' ? a.symbol.localeCompare(b.symbol) : sort === 'gain' ? pct(b) - pct(a) : pct(a) - pct(b)));
  const listed = new Set(quotes.map((q) => q.symbol));
  const others = found.filter((f) => !listed.has(f.symbol));

  const pick = (s: string) => { onSelect(s); setText(''); };

  return (
    <div className="flex h-full flex-col rounded-lg bg-slate-900">
      <div className="p-2">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search any share, e.g. INFY"
          className="w-full rounded bg-slate-800 px-3 py-2 text-sm uppercase placeholder:normal-case" />
        <div className="mt-2 flex gap-1 text-xs">
          {([['name', 'A–Z'], ['gain', 'Gainers'], ['loss', 'Losers']] as [Sort, string][]).map(([k, l]) => (
            <button key={k} onClick={() => setSort(k)} className={`flex-1 rounded py-1 ${sort === k ? 'bg-sky-700' : 'bg-slate-800'}`}>{l}</button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {others.length > 0 && (
          <div className="border-t border-slate-800">
            <div className="px-3 py-1 text-xs text-slate-500">Other shares</div>
            {others.map((o) => (
              <button key={o.symbol} onClick={() => pick(o.symbol)} className="flex w-full justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-800">
                <span>{o.symbol}</span><span className="text-xs text-sky-400">open</span>
              </button>
            ))}
          </div>
        )}
        {rows.map((q) => {
          const p = pct(q);
          return (
            <button key={q.symbol} onClick={() => pick(q.symbol)}
              className={`flex w-full items-center justify-between border-t border-slate-800 px-3 py-1.5 text-left text-sm hover:bg-slate-800 ${q.symbol === symbol ? 'bg-slate-800' : ''}`}>
              <span>{held.has(q.symbol) && <span className="mr-1 text-sky-400">●</span>}{q.symbol}</span>
              <span className="num text-right">
                {q.ltp.toFixed(2)} <span className={`ml-1 text-xs ${p >= 0 ? 'text-green-400' : 'text-red-400'}`}>{p > 0 ? '+' : ''}{p.toFixed(2)}%</span>
              </span>
            </button>
          );
        })}
        {rows.length === 0 && others.length === 0 && <p className="p-3 text-sm text-slate-500">No shares match.</p>}
      </div>
    </div>
  );
}
