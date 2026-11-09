import { useEffect, useState } from 'react';
import { get, type Pick } from './api.ts';

const badge = { buy: 'bg-green-700', watch: 'bg-slate-700', avoid: 'bg-red-800' } as const;
const label = { buy: 'Buy idea', watch: 'Watch', avoid: 'Avoid' } as const;

export default function Picks({ onPick }: { onPick: (s: string) => void }) {
  const [picks, setPicks] = useState<Pick[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let alive = true;
    const load = () => get<Pick[]>('/api/picks').then((p) => alive && (setPicks(p), setError(undefined))).catch((e: Error) => alive && setError(e.message));
    void load();
    const t = setInterval(load, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (error) return <p className="text-red-400">{error}</p>;
  if (!picks) return <p className="text-slate-400">Looking for ideas…</p>;
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">
        Ideas from the chosen share list, refreshed every 15 seconds. News is a hint from headlines, not a promise. The auto trader uses the same checks.
      </p>
      {picks.length === 0 && <p className="text-slate-400">No ideas right now. Patterns need some minutes of prices after the market opens.</p>}
      {picks.map((p) => (
        <section key={p.symbol} className="rounded-lg bg-slate-900 p-3 text-sm">
          <div className="flex items-center justify-between" onClick={() => onPick(p.symbol)}>
            <span className="font-semibold">{p.symbol} <span className="num text-slate-400">{p.ltp.toFixed(2)}</span></span>
            <span className="flex items-center gap-2">
              <span className={`num ${p.changePct >= 0 ? 'text-green-400' : 'text-red-400'}`}>{p.changePct > 0 ? '+' : ''}{p.changePct}%</span>
              <span className={`rounded px-2 py-0.5 text-xs font-bold ${badge[p.verdict]}`}>{label[p.verdict]}</span>
            </span>
          </div>
          <div className="mt-1 text-slate-300">{p.why}</div>
          <div className="mt-1 text-xs text-slate-500">
            Score {p.score}
            {p.aboveVwap !== undefined && ` · ${p.aboveVwap ? 'above' : 'below'} today's average price`}
            {p.news && ` · news ${p.news.score > 0 ? '+' : ''}${p.news.score}${p.news.resultsSoon ? ' · results soon' : ''}`}
          </div>
          {p.news?.headlines.slice(0, 3).map((h) => (
            <a key={h.link || h.title} href={h.link} target="_blank" rel="noreferrer" className="mt-1 block truncate text-xs text-sky-400">
              {h.title}
            </a>
          ))}
        </section>
      ))}
    </div>
  );
}
