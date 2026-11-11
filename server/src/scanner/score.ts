import type { Candle, Quote } from '../types.ts';
import { istMinutes, MARKET_OPEN } from '../market/time.ts';
import { ema, rsi, sma, vwap } from '../trading/indicators.ts';
import type { DailyInfo, ScorePart, ScoreResult, Setup } from './types.ts';
import { aggregate, clamp, closedToday, macdHist, round2 } from './util.ts';

export interface ScoreInput {
  q: Quote;
  /** All 1-minute candles we have for the share (today's are picked out) */
  candles: Candle[];
  daily?: DailyInfo;
  /** Median share's % change today in the list: the stand-in for "the market" */
  marketPct?: number;
}

/**
 * Score a share out of 100 for a long intraday entry right now. Only real prices and volumes are used;
 * a part with not enough data gets 0 points and says so.
 *  - trend 30: above VWAP 12, EMA9 above EMA21 9, 15-minute trend up 9
 *  - volume 20: last 5 minutes against the day's earlier average (1x = 0, 2x or more = full)
 *  - breakout 20: above the opening range high 10, above yesterday's high 10 (half when within 0.15% below)
 *  - momentum 15: RSI 55 to 72 gives 8, MACD histogram above zero 4 and rising 3
 *  - strength 15: how much better than the market's median share today (1% better or more = full)
 */
export function scoreStock({ q, candles, daily, marketPct }: ScoreInput): ScoreResult {
  const now = q.ts;
  const done = closedToday(candles, now);
  const parts: ScorePart[] = [];

  // ---- trend (30)
  const closes = done.map((c) => c.c);
  const v = vwap(done);
  let trend = 0;
  const notes: string[] = [];
  if (v !== undefined && q.ltp > v) {
    trend += 12;
    notes.push(`above VWAP ${v.toFixed(2)}`);
  } else if (v !== undefined) notes.push(`below VWAP ${v.toFixed(2)}`);
  if (closes.length >= 22) {
    const n = closes.length - 1;
    const e9 = ema(closes, 9)[n];
    const e21 = ema(closes, 21)[n];
    if (e9 > e21) {
      trend += 9;
      notes.push('EMA9 above EMA21');
    } else notes.push('EMA9 below EMA21');
  } else notes.push('too early for EMA9/21');
  const fifteen = aggregate(done, 15);
  // the last 15-minute candle may still be forming: judge only completed ones
  const completed15 = fifteen.filter((c) => c.t + 15 * 60_000 <= Math.floor(now / 60_000) * 60_000);
  if (completed15.length >= 3) {
    const c15 = completed15.map((c) => c.c);
    const m = c15.length - 1;
    if (c15[m] > c15[m - 1] && c15[m] > ema(c15, 5)[m]) {
      trend += 9;
      notes.push('15-minute trend up');
    } else notes.push('15-minute trend not up');
  } else notes.push('15-minute trend needs more time');
  parts.push({ key: 'trend', label: 'Trend', points: trend, max: 30, note: notes.join(', ') });

  // ---- volume surge (20)
  let volPts = 0;
  let volNote = 'not enough candles yet';
  let volumeRatio: number | undefined;
  if (done.length >= 15) {
    const recent = done.slice(-5).map((c) => c.v);
    const earlier = done.slice(0, -5).map((c) => c.v);
    const recentAvg = sma(recent, recent.length) ?? 0;
    const earlierAvg = sma(earlier, earlier.length) ?? 0;
    if (earlierAvg > 0) {
      const ratio = recentAvg / earlierAvg;
      volumeRatio = ratio;
      volPts = Math.round(clamp(ratio - 1, 0, 1) * 20);
      volNote = `last 5 minutes ${ratio.toFixed(1)}x the day's earlier average`;
    }
  }
  parts.push({ key: 'volume', label: 'Volume surge', points: volPts, max: 20, note: volNote });

  // ---- breakout (20)
  let brk = 0;
  const bn: string[] = [];
  let orb = false;
  let pdh = false;
  const mins = istMinutes(now);
  const range = done.filter((c) => istMinutes(c.t) >= MARKET_OPEN && istMinutes(c.t) < MARKET_OPEN + 15);
  if (mins >= MARKET_OPEN + 15 && range.length >= 10) {
    const orh = Math.max(...range.map((c) => c.h));
    if (q.ltp > orh) {
      brk += 10;
      orb = true;
      bn.push(`above the opening range high ${orh.toFixed(2)}`);
    } else if (q.ltp >= orh * 0.9985) {
      brk += 5;
      bn.push(`just under the opening range high ${orh.toFixed(2)}`);
    } else bn.push(`below the opening range high ${orh.toFixed(2)}`);
  } else bn.push('opening range not finished');
  if (daily && daily.prevHigh > 0) {
    if (q.ltp > daily.prevHigh) {
      brk += 10;
      pdh = true;
      bn.push(`above yesterday's high ${daily.prevHigh.toFixed(2)}`);
    } else if (q.ltp >= daily.prevHigh * 0.9985) {
      brk += 5;
      bn.push(`just under yesterday's high ${daily.prevHigh.toFixed(2)}`);
    } else bn.push(`below yesterday's high ${daily.prevHigh.toFixed(2)}`);
  } else bn.push("yesterday's high not available");
  parts.push({ key: 'breakout', label: 'Breakout', points: brk, max: 20, note: bn.join(', ') });

  // ---- momentum (15)
  let mom = 0;
  const mn: string[] = [];
  const strength = rsi(closes, 14);
  if (strength !== undefined) {
    if (strength >= 55 && strength <= 72) mom += 8;
    mn.push(`RSI ${strength.toFixed(0)}`);
  } else mn.push('RSI needs more candles');
  const macd = macdHist(closes);
  if (macd) {
    if (macd.hist > 0) mom += 4;
    if (macd.hist > macd.prev) mom += 3;
    mn.push(`MACD ${macd.hist > 0 ? 'positive' : 'negative'}${macd.hist > macd.prev ? ' and rising' : ''}`);
  } else mn.push('MACD needs more candles');
  parts.push({ key: 'momentum', label: 'Momentum', points: mom, max: 15, note: mn.join(', ') });

  // ---- strength against the market (15)
  let rs = 0;
  let rsNote = 'market reading not available';
  if (marketPct !== undefined && q.prevClose > 0) {
    const day = ((q.ltp - q.prevClose) / q.prevClose) * 100;
    const diff = day - marketPct;
    rs = Math.round(clamp(diff, 0, 1) * 15);
    rsNote = `${day.toFixed(2)}% today against the market's ${marketPct.toFixed(2)}%`;
  }
  parts.push({ key: 'strength', label: 'Strength vs market', points: rs, max: 15, note: rsNote });

  const score = parts.reduce((s, p) => s + p.points, 0);
  const setup: Setup = orb ? 'orb' : pdh ? 'pdh' : volPts >= 10 ? 'volume' : 'trend';
  return { score: round2(score), parts, setup, volumeRatio: volumeRatio === undefined ? undefined : round2(volumeRatio) };
}
