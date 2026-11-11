import type { MarketStore } from './market/store.ts';
import { istDate } from './market/time.ts';
import { shouldBlock, type NewsService, type NewsSummary } from './news/news.ts';
import type { Pattern } from './trading/patterns.ts';
import { vwap } from './trading/indicators.ts';
import { qualityReject, type QualityRules } from './trading/quality.ts';

export interface Pick {
  symbol: string;
  ltp: number;
  changePct: number;
  aboveVwap?: boolean;
  signals: Array<{ pattern: string; reason: string; score: number; stopPct: number }>;
  news?: { score: number; resultsSoon: boolean; headlines: Array<{ title: string; source: string; link: string; ts: number }> };
  verdict: 'buy' | 'watch' | 'avoid';
  /** Plain words: why this verdict */
  why: string;
  score: number;
}

/**
 * Today's best ideas in the chosen list: shares where a pattern fires right now, plus the biggest movers to watch.
 * News is only fetched for the top few (it is slow and cached).
 */
export async function buildPicks(deps: {
  store: MarketStore;
  patterns: Pattern[];
  news?: NewsService;
  maxDayMovePct: number;
  /** Same entry checks the auto trader uses, so a Buy idea here is one it would really take */
  quality?: QualityRules;
  limit?: number;
}): Promise<Pick[]> {
  const limit = deps.limit ?? 8;
  const today = istDate();
  const rows: Pick[] = [];
  const rejectedWhy = new Map<string, string>();
  for (const q of deps.store.allQuotes()) {
    if (q.prevClose <= 0) continue;
    const changePct = ((q.ltp - q.prevClose) / q.prevClose) * 100;
    const candles = deps.store.candlesFor(q.symbol);
    const fired = deps.patterns.map((p) => p.check(q, candles)).filter((s): s is NonNullable<typeof s> => !!s);
    const rejects = deps.quality ? fired.map((s) => qualityReject(q, candles, s, deps.quality!)) : [];
    if (rejects.length && rejects.every((r) => r !== undefined)) rejectedWhy.set(q.symbol, rejects[0]!);
    const signals = fired
      .filter((_, i) => rejects[i] === undefined)
      .map((s) => ({ pattern: s.pattern, reason: s.reason, score: s.score, stopPct: s.stopPct }));
    const dayCandles = candles.filter((c) => istDate(c.t) === today);
    const v = vwap(dayCandles);
    rows.push({
      symbol: q.symbol,
      ltp: q.ltp,
      changePct: Math.round(changePct * 100) / 100,
      aboveVwap: v === undefined ? undefined : q.ltp >= v,
      signals,
      verdict: 'watch',
      why: '',
      score: signals.length ? Math.max(...signals.map((s) => s.score)) : Math.max(0, Math.round(changePct * 5)),
    });
  }
  const withSignal = rows.filter((r) => r.signals.length > 0);
  const movers = rows.filter((r) => r.signals.length === 0 && r.changePct >= 2).sort((a, b) => b.changePct - a.changePct);
  const top = [...withSignal.sort((a, b) => b.score - a.score), ...movers].slice(0, limit);

  await Promise.all(
    top.map(async (p) => {
      const n: NewsSummary | undefined = await deps.news?.get(p.symbol);
      if (n) p.news = { score: n.score, resultsSoon: n.resultsSoon, headlines: n.items.map((i) => ({ title: i.title, source: i.source, link: i.link, ts: i.ts })) };
      const blocked = n ? shouldBlock(n) : undefined;
      const tooFast = Math.abs(p.changePct) > deps.maxDayMovePct;
      if (blocked) {
        p.verdict = 'avoid';
        p.why = `Skip: ${blocked}`;
      } else if (tooFast) {
        p.verdict = 'avoid';
        p.why = `Skip: already moved ${p.changePct}% today (limit ${deps.maxDayMovePct}%)`;
      } else if (p.signals.length && p.aboveVwap !== false) {
        p.verdict = 'buy';
        p.why = `${p.signals[0].reason}${n ? `; news score ${n.score}` : '; news not available'}`;
        if (n) p.score = Math.max(0, Math.min(100, p.score + n.score * 5));
      } else if (p.signals.length) {
        p.why = 'Pattern fired but price is below today\'s average price (VWAP). Waiting.';
      } else if (rejectedWhy.has(p.symbol)) {
        p.why = `Pattern fired but skipped: ${rejectedWhy.get(p.symbol)}`;
      } else {
        p.why = `Up ${p.changePct}% but no entry pattern yet. Watching.`;
      }
    }),
  );
  const order = { buy: 0, watch: 1, avoid: 2 } as const;
  return top.sort((a, b) => order[a.verdict] - order[b.verdict] || b.score - a.score);
}
