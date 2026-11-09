import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries, HistogramSeries, LineSeries, LineStyle, createChart,
  type IChartApi, type IPriceLine, type ISeriesApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { get, type Candle, type Position } from './api.ts';
import { aggregate, ema, vwapSeries } from './indicators.ts';

export type Timeframe = '1m' | '5m' | '15m' | '1h' | 'D';
export const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', 'D'];
export interface Indicators { ema9: boolean; ema21: boolean; vwap: boolean; volume: boolean }

const IST = 5.5 * 3600;
const MINUTES: Record<Timeframe, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, D: 0 };
const UP = '#26a69a';
const DOWN = '#ef5350';

function timeOf(t: number, tf: Timeframe): Time {
  if (tf === 'D') return new Date(t + IST * 1000).toISOString().slice(0, 10);
  return (Math.floor(t / 1000) + IST) as UTCTimestamp;
}

export default function Chart({ symbol, tf, ind, position }: { symbol: string; tf: Timeframe; ind: Indicators; position?: Position }) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | undefined>(undefined);
  const series = useRef<
    | {
        candle: ISeriesApi<'Candlestick'>; vol: ISeriesApi<'Histogram'>;
        ema9: ISeriesApi<'Line'>; ema21: ISeriesApi<'Line'>; vwap: ISeriesApi<'Line'>;
      }
    | undefined
  >(undefined);
  const lines = useRef<IPriceLine[]>([]);
  const fitted = useRef('');
  const [raw, setRaw] = useState<Candle[]>([]);
  const [error, setError] = useState<string>();

  // Build the chart once.
  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: '#131722' }, textColor: '#b2b5be' },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      rightPriceScale: { borderColor: '#2a2e39' },
      timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    const candle = chart.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false });
    const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const line = (color: string) => chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    series.current = { candle, vol, ema9: line('#f5a623'), ema21: line('#4c9aff'), vwap: line('#b388ff') };
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = undefined; series.current = undefined; lines.current = []; };
  }, []);

  // Load candles for this share and timeframe, then keep them fresh.
  useEffect(() => {
    let alive = true;
    setRaw([]);
    setError(undefined);
    const interval = tf === 'D' ? 'day' : '1minute';
    const days = tf === 'D' ? 250 : tf === '1m' ? 2 : 5;
    const load = () =>
      get<Candle[]>(`/api/candles/${encodeURIComponent(symbol)}?interval=${interval}&days=${days}`)
        .then((c) => { if (alive) { setRaw(c); setError(undefined); } })
        .catch((e: Error) => alive && setError(e.message));
    void load();
    const timer = window.setInterval(load, tf === 'D' ? 60_000 : 3_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [symbol, tf]);

  // Draw.
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const candles = tf === 'D' ? raw : aggregate(raw, MINUTES[tf]);
    s.candle.setData(candles.map((c) => ({ time: timeOf(c.t, tf), open: c.o, high: c.h, low: c.l, close: c.c })));
    s.vol.setData(ind.volume ? candles.map((c) => ({ time: timeOf(c.t, tf), value: c.v, color: c.c >= c.o ? '#26a69a55' : '#ef535055' })) : []);
    const closes = candles.map((c) => c.c);
    s.ema9.setData(ind.ema9 ? ema(closes, 9).map((v, i) => ({ time: timeOf(candles[i].t, tf), value: v })) : []);
    s.ema21.setData(ind.ema21 ? ema(closes, 21).map((v, i) => ({ time: timeOf(candles[i].t, tf), value: v })) : []);
    const vw = tf === 'D' || !ind.vwap ? [] : vwapSeries(candles).flatMap((v, i) => (v === undefined ? [] : [{ time: timeOf(candles[i].t, tf), value: v }]));
    s.vwap.setData(vw);
    const key = `${symbol}|${tf}`;
    if (candles.length && fitted.current !== key) {
      fitted.current = key;
      chartRef.current?.timeScale().fitContent();
      if (candles.length > 120) chartRef.current?.timeScale().setVisibleLogicalRange({ from: candles.length - 120, to: candles.length + 5 });
    }
  }, [raw, tf, ind, symbol]);

  // Entry / stop / target lines for an open position in this share.
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    lines.current.forEach((l) => s.candle.removePriceLine(l));
    lines.current = [];
    if (!position) return;
    const add = (price: number, color: string, title: string) =>
      lines.current.push(s.candle.createPriceLine({ price, color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title }));
    add(position.entry, '#4c9aff', `Buy ${position.qty}`);
    add(position.stop, DOWN, 'Stop');
    if (position.target) add(position.target, UP, 'Target');
  }, [position?.entry, position?.stop, position?.target, position?.qty, symbol, raw.length > 0]);

  return (
    <div className="relative h-full min-h-[320px]">
      {error && <div className="absolute left-2 top-2 z-10 rounded bg-red-900/70 px-2 py-1 text-xs">{error}</div>}
      <div ref={box} className="absolute inset-0" />
    </div>
  );
}
