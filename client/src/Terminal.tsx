import { useEffect, useMemo, useState } from 'react';
import { get, post, rupee, type Quote, type Status } from './api.ts';
import BottomPanel from './BottomPanel.tsx';
import Chart, { TIMEFRAMES, type Indicators, type Timeframe } from './Chart.tsx';
import OrderTicket from './OrderTicket.tsx';
import Watchlist from './Watchlist.tsx';

const KEY = 'stockiq.chart';

export default function Terminal({ symbol, setSymbol, status }: { symbol: string; setSymbol: (s: string) => void; status?: Status }) {
  const saved = useMemo(() => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; } }, []);
  const [tf, setTf] = useState<Timeframe>(saved.tf ?? '5m');
  const [ind, setInd] = useState<Indicators>(saved.ind ?? { ema9: true, ema21: true, vwap: true, volume: true });
  const [quote, setQuote] = useState<Quote>();
  const [showList, setShowList] = useState(false);

  useEffect(() => { localStorage.setItem(KEY, JSON.stringify({ tf, ind })); }, [tf, ind]);

  // Make sure the server follows this share (it may be outside the chosen list), then keep its price fresh.
  useEffect(() => {
    let alive = true;
    setQuote(undefined);
    void post('/api/watch', { symbol }).catch(() => undefined);
    const load = () => get<Quote[]>('/api/quotes').then((qs) => alive && setQuote(qs.find((q) => q.symbol === symbol))).catch(() => undefined);
    void load();
    const t = setInterval(load, 1500);
    return () => { alive = false; clearInterval(t); };
  }, [symbol]);

  const held = useMemo(() => new Set((status?.positions ?? []).map((p) => p.symbol)), [status?.positions]);
  const position = status?.positions.find((p) => p.symbol === symbol);
  const chg = quote && quote.prevClose > 0 ? ((quote.ltp - quote.prevClose) / quote.prevClose) * 100 : undefined;
  const toggle = (k: keyof Indicators) => setInd({ ...ind, [k]: !ind[k] });

  return (
    <div className="grid gap-2 lg:grid-cols-[250px_minmax(0,1fr)_310px]">
      <div className={`order-3 lg:order-1 lg:h-[calc(100vh-110px)] ${showList ? '' : 'hidden lg:block'}`}>
        <Watchlist symbol={symbol} held={held} onSelect={(s) => { setSymbol(s); setShowList(false); window.scrollTo({ top: 0 }); }} />
      </div>

      <div className="order-1 min-w-0 space-y-2 lg:order-2">
        <div className="rounded-lg bg-slate-900">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-800 px-3 py-2">
            <span className="text-lg font-bold">{symbol}</span>
            <span className="num text-lg">{quote ? quote.ltp.toFixed(2) : '…'}</span>
            {chg !== undefined && <span className={`num text-sm ${chg >= 0 ? 'text-green-400' : 'text-red-400'}`}>{chg > 0 ? '+' : ''}{chg.toFixed(2)}%</span>}
            {quote && <span className="num hidden text-xs text-slate-400 sm:inline">O {quote.open} · H {quote.high} · L {quote.low} · PC {quote.prevClose}</span>}
            <button className="ml-auto rounded bg-slate-800 px-3 py-1 text-xs lg:hidden" onClick={() => setShowList(!showList)}>{showList ? 'Hide list' : 'Watchlist'}</button>
          </div>
          <div className="flex flex-wrap items-center gap-1 border-b border-slate-800 px-2 py-1.5 text-xs">
            {TIMEFRAMES.map((t) => (
              <button key={t} onClick={() => setTf(t)} className={`rounded px-2 py-1 ${tf === t ? 'bg-sky-700' : 'bg-slate-800'}`}>{t}</button>
            ))}
            <span className="mx-1 text-slate-600">|</span>
            {([['ema9', 'EMA 9'], ['ema21', 'EMA 21'], ['vwap', 'VWAP'], ['volume', 'Volume']] as [keyof Indicators, string][]).map(([k, l]) => (
              <button key={k} onClick={() => toggle(k)} className={`rounded px-2 py-1 ${ind[k] ? 'bg-slate-700 text-slate-100' : 'bg-slate-800 text-slate-500'}`}>{l}</button>
            ))}
            {position && <span className="ml-auto num text-slate-400">Holding {position.qty} · P&L <span className={position.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>{rupee(position.pnl)}</span></span>}
          </div>
          <div className="h-[48vh] min-h-[320px] lg:h-[calc(100vh-390px)]">
            <Chart symbol={symbol} tf={tf} ind={ind} position={position} />
          </div>
        </div>
        <BottomPanel status={status} onSelect={setSymbol} />
      </div>

      <div className="order-2 lg:order-3"><OrderTicket symbol={symbol} quote={quote} status={status} /></div>
    </div>
  );
}
