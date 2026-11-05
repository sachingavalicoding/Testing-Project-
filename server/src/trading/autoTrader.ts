import type { Broker } from '../broker/broker.ts';
import type { Db } from '../db/db.ts';
import type { MarketStore } from '../market/store.ts';
import { istDate, istMinutes, MARKET_OPEN, parseHHMM } from '../market/time.ts';
import type { Mode, Quote } from '../types.ts';
import { netPnl, roundTripCharges } from './charges.ts';
import type { Pattern, Signal } from './patterns.ts';
import { positionSize } from './sizing.ts';
import { initialStop, ladderStop, type LadderRule } from './stops.ts';

export interface Position {
  symbol: string;
  mode: Mode;
  qty: number;
  entry: number;
  entryTs: number;
  stop: number;
  highest: number;
  marginUsed: number;
  pattern: string;
  reason: string;
  orderId: string;
  /** Real mode: price is our estimate until the broker order book confirms it. */
  estimated: boolean;
}

export interface MoneyRules {
  capital: number;
  dailyLossCap: number;
  maxOpenPositions: number;
  riskPerTrade: number;
  maxDayMovePct: number;
  squareOffTime: string;
}

export interface AutoTraderDeps {
  rules: MoneyRules;
  db: Db;
  store: MarketStore;
  paperBroker: Broker;
  realBroker?: Broker;
  /** The REAL_TRADING_ENABLED lock from .env */
  realAllowed: boolean;
  patterns: Pattern[];
  ladder?: LadderRule;
  /** Mock feed runs any time of day; real market hours otherwise. */
  ignoreMarketHours?: boolean;
  now?: () => number;
}

export const REAL_CONFIRM_TEXT = 'I UNDERSTAND THIS USES REAL MONEY';

export class AutoTrader {
  mode: Mode = 'paper';
  running = false;
  haltedReason: string | undefined;
  positions = new Map<string, Position>();
  realizedToday = 0;
  private enteredToday = new Set<string>();
  private day: string;
  private busy = false;
  private readonly now: () => number;
  /** Own copy so the day-move limit can change with the share list. */
  private readonly rules: MoneyRules;

  constructor(private readonly d: AutoTraderDeps) {
    this.now = d.now ?? Date.now;
    this.rules = { ...d.rules };
    this.day = istDate(this.now());
    // Mode is remembered, but trading never auto-starts after a restart.
    const saved = d.db.getSetting('mode');
    if (saved === 'real' && d.realAllowed && d.realBroker) this.mode = 'real';
    for (const t of d.db.tradesForDay(this.day)) {
      this.realizedToday += t.net_pnl;
      this.enteredToday.add(t.symbol);
    }
  }

  private get broker(): Broker {
    if (this.mode === 'real') {
      if (!this.d.realAllowed || !this.d.realBroker) throw new Error('Real trading is locked');
      return this.d.realBroker;
    }
    return this.d.paperBroker;
  }

  /** Bigger limit for volatile lists (mid/small cap). */
  setMaxDayMovePct(pct: number): void {
    this.rules.maxDayMovePct = pct;
  }

  setMode(mode: Mode, confirm?: string): void {
    if (mode === this.mode) return;
    if (this.positions.size > 0) throw new Error('Close all positions before switching mode');
    if (mode === 'real') {
      if (!this.d.realAllowed) throw new Error('Real trading is locked. Set REAL_TRADING_ENABLED=true on the server first.');
      if (!this.d.realBroker) throw new Error('Upstox is not connected');
      if (confirm !== REAL_CONFIRM_TEXT) throw new Error(`Type exactly: ${REAL_CONFIRM_TEXT}`);
    }
    this.running = false;
    this.mode = mode;
    this.d.db.setSetting('mode', mode);
    this.d.db.log('warn', `Mode switched to ${mode.toUpperCase()}`);
  }

  start(): void {
    if (this.haltedReason) throw new Error(`Stopped for today: ${this.haltedReason}`);
    this.running = true;
    this.d.db.log('info', `Auto trading started (${this.mode})`);
  }

  stop(): void {
    this.running = false;
    this.d.db.log('info', `Auto trading stopped (${this.mode})`);
  }

  /** Kill switch: sell everything now and stop for the rest of the day. */
  async killAll(reason = 'Kill-all pressed'): Promise<void> {
    this.running = false;
    this.haltedReason = reason;
    this.d.db.log('warn', `KILL ALL: ${reason}`);
    for (const p of [...this.positions.values()]) await this.exit(p, reason);
  }

  get freeCash(): number {
    let used = 0;
    for (const p of this.positions.values()) used += p.marginUsed;
    return this.rules.capital + Math.min(0, this.realizedToday) - used;
  }

  unrealized(): number {
    let sum = 0;
    for (const p of this.positions.values()) {
      const ltp = this.d.store.quote(p.symbol)?.ltp ?? p.entry;
      sum += netPnl(p.entry, ltp, p.qty);
    }
    return Math.round(sum * 100) / 100;
  }

  status() {
    return {
      mode: this.mode,
      running: this.running,
      haltedReason: this.haltedReason,
      realAllowed: this.d.realAllowed && !!this.d.realBroker,
      realizedToday: Math.round(this.realizedToday * 100) / 100,
      unrealized: this.unrealized(),
      freeCash: Math.round(this.freeCash),
      rules: this.rules,
      positions: [...this.positions.values()].map((p) => ({
        ...p,
        ltp: this.d.store.quote(p.symbol)?.ltp ?? p.entry,
        pnl: netPnl(p.entry, this.d.store.quote(p.symbol)?.ltp ?? p.entry, p.qty),
      })),
    };
  }

  /** Called on every price update (once a second). */
  async onQuotes(quotes: Quote[]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.rollDay();
      await this.manageOpen(quotes);
      if (this.running && !this.haltedReason) await this.lookForEntries(quotes);
    } catch (err) {
      this.d.db.log('error', `Trader error: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private rollDay(): void {
    const today = istDate(this.now());
    if (today === this.day) return;
    this.day = today;
    this.realizedToday = 0;
    this.enteredToday.clear();
    this.haltedReason = undefined;
  }

  private inTradingWindow(): boolean {
    if (this.d.ignoreMarketHours) return true;
    const m = istMinutes(this.now());
    return m >= MARKET_OPEN && m < parseHHMM(this.rules.squareOffTime);
  }

  private async manageOpen(quotes: Quote[]): Promise<void> {
    const byS = new Map(quotes.map((q) => [q.symbol, q]));
    if (!this.d.ignoreMarketHours && this.positions.size > 0 && istMinutes(this.now()) >= parseHHMM(this.rules.squareOffTime)) {
      for (const p of [...this.positions.values()]) await this.exit(p, `Square-off time ${this.rules.squareOffTime}`);
      return;
    }
    for (const p of [...this.positions.values()]) {
      const q = byS.get(p.symbol);
      if (!q) continue;
      if (q.ltp > p.highest) {
        p.highest = q.ltp;
        const next = ladderStop(p.entry, p.qty, p.highest, p.stop, this.d.ladder ?? { stepPct: 0.5 });
        if (next > p.stop) {
          this.d.db.log('info', `${p.symbol} stop moved up ${p.stop} → ${next}`);
          p.stop = next;
        }
      }
      if (q.ltp <= p.stop) await this.exit(p, `Stop hit at ${q.ltp} (stop ${p.stop})`);
    }
    // Daily loss cap counts open losses too.
    if (!this.haltedReason && this.realizedToday + this.unrealized() <= -this.rules.dailyLossCap) {
      await this.killAll(`Daily loss cap ₹${this.rules.dailyLossCap} reached`);
    }
  }

  private async lookForEntries(quotes: Quote[]): Promise<void> {
    if (!this.inTradingWindow()) return;
    if (this.positions.size >= this.rules.maxOpenPositions) return;
    const candidates: Array<{ q: Quote; s: Signal }> = [];
    for (const q of quotes) {
      if (this.positions.has(q.symbol) || this.enteredToday.has(q.symbol)) continue;
      // 1-minute entry check: skip shares that already moved too much today.
      const dayMove = q.prevClose > 0 ? Math.abs((q.ltp - q.prevClose) / q.prevClose) * 100 : 0;
      if (dayMove > this.rules.maxDayMovePct) continue;
      const candles = this.d.store.candlesFor(q.symbol);
      for (const p of this.d.patterns) {
        const s = p.check(q, candles);
        if (s) candidates.push({ q, s });
      }
    }
    candidates.sort((a, b) => b.s.score - a.s.score);
    for (const { q, s } of candidates) {
      if (this.positions.size >= this.rules.maxOpenPositions) break;
      if (this.positions.has(q.symbol)) continue;
      await this.enter(q, s);
    }
  }

  private async enter(q: Quote, s: Signal): Promise<void> {
    const broker = this.broker;
    // Ask the broker for the real MIS margin for one share first, then size.
    const probe = await broker.getMargin(q.symbol, 1, q.ltp);
    const qty = positionSize({
      price: q.ltp,
      freeCash: this.freeCash,
      marginPerShare: probe.marginPerShare,
      riskPerTrade: this.rules.riskPerTrade,
      stopPct: s.stopPct,
    });
    if (qty < 1) {
      this.d.db.log('info', `${q.symbol}: ${s.pattern} fired but size is 0 (free cash ₹${Math.round(this.freeCash)})`);
      return;
    }
    const stop = initialStop(q.ltp, qty, s.stopPct, this.rules.riskPerTrade);
    const res = await broker.placeOrder({ symbol: q.symbol, side: 'BUY', qty, reason: s.reason });
    if (res.status === 'rejected') {
      this.d.db.log('warn', `${q.symbol} BUY rejected: ${res.message ?? 'unknown'}`);
      return;
    }
    const entry = res.avgPrice ?? q.ltp;
    this.enteredToday.add(q.symbol);
    this.positions.set(q.symbol, {
      symbol: q.symbol,
      mode: this.mode,
      qty,
      entry,
      entryTs: this.now(),
      stop,
      highest: entry,
      marginUsed: qty * probe.marginPerShare,
      pattern: s.pattern,
      reason: s.reason,
      orderId: res.orderId,
      estimated: res.status !== 'filled',
    });
    this.d.db.log(
      'info',
      `BUY ${qty} ${q.symbol} @ ${entry} [${this.mode}] stop ${stop} lev ${probe.leverage.toFixed(1)}x — ${s.reason}`,
    );
  }

  private async exit(p: Position, why: string): Promise<void> {
    const res = await this.broker.placeOrder({ symbol: p.symbol, side: 'SELL', qty: p.qty, reason: why });
    if (res.status === 'rejected') {
      this.d.db.log('error', `${p.symbol} SELL rejected: ${res.message ?? 'unknown'}. Position still open!`);
      return;
    }
    const exitPrice = res.avgPrice ?? this.d.store.quote(p.symbol)?.ltp ?? p.entry;
    const charges = roundTripCharges(p.entry, exitPrice, p.qty).total;
    const pnl = netPnl(p.entry, exitPrice, p.qty);
    this.positions.delete(p.symbol);
    this.realizedToday += pnl;
    this.d.db.addTrade({
      day: this.day,
      mode: p.mode,
      symbol: p.symbol,
      qty: p.qty,
      entry_price: p.entry,
      exit_price: exitPrice,
      entry_ts: p.entryTs,
      exit_ts: this.now(),
      pattern: p.pattern,
      entry_reason: p.reason,
      exit_reason: why,
      charges,
      net_pnl: pnl,
    });
    this.d.db.log('info', `SELL ${p.qty} ${p.symbol} @ ${exitPrice} net ₹${pnl} — ${why}`);
  }
}
