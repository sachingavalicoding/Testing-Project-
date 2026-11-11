import type { Db } from '../db/db.ts';
import type { MarketStore } from '../market/store.ts';
import { istDate } from '../market/time.ts';
import { shouldBlock, type NewsService } from '../news/news.ts';
import type { AppSettings } from '../settings.ts';
import type { Position } from '../trading/autoTrader.ts';
import { exitAdvice } from './exitHelp.ts';
import { dayBlocks, phaseAt, readMarket, type MarketRead, type Phase } from './guards.ts';
import { learnStats, type SavedPick } from './learn.ts';
import { buildPlan } from './plan.ts';
import { buildWatchlist } from './premarket.ts';
import { scoreStock } from './score.ts';
import { SETUP_LABELS, type DailyInfo, type ExitAlert, type ScannerPick, type Setup, type WatchItem } from './types.ts';

export interface ScannerDeps {
  store: Pick<MarketStore, 'allQuotes' | 'quote' | 'candlesFor'>;
  db: Db;
  news?: Pick<NewsService, 'get'>;
  settings: () => AppSettings;
  trader: { positions: Map<string, Position>; realizedToday: number; unrealized(): number };
  squareOffTime: () => string;
  /** Changes when the share list changes, so the watchlist is rebuilt */
  listKey: () => string;
  now?: () => number;
}

export interface ScannerState {
  enabled: boolean;
  asOf?: number;
  phase?: Phase;
  phaseText?: string;
  market?: MarketRead;
  /** Reasons no entries are allowed right now (choppy market, loss limit). Empty when entries are allowed */
  blocks?: string[];
  /** True when there is nothing to buy right now: this is the answer, not a failure */
  noTrade?: boolean;
  noTradeWhy?: string[];
  watchlist?: Array<WatchItem & { liveScore?: number; setup?: Setup }>;
  watchNote?: string;
  picks?: ScannerPick[];
  /** Shares that scored well but were left out, with the reason */
  skipped?: Array<{ symbol: string; score: number; why: string }>;
  disabledSetups?: Setup[];
}

/** Finds the few best intraday trades now and gives a full plan for each. Does nothing unless switched on. */
export class ScannerService {
  daily = new Map<string, DailyInfo>();
  private watch?: { day: string; list: string; items: WatchItem[]; builtAt: number; frozen: boolean };
  private cache?: { ts: number; state: ScannerState };
  private readonly now: () => number;

  constructor(private readonly d: ScannerDeps) {
    this.now = d.now ?? Date.now;
  }

  setDaily(m: Map<string, DailyInfo>): void {
    this.daily = m;
    this.watch = undefined;
    this.cache = undefined;
  }

  private async ensureWatchlist(phase: Phase): Promise<void> {
    const s = this.d.settings().scanner;
    const now = this.now();
    const day = istDate(now);
    const list = this.d.listKey();
    const w = this.watch;
    const stale = !w || w.day !== day || w.list !== list || (!w.frozen && phase === 'pre-open' && now - w.builtAt > 60_000) || (!w.frozen && phase !== 'pre-open');
    if (!stale) return;
    const items = await buildWatchlist(this.d.store.allQuotes(), this.daily, s, async (symbol) => {
      const n = await this.d.news?.get(symbol);
      return n ? { score: n.score, resultsSoon: n.resultsSoon, headline: n.items[0]?.title } : undefined;
    });
    // From the open on, the list is fixed for the day (it is the "day's watchlist"), unless the share list changes.
    this.watch = { day, list, items, builtAt: now, frozen: phase !== 'pre-open' };
  }

  async state(): Promise<ScannerState> {
    const settings = this.d.settings();
    const s = settings.scanner;
    if (!s.enabled) return { enabled: false };
    if (this.cache && this.now() - this.cache.ts < 10_000) return this.cache.state;

    const now = this.now();
    const quotes = this.d.store.allQuotes();
    const { phase, text } = phaseAt(now, s);
    const market = readMarket(quotes, s);
    await this.ensureWatchlist(phase);
    const items = this.watch?.items ?? [];

    const stats = this.stats();
    const disabled = stats?.off ?? [];
    const lossToday = this.d.trader.realizedToday + this.d.trader.unrealized();
    const blocks = dayBlocks({ market, settings: s, lossToday, dailyLossCap: settings.dailyLossCap });

    const picks: ScannerPick[] = [];
    const skipped: Array<{ symbol: string; score: number; why: string }> = [];
    const watchlist: ScannerState['watchlist'] = [];
    let bestScore = 0;
    for (const item of items) {
      const q = this.d.store.quote(item.symbol);
      if (!q || (phase !== 'scanning' && phase !== 'closed' && phase !== 'waiting')) {
        watchlist.push(item);
        continue;
      }
      const candles = this.d.store.candlesFor(item.symbol);
      const sc = scoreStock({ q, candles, daily: this.daily.get(item.symbol), marketPct: market.medianPct });
      watchlist.push({ ...item, ltp: q.ltp, liveScore: Math.round(sc.score), setup: sc.setup });
      bestScore = Math.max(bestScore, sc.score);
      if (phase !== 'scanning' || sc.score < s.minScore) continue;

      const plan = buildPlan(q, candles, s);
      if ('reason' in plan) {
        skipped.push({ symbol: item.symbol, score: Math.round(sc.score), why: `No plan: ${plan.reason}` });
        continue;
      }
      let blocked: string | undefined;
      if (s.requireVolume && (sc.volumeRatio === undefined || sc.volumeRatio < s.minVolumeRatio)) {
        blocked =
          sc.volumeRatio === undefined
            ? 'No volume surge to confirm it: not enough candles yet'
            : `Thin volume: the last 5 minutes are only ${sc.volumeRatio}x the day's earlier average (you require ${s.minVolumeRatio}x)`;
      } else if (disabled.includes(sc.setup)) blocked = `Setup "${SETUP_LABELS[sc.setup]}" is turned off: it keeps losing for you`;
      else if (s.blockAveraging && this.d.trader.positions.has(item.symbol)) blocked = 'You already hold this share (no averaging down)';
      else if (s.blockNearNews && this.d.news) {
        const n = await this.d.news.get(item.symbol);
        const why = n ? shouldBlock(n) : undefined;
        if (why) blocked = `Near big news: ${why}`;
      }
      if (blocked) {
        skipped.push({ symbol: item.symbol, score: Math.round(sc.score), why: blocked });
        continue;
      }
      const top = sc.parts.filter((p) => p.points > 0).sort((a, b) => b.points - a.points);
      picks.push({
        symbol: item.symbol,
        ltp: q.ltp,
        changePct: q.prevClose > 0 ? Math.round(((q.ltp - q.prevClose) / q.prevClose) * 10_000) / 100 : 0,
        score: Math.round(sc.score),
        setup: sc.setup,
        setupLabel: SETUP_LABELS[sc.setup],
        parts: sc.parts,
        plan: plan.plan,
        reasons: top.map((p) => `${p.label} ${p.points}/${p.max}: ${p.note}`),
      });
    }
    picks.sort((a, b) => b.score - a.score);
    const shown = blocks.length ? [] : picks;

    const noTradeWhy: string[] = [];
    if (phase === 'scanning' && shown.length === 0) {
      noTradeWhy.push(...blocks);
      if (!blocks.length) {
        noTradeWhy.push(
          bestScore > 0
            ? `No share on the watchlist scores ${s.minScore} or more (best is ${Math.round(bestScore)}). Waiting is a valid trade.`
            : `No share on the watchlist scores ${s.minScore} or more. Waiting is a valid trade.`,
        );
      }
    }

    // Save what was shown so your results can be matched to it later.
    for (const p of shown) {
      this.d.db.addScannerPick({
        day: istDate(now), ts: now, symbol: p.symbol, setup: p.setup, score: p.score,
        entry: p.plan.entryHigh, stop: p.plan.stop, target1: p.plan.target1, target2: p.plan.target2, qty: p.plan.qty,
        plan: JSON.stringify({ plan: p.plan, parts: p.parts }),
      });
    }

    const state: ScannerState = {
      enabled: true,
      asOf: now,
      phase,
      phaseText: text,
      market,
      blocks,
      noTrade: phase === 'scanning' ? shown.length === 0 : undefined,
      noTradeWhy,
      watchlist,
      watchNote: this.daily.size
        ? 'Before 09:15 the price shown is the last traded price (the indicated open); the list is refreshed each minute and fixed once the market opens.'
        : "Yesterday's high, low and volume are not loaded (mock feed, or not fetched yet), so those parts score nothing.",
      picks: shown,
      skipped,
      disabledSetups: disabled,
    };
    this.cache = { ts: now, state };
    return state;
  }

  /** Advice for each open position. Off unless exit help is switched on. */
  exitHelp(): { enabled: boolean; items: Array<{ symbol: string; entry: number; ltp: number; qty: number; stop: number; alerts: ExitAlert[] }> } {
    const s = this.d.settings().scanner;
    if (!s.enabled || !s.exitHelp) return { enabled: false, items: [] };
    const items = [];
    for (const p of this.d.trader.positions.values()) {
      if (p.side === 'short') continue; // the advice below is written for longs; shorts are watched by their own stop and target
      const q = this.d.store.quote(p.symbol);
      if (!q) continue;
      const alerts = exitAdvice(p, q, this.d.store.candlesFor(p.symbol), s, this.d.squareOffTime());
      items.push({ symbol: p.symbol, entry: p.entry, ltp: q.ltp, qty: p.qty, stop: p.stop, alerts });
    }
    return { enabled: true, items };
  }

  stats() {
    const s = this.d.settings().scanner;
    if (!s.enabled) return undefined;
    const picks: SavedPick[] = this.d.db.scannerPicks().map((r) => ({ id: r.id, day: r.day, ts: r.ts, symbol: r.symbol, setup: r.setup as Setup, score: r.score }));
    return learnStats(picks, this.d.db.allTrades(), s);
  }
}
