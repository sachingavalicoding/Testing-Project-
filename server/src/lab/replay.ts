import { PaperBroker } from '../broker/paperBroker.ts';
import { Db } from '../db/db.ts';
import { MarketStore } from '../market/store.ts';
import { istMinutes } from '../market/time.ts';
import type { AppSettings } from '../settings.ts';
import { AutoTrader } from '../trading/autoTrader.ts';
import { applySettingsToTrader } from '../trading/configure.ts';
import { PATTERNS } from '../trading/patterns.ts';
import type { Candle, Quote } from '../types.ts';

export interface DayData {
  day: string;
  symbols: Map<string, { prevClose: number; candles: Candle[] }>;
}

/** The ticks inside one minute, in seconds: the open, the two extremes (in the order the candle moved) and the close. */
const TICK_SECONDS = [1, 20, 40, 58];

/**
 * Replays one saved day through the SAME AutoTrader the live app uses (same patterns, checks, stops and targets), in its own
 * memory-only database, so nothing live is touched. The clock is the candle clock: the trader only ever sees what it would
 * have seen at that moment.
 */
export class ReplayRun {
  readonly db = new Db(':memory:');
  readonly store: MarketStore;
  readonly trader: AutoTrader;
  /** Epoch ms of the replay clock */
  clock: number;
  private readonly minutes: number[];
  private index = 0;
  private readonly cum = new Map<string, number>();
  private readonly hi = new Map<string, number>();
  private readonly lo = new Map<string, number>();
  private readonly byMinute = new Map<number, Array<{ symbol: string; c: Candle }>>();
  private readonly dayOpen = new Map<string, number>();

  constructor(
    readonly data: DayData,
    settings: AppSettings,
    opts: { squareOffTime?: string; universe?: 'large' | 'mid' | 'small'; scanGapMs?: number } = {},
  ) {
    for (const [symbol, e] of data.symbols) {
      for (const c of e.candles) {
        let list = this.byMinute.get(c.t);
        if (!list) this.byMinute.set(c.t, (list = []));
        list.push({ symbol, c });
      }
    }
    this.minutes = [...this.byMinute.keys()].sort((a, b) => a - b);
    this.clock = this.minutes[0] ?? Date.now();
    this.store = new MarketStore(600);
    const paperBroker = new PaperBroker((s) => this.store.quote(s)?.ltp, undefined, 5);
    this.trader = new AutoTrader({
      rules: {
        capital: settings.paperCash,
        dailyLossCap: settings.dailyLossCap,
        maxOpenPositions: 5,
        riskPerTrade: 500,
        maxDayMovePct: 3,
        squareOffTime: opts.squareOffTime ?? '15:15',
      },
      db: this.db,
      store: this.store,
      paperBroker,
      realAllowed: false,
      patterns: PATTERNS,
      now: () => this.clock,
    });
    // No history of news exists for a past day, so the news filter is left out of replays.
    applySettingsToTrader(this.trader, { ...settings, newsFilter: false }, opts.universe ?? 'large');
    this.trader.entryScanGapMs = opts.scanGapMs ?? 0;
    this.trader.start();
  }

  get totalMinutes(): number {
    return this.minutes.length;
  }

  get position(): number {
    return this.index;
  }

  get finished(): boolean {
    return this.index >= this.minutes.length;
  }

  /** Clock as "HH:MM" India time */
  get clockLabel(): string {
    const m = istMinutes(this.clock);
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }

  /** Plays one minute of the day. Returns false when the day is over. */
  async stepMinute(): Promise<boolean> {
    if (this.finished) return false;
    const t = this.minutes[this.index++];
    const rows = this.byMinute.get(t)!;
    const ticks = TICK_SECONDS.map(() => [] as Quote[]);
    for (const { symbol, c } of rows) {
      const meta = this.data.symbols.get(symbol)!;
      if (!this.dayOpen.has(symbol)) this.dayOpen.set(symbol, c.o);
      const rising = c.c >= c.o;
      const path = [c.o, rising ? c.l : c.h, rising ? c.h : c.l, c.c];
      this.cum.set(symbol, (this.cum.get(symbol) ?? 0) + c.v);
      path.forEach((p, k) => {
        this.hi.set(symbol, Math.max(this.hi.get(symbol) ?? p, p));
        this.lo.set(symbol, Math.min(this.lo.get(symbol) ?? p, p));
        ticks[k].push({
          symbol,
          ltp: p,
          prevClose: meta.prevClose,
          open: this.dayOpen.get(symbol)!,
          high: this.hi.get(symbol)!,
          low: this.lo.get(symbol)!,
          // The whole minute's volume arrives on the first tick, like a burst of trades at the start of the minute.
          volume: this.cum.get(symbol)! - (k === 0 ? c.v : 0) + (k === 0 ? c.v : 0),
          ts: t + TICK_SECONDS[k] * 1000,
        });
      });
    }
    for (let k = 0; k < ticks.length; k++) {
      this.clock = t + TICK_SECONDS[k] * 1000;
      this.store.update(ticks[k]);
      await this.trader.onQuotes(ticks[k]);
    }
    if (this.finished && this.trader.positions.size > 0) await this.trader.killAll('Replay ended');
    return !this.finished;
  }

  trades() {
    return this.db.tradesForDay(this.day());
  }

  day(): string {
    return this.data.day;
  }

  /** Everything the replay screen shows right now. */
  snapshot() {
    const st = this.trader.status();
    const trades = this.trades();
    const net = trades.reduce((a, t) => a + t.net_pnl, 0);
    return {
      day: this.data.day,
      clock: this.clockLabel,
      progress: this.minutes.length ? this.index / this.minutes.length : 1,
      finished: this.finished,
      realized: Math.round(net * 100) / 100,
      unrealized: st.unrealized,
      positions: st.positions.map((p) => ({ symbol: p.symbol, side: p.side, entry: p.entry, ltp: p.ltp, stop: p.stop, stage: p.stage ?? 0, pnl: Math.round(p.pnl), pattern: p.pattern })),
      trades: trades.slice().reverse().slice(0, 200),
      events: this.db.recentEvents(40).filter((e) => !e.message.startsWith('SKIP')).slice(0, 30),
    };
  }
}

export interface DayResult {
  day: string;
  net: number;
  trades: number;
  wins: number;
  grossWin: number;
  grossLoss: number;
  byPattern: Record<string, { trades: number; net: number }>;
  rows: ReturnType<ReplayRun['trades']>;
}

/** Plays a whole day as fast as the computer allows (yielding between minutes so the live app stays responsive). */
export async function runDay(data: DayData, settings: AppSettings, opts: { yieldEvery?: number; shouldStop?: () => boolean; scanGapMs?: number } = {}): Promise<DayResult> {
  const run = new ReplayRun(data, settings, { scanGapMs: opts.scanGapMs ?? 55_000 });
  let n = 0;
  while (await run.stepMinute()) {
    if (opts.shouldStop?.()) break;
    if (++n % (opts.yieldEvery ?? 15) === 0) await new Promise<void>((r) => setImmediate(r));
  }
  const rows = run.trades();
  const byPattern: DayResult['byPattern'] = {};
  let grossWin = 0;
  let grossLoss = 0;
  for (const t of rows) {
    const b = (byPattern[t.pattern] ??= { trades: 0, net: 0 });
    b.trades++;
    b.net += t.net_pnl;
    if (t.net_pnl > 0) grossWin += t.net_pnl;
    else grossLoss -= t.net_pnl;
  }
  const net = rows.reduce((a, t) => a + t.net_pnl, 0);
  run.db.close();
  return { day: data.day, net: Math.round(net * 100) / 100, trades: rows.length, wins: rows.filter((t) => t.net_pnl > 0).length, grossWin, grossLoss, byPattern, rows };
}
