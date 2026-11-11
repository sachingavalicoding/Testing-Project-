import type { Quote } from '../types.ts';
import { istMinutes, MARKET_OPEN } from '../market/time.ts';
import type { DailyInfo, ScannerSettings, WatchItem } from './types.ts';
import { clamp, round2 } from './util.ts';

export interface NewsHint {
  score: number;
  resultsSoon: boolean;
  headline?: string;
}

/** The % the share opened (or, before 09:15, is indicated) away from yesterday's close. */
export function gapPct(q: Quote): number {
  if (q.prevClose <= 0) return 0;
  const price = istMinutes(q.ts) >= MARKET_OPEN && q.open > 0 ? q.open : q.ltp;
  return ((price - q.prevClose) / q.prevClose) * 100;
}

type Base = Omit<WatchItem, 'score' | 'why' | 'newsScore' | 'newsHeadline'>;

/** First pass (before news is fetched): gap 30, yesterday's volume 25, distance to yesterday's high 25. Out of 80. */
export function baseScore(q: Quote, daily: DailyInfo | undefined, volumeRank: number | undefined): { points: number; why: string[]; item: Base } {
  const gap = gapPct(q);
  const why: string[] = [];
  let points = 0;

  points += Math.round(clamp(gap / 2, 0, 1) * 30);
  why.push(gap > 0 ? `gapped up ${gap.toFixed(2)}%` : `gap ${gap.toFixed(2)}%`);

  if (daily && volumeRank !== undefined) {
    points += Math.round(volumeRank * 25);
    why.push(`yesterday's volume ${Math.round(daily.prevVolume).toLocaleString('en-IN')} (top ${Math.max(1, Math.round((1 - volumeRank) * 100))}% of the list)`);
  } else why.push("yesterday's volume not available");

  let fromHigh: number | undefined;
  let fromLow: number | undefined;
  if (daily && daily.prevHigh > 0 && daily.prevLow > 0) {
    fromHigh = ((q.ltp - daily.prevHigh) / daily.prevHigh) * 100;
    fromLow = ((q.ltp - daily.prevLow) / daily.prevLow) * 100;
    // best when sitting just under or just over yesterday's high: a breakout is close
    if (fromHigh >= -0.7 && fromHigh <= 1) {
      points += 25;
      why.push(fromHigh >= 0 ? `trading ${fromHigh.toFixed(2)}% above yesterday's high` : `${Math.abs(fromHigh).toFixed(2)}% under yesterday's high: breakout is close`);
    } else if (fromHigh > 1) {
      points += 8;
      why.push(`already ${fromHigh.toFixed(2)}% above yesterday's high`);
    } else why.push(`${Math.abs(fromHigh).toFixed(2)}% under yesterday's high`);
    if (fromLow <= 0.5) points = Math.max(0, points - 10); // sitting on yesterday's low: weak
  } else why.push("yesterday's high and low not available");

  return {
    points,
    why,
    item: {
      symbol: q.symbol,
      ltp: q.ltp,
      gapPct: round2(gap),
      prevVolume: daily?.prevVolume,
      fromPrevHighPct: fromHigh === undefined ? undefined : round2(fromHigh),
      fromPrevLowPct: fromLow === undefined ? undefined : round2(fromLow),
    },
  };
}

/**
 * The day's watchlist: liquid shares ranked by gap, yesterday's volume, news and distance to yesterday's high.
 * News is asked only for the best few of the first pass. Bad news drops a share when the news block is on.
 */
export async function buildWatchlist(
  quotes: Quote[],
  daily: Map<string, DailyInfo>,
  s: ScannerSettings,
  news?: (symbol: string) => Promise<NewsHint | undefined>,
): Promise<WatchItem[]> {
  const vols = quotes.map((q) => daily.get(q.symbol)?.prevVolume).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
  const rank = (v: number | undefined) => (v === undefined || vols.length < 2 ? undefined : vols.filter((x) => x <= v).length / vols.length);

  const first = quotes
    .filter((q) => q.prevClose > 0)
    .map((q) => ({ q, b: baseScore(q, daily.get(q.symbol), rank(daily.get(q.symbol)?.prevVolume)) }))
    .sort((a, b) => b.b.points - a.b.points)
    .slice(0, Math.max(s.watchlistSize * 3, 20));

  const items: WatchItem[] = [];
  for (const { q, b } of first) {
    const why = [...b.why];
    let points = b.points;
    let newsScore: number | undefined;
    let headline: string | undefined;
    if (news) {
      const n = await news(q.symbol);
      if (n) {
        newsScore = n.score;
        headline = n.headline;
        if (s.blockNearNews && (n.score <= -2 || n.resultsSoon)) continue; // never put a share with bad or results news on the list
        if (n.score > 0) {
          points += Math.min(20, n.score * 8);
          why.push(`good news today${n.headline ? `: ${n.headline}` : ''}`);
        } else why.push('no news edge');
      } else why.push('news not available');
    }
    items.push({ ...b.item, newsScore, newsHeadline: headline, score: Math.round(points), why });
  }
  return items.sort((a, b) => b.score - a.score).slice(0, s.watchlistSize);
}
