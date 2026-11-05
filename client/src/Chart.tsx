import { useEffect, useRef, useState } from 'react';
import { CandlestickSeries, createChart, type IChartApi, type UTCTimestamp } from 'lightweight-charts';
import { get, type Candle } from './api.ts';

const IST = 5.5 * 3600;

export default function Chart({ symbol }: { symbol: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [interval, setInterval_] = useState<'1minute' | 'day'>('1minute');
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!box.current) return;
    const chart: IChartApi = createChart(box.current, {
      height: 320,
      layout: { background: { color: '#020617' }, textColor: '#cbd5e1' },
      grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
      timeScale: { timeVisible: interval === '1minute' },
      autoSize: true,
    });
    const series = chart.addSeries(CandlestickSeries, { upColor: '#22c55e', downColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444', borderVisible: false });
    let alive = true;
    const load = () =>
      get<Candle[]>(`/api/candles/${encodeURIComponent(symbol)}?interval=${interval}`)
        .then((cs) => {
          if (!alive) return;
          setError(undefined);
          series.setData(cs.map((c) => ({ time: (Math.floor(c.t / 1000) + IST) as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c })));
        })
        .catch((e: Error) => alive && setError(e.message));
    void load();
    const timer = window.setInterval(load, interval === '1minute' ? 5000 : 60000);
    return () => {
      alive = false;
      window.clearInterval(timer);
      chart.remove();
    };
  }, [symbol, interval]);

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-lg font-semibold">{symbol}</span>
        {(['1minute', 'day'] as const).map((i) => (
          <button key={i} onClick={() => setInterval_(i)}
            className={`rounded px-2 py-1 text-xs ${interval === i ? 'bg-sky-600' : 'bg-slate-800'}`}>
            {i === '1minute' ? '1 min' : 'Daily'}
          </button>
        ))}
      </div>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      <div ref={box} className="w-full" />
    </div>
  );
}
