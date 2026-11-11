import type { Broker } from '../broker/broker.ts';
import type { Db } from '../db/db.ts';
import type { MarketStore } from '../market/store.ts';
import { istDate, istMinutes, MARKET_OPEN, parseHHMM } from '../market/time.ts';
import type { Mode, Quote } from '../types.ts';
import { netPnl, roundTripCharges } from './charges.ts';
import type { Pattern, Signal } from './patterns.ts';
import { positionSize } from './sizing.ts';
import { vwap } from './indicators.ts';
import { randomUUID } from 'node:crypto';
import { roundToTick } from './ticks.ts';
import { initialStop, ladderStop, type LadderRule } from './stops.ts';
import { defaultQuality, marketBreadthPct, qualityReject, qualitySummary, type QualityRules } from './quality.ts';

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
  /** Sell automatically when price reaches this (manual buys only) */
  target?: number;
  /** The stop the position started with: 1R (the planned risk) is the distance from the entry to it */
  stop0?: number;
}

/** ' (market 3518.1, filled 3528.7: 0.30% slippage)' when the fill differs from the market price, so a fill is never a mystery. */
export function slipNote(market: number | undefined, fill: number): string {
  if (market === undefined || market <= 0 || Math.abs(fill - market) < 1e-9) return '';
  return ` (market ${market}, filled ${fill}: ${(((fill - market) / market) * 100).toFixed(2)}% ${fill > market ? 'above' : 'below'} the market price)`;
}

export interface ManualBuyRequest {
  symbol: string;
  qty: number;
  type: 'market' | 'limit';
  limitPrice?: number;
  /** Sell if price falls to this */
  stopPrice?: number;
  /** Or: stop this many % below the buy price (default 1) */
  stopPct?: number;
  /** Optional profit target price */
  targetPrice?: number;
}

export interface PendingOrder {
  id: string;
  symbol: string;
  qty: number;
  limitPrice: number;
  stopPrice?: number;
  stopPct?: number;
  targetPrice?: number;
  mode: Mode;
  createdTs: number;
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
  /** Returns a reason to skip this share (bad news, results due), or undefined to go ahead. */
  newsCheck?: (symbol: string) => Promise<string | undefined>;
}

export const REAL_CONFIRM_TEXT = 'I UNDERSTAND THIS USES REAL MONEY';

export class AutoTrader {
  mode: Mode = 'paper';
  running = false;
  haltedReason: string | undefined;
  positions = new Map<string, Position>();
  realizedToday = 0;
  private enteredToday = new Set<string>();
  /** When each skip reason was last written to the log, so a share that stays skipped is not logged every second */
  private skipLogged = new Map<string, number>();
  private weakMarketLogged = false;
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
    this.restorePositions();
  }

  /**
   * Open paper positions survive a restart. Only today's are brought back (intraday positions never carry over),
   * and only in paper mode (real positions belong to the broker). Stops, targets and the square-off are watched
   * again straight away, even while auto trading is stopped.
   */
  private restorePositions(): void {
    const restored: string[] = [];
    for (const json of this.d.db.openPositions()) {
      let p: Position | undefined;
      try {
        p = JSON.parse(json) as Position;
      } catch {
        p = undefined;
      }
      const ok = p && typeof p.symbol === 'string' && p.mode === 'paper' && Number.isFinite(p.qty) && p.qty > 0 && Number.isFinite(p.entry) && Number.isFinite(p.stop) && Number.isFinite(p.entryTs);
      if (!p || !ok) continue;
      if (this.mode !== 'paper' || istDate(p.entryTs) !== this.day) {
        if (istDate(p.entryTs) !== this.day) this.d.db.deleteOpenPosition(p.symbol); // yesterday's: gone
        continue;
      }
      this.positions.set(p.symbol, p);
      this.enteredToday.add(p.symbol);
      restored.push(`${p.symbol} (${p.qty} @ ${p.entry}, stop ${p.stop})`);
    }
    if (restored.length) this.d.db.log('info', `Restored ${restored.length} open paper position${restored.length === 1 ? '' : 's'} after the restart: ${restored.join(', ')}`);
  }

  /** Remember an open paper position (called when it opens and whenever its stop moves). */
  private persist(p: Position): void {
    if (p.mode === 'paper') this.d.db.saveOpenPosition(p.symbol, JSON.stringify(p));
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

  /** Apply new limits from the settings page. Open positions keep their stops. */
  setRules(r: Partial<MoneyRules>): void {
    Object.assign(this.rules, r);
  }

  filters = { requireAboveVwap: true, newsFilter: true };

  /** Entry quality checks and the automatic profit target (set from the settings page). */
  quality: QualityRules = { ...defaultQuality };

  setMode(mode: Mode, confirm?: string): void {
    if (mode === this.mode) return;
    if (this.positions.size > 0) throw new Error('Close all positions before switching mode');
    if (mode === 'real') {
      if (!this.d.realAllowed) throw new Error('Real trading is locked. Set REAL_TRADING_ENABLED=true on the server first.');
      if (!this.d.realBroker) throw new Error('Upstox is not connected');
      if (confirm !== REAL_CONFIRM_TEXT) throw new Error(`Type exactly: ${REAL_CONFIRM_TEXT}`);
    }
    this.running = false;
    this.pending.clear();
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
    await this.withLock(() => this.killAllNow(reason));
  }

  private async killAllNow(reason: string): Promise<void> {
    this.running = false;
    this.haltedReason = reason;
    this.pending.clear();
    this.d.db.log('warn', `KILL ALL: ${reason}`);
    for (const p of [...this.positions.values()]) await this.exit(p, reason);
  }

  /** One thing at a time touches positions: price ticks, manual orders and the kill switch take turns. */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    while (this.busy) await new Promise((r) => setTimeout(r, 10));
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  // ---------- Manual trading (same positions, stops and loss cap as auto) ----------

  pending = new Map<string, PendingOrder>();

  /** Buy a share you picked. Market buys now; a limit below the price waits for the dip. */
  async manualBuy(req: ManualBuyRequest): Promise<{ status: 'filled' | 'pending'; symbol: string; orderId?: string }> {
    return this.withLock(async () => {
      this.checkManualAllowed(req.symbol);
      if (!Number.isInteger(req.qty) || req.qty < 1 || req.qty > 1_000_000) throw new Error('Quantity must be a whole number, 1 or more');
      const q = this.d.store.quote(req.symbol);
      if (!q) throw new Error(`No live price for ${req.symbol} yet. Wait a few seconds and try again.`);
      if (this.pending.size >= 20) throw new Error('Too many waiting orders. Cancel some first.');
      let ref = q.ltp;
      if (req.type === 'limit') {
        if (!(req.limitPrice && req.limitPrice > 0)) throw new Error('Enter a limit price');
        ref = roundToTick(req.limitPrice);
      }
      this.checkStopTarget(ref, req.stopPrice, req.stopPct, req.targetPrice);
      if (req.type === 'limit' && ref < q.ltp) {
        const order: PendingOrder = {
          id: randomUUID(), symbol: req.symbol, qty: req.qty, limitPrice: ref, stopPrice: req.stopPrice,
          stopPct: req.stopPct, targetPrice: req.targetPrice, mode: this.mode, createdTs: this.now(),
        };
        this.pending.set(order.id, order);
        this.d.db.log('info', `Waiting buy order: ${req.qty} ${req.symbol} at ₹${ref} or lower [${this.mode}]`);
        return { status: 'pending' as const, symbol: req.symbol, orderId: order.id };
      }
      const pos = await this.openManual(q, req.qty, req.stopPrice, req.stopPct, req.targetPrice);
      return { status: 'filled' as const, symbol: req.symbol, orderId: pos.orderId };
    });
  }

  /** Sell (close) a position you hold. Shares only, no short selling. */
  async manualSell(symbol: string): Promise<void> {
    await this.withLock(async () => {
      const p = this.positions.get(symbol);
      if (!p) throw new Error(`You do not hold ${symbol}`);
      await this.exit(p, 'Manual sell');
    });
  }

  cancelPending(id: string): void {
    const o = this.pending.get(id);
    if (!o) throw new Error('That order is already gone');
    this.pending.delete(id);
    this.d.db.log('info', `Waiting order cancelled: ${o.symbol}`);
  }

  private checkManualAllowed(symbol: string): void {
    if (this.haltedReason) throw new Error(`Stopped for today: ${this.haltedReason}`);
    if (this.positions.has(symbol)) throw new Error(`You already hold ${symbol}. Sell it first.`);
    for (const o of this.pending.values()) if (o.symbol === symbol) throw new Error(`There is already a waiting order for ${symbol}. Cancel it first.`);
    if (!this.inTradingWindow()) throw new Error(`Market is closed for new buys (open 09:15 to ${this.rules.squareOffTime} IST)`);
  }

  private checkStopTarget(ref: number, stopPrice?: number, stopPct?: number, target?: number): void {
    if (stopPrice !== undefined && !(stopPrice > 0 && stopPrice < ref)) throw new Error(`Stop must be below the buy price (₹${ref})`);
    if (stopPct !== undefined && !(stopPct > 0 && stopPct < 50)) throw new Error('Stop % must be between 0 and 50');
    if (target !== undefined && !(target > ref)) throw new Error(`Target must be above the buy price (₹${ref})`);
  }

  private async openManual(q: Quote, qty: number, stopPrice?: number, stopPct?: number, target?: number): Promise<Position> {
    const broker = this.broker;
    const probe = await broker.getMargin(q.symbol, qty, q.ltp);
    const need = qty * probe.marginPerShare;
    if (need > this.freeCash) {
      throw new Error(`Needs about ₹${Math.round(need)} margin but only ₹${Math.round(this.freeCash)} is free. Lower the quantity.`);
    }
    const stop = stopPrice !== undefined ? roundToTick(stopPrice, 'down') : roundToTick(q.ltp * (1 - (stopPct ?? 1) / 100), 'down');
    const res = await broker.placeOrder({ symbol: q.symbol, side: 'BUY', qty, reason: 'Manual buy' });
    if (res.status === 'rejected') throw new Error(`Broker rejected the order: ${res.message ?? 'unknown reason'}`);
    const entry = res.avgPrice ?? q.ltp;
    const pos: Position = {
      symbol: q.symbol, mode: this.mode, qty, entry, entryTs: this.now(), stop, highest: entry,
      marginUsed: need, pattern: 'manual', reason: 'Manual buy', orderId: res.orderId,
      estimated: res.status !== 'filled', target, stop0: stop,
    };
    this.positions.set(q.symbol, pos);
    this.persist(pos);
    this.d.db.log('info', `MANUAL BUY ${qty} ${q.symbol} @ ${entry}${slipNote(q.ltp, entry)} (₹${Math.round(qty * entry)}, margin ₹${Math.round(qty * probe.marginPerShare)}) [${this.mode}] stop ${stop}${target ? ` target ${target}` : ''}`);
    return pos;
  }

  private async fillPending(quotes: Quote[]): Promise<void> {
    const byS = new Map(quotes.map((q) => [q.symbol, q]));
    for (const o of [...this.pending.values()]) {
      if (o.mode !== this.mode) { this.pending.delete(o.id); continue; }
      const q = byS.get(o.symbol);
      if (!q || q.ltp > o.limitPrice) continue;
      this.pending.delete(o.id);
      try {
        if (this.positions.has(o.symbol)) continue;
        await this.openManual(q, o.qty, o.stopPrice, o.stopPct, o.targetPrice);
      } catch (e) {
        this.d.db.log('warn', `Waiting order for ${o.symbol} could not be placed: ${(e as Error).message}`);
      }
    }
  }

  /** Own money (margin) per trade; leverage multiplies it. 0 = size by risk per trade. From the settings page. */
  capitalPerTrade = 0;
  /** Most new auto trades in one minute (0 = no limit) */
  entriesPerMinute = 0;
  private entryMinute = 0;
  private entriesThisMinute = 0;

  /** Paper money to trade with (set on the settings page). Real mode always uses the CAPITAL from .env. */
  paperCash: number | undefined;

  /** The money available to this mode: the paper cash setting in paper mode, CAPITAL from .env in real mode. */
  get capital(): number {
    return this.mode === 'paper' && this.paperCash !== undefined ? this.paperCash : this.rules.capital;
  }

  get freeCash(): number {
    let used = 0;
    for (const p of this.positions.values()) used += p.marginUsed;
    return this.capital + Math.min(0, this.realizedToday) - used;
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
      rules: { ...this.rules, capital: this.capital },
      pending: [...this.pending.values()],
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
      if (!this.haltedReason) await this.fillPending(quotes);
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
    this.skipLogged.clear();
    this.pending.clear();
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
      this.pending.clear();
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
          this.persist(p);
        }
      }
      if (q.ltp <= p.stop) await this.exit(p, `Stop hit at ${q.ltp} (stop ${p.stop})`);
      else if (p.target && q.ltp >= p.target) await this.exit(p, `Target hit at ${q.ltp} (target ${p.target})`);
    }
    // Daily loss cap counts open losses too.
    if (!this.haltedReason && this.realizedToday + this.unrealized() <= -this.rules.dailyLossCap) {
      await this.killAllNow(`Daily loss cap ₹${this.rules.dailyLossCap} reached`);
    }
  }

  private async lookForEntries(quotes: Quote[]): Promise<void> {
    if (!this.inTradingWindow()) return;
    if (this.positions.size >= this.rules.maxOpenPositions) return;
    if (this.quality.enabled) {
      // A weak market (most shares down) makes long entries fail more often: sit out.
      const breadth = marketBreadthPct(quotes);
      if (breadth !== undefined && breadth < this.quality.breadthMin) {
        if (!this.weakMarketLogged) {
          this.weakMarketLogged = true;
          this.d.db.log('info', `SKIP all entries: market is weak (median share ${breadth.toFixed(2)}% today, limit ${this.quality.breadthMin}%)`);
        }
        return;
      }
      this.weakMarketLogged = false;
    }
    const candidates: Array<{ q: Quote; s: Signal }> = [];
    for (const q of quotes) {
      if (this.positions.has(q.symbol) || this.enteredToday.has(q.symbol)) continue;
      const dayMove = q.prevClose > 0 ? Math.abs((q.ltp - q.prevClose) / q.prevClose) * 100 : 0;
      const candles = this.d.store.candlesFor(q.symbol);
      for (const p of this.d.patterns) {
        const s = p.check(q, candles);
        if (!s) continue;
        // 1-minute entry check: skip shares that already moved too much today.
        if (dayMove > this.rules.maxDayMovePct) {
          this.logSkip(q.symbol, s.pattern, `already moved ${dayMove.toFixed(1)}% today (limit ${this.rules.maxDayMovePct}%)`);
          continue;
        }
        if (this.filters.requireAboveVwap) {
          const today = candles.filter((c) => istDate(c.t) === this.day);
          const v = vwap(today);
          if (v !== undefined && q.ltp < v) {
            this.logSkip(q.symbol, s.pattern, `price ${q.ltp} is below today's average price (VWAP ${v.toFixed(2)})`);
            continue;
          }
        }
        const why = qualityReject(q, candles, s, this.quality);
        if (why !== undefined) {
          this.logSkip(q.symbol, s.pattern, why);
          continue;
        }
        candidates.push({ q, s });
      }
    }
    candidates.sort((a, b) => b.s.score - a.s.score);
    for (const { q, s } of candidates) {
      if (this.positions.size >= this.rules.maxOpenPositions) break;
      if (this.positions.has(q.symbol)) continue;
      if (this.entriesPerMinute > 0) {
        const minute = Math.floor(this.now() / 60_000);
        if (minute !== this.entryMinute) {
          this.entryMinute = minute;
          this.entriesThisMinute = 0;
        }
        if (this.entriesThisMinute >= this.entriesPerMinute) break; // the next minute gets the rest, best score first
      }
      if (this.filters.newsFilter && this.d.newsCheck) {
        const skip = await this.d.newsCheck(q.symbol);
        if (skip) {
          this.enteredToday.add(q.symbol); // do not re-check the same share every second
          this.d.db.log('info', `${q.symbol}: ${s.pattern} fired but skipped: ${skip}`);
          continue;
        }
      }
      await this.enter(q, s);
    }
  }

  /** Write 'why we did NOT buy' to the log, at most once per share and reason every 10 minutes. */
  private logSkip(symbol: string, pattern: string, reason: string): void {
    const key = `${symbol}|${pattern}|${reason.replace(/[0-9.]+/g, '#')}`;
    const last = this.skipLogged.get(key);
    if (last !== undefined && this.now() - last < 10 * 60_000) return;
    this.skipLogged.set(key, this.now());
    this.d.db.log('info', `SKIP ${symbol}: ${pattern} fired but ${reason}`);
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
      capitalPerTrade: this.capitalPerTrade,
    });
    if (qty < 1) {
      this.d.db.log('info', `${q.symbol}: ${s.pattern} fired but size is 0 (free cash ₹${Math.round(this.freeCash)})`);
      return;
    }
    // With a fixed capital per trade the stop stays where the chart puts it (it is limited by the list's widest stop);
    // the risk-per-trade cap would otherwise squeeze it tighter than normal price noise.
    const stop = initialStop(q.ltp, qty, s.stopPct, this.capitalPerTrade > 0 ? Infinity : this.rules.riskPerTrade);
    // Saved with the trade: the pattern's reason plus every check it passed.
    const why = this.quality.enabled ? `${s.reason}. Checks passed: ${qualitySummary(q, this.d.store.candlesFor(q.symbol), this.quality, s)}` : s.reason;
    const res = await broker.placeOrder({ symbol: q.symbol, side: 'BUY', qty, reason: why });
    if (res.status === 'rejected') {
      this.d.db.log('warn', `${q.symbol} BUY rejected: ${res.message ?? 'unknown'}`);
      return;
    }
    const entry = res.avgPrice ?? q.ltp;
    const target = this.quality.targetPct > 0 ? roundToTick(entry * (1 + this.quality.targetPct / 100), 'up') : undefined;
    this.enteredToday.add(q.symbol);
    if (this.entriesPerMinute > 0) this.entriesThisMinute++;
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
      reason: why,
      orderId: res.orderId,
      estimated: res.status !== 'filled',
      target,
      stop0: stop,
    });
    this.persist(this.positions.get(q.symbol)!);
    this.d.db.log(
      'info',
      `BUY ${qty} ${q.symbol} @ ${entry}${slipNote(q.ltp, entry)} (₹${Math.round(qty * entry)}, margin ₹${Math.round(qty * probe.marginPerShare)}) [${this.mode}] stop ${stop}${target ? ` target ${target}` : ''} lev ${probe.leverage.toFixed(1)}x — ${why}`,
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
    this.d.db.deleteOpenPosition(p.symbol);
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
    this.d.db.log('info', `SELL ${p.qty} ${p.symbol} @ ${exitPrice}${slipNote(this.d.store.quote(p.symbol)?.ltp, exitPrice)} net ₹${pnl} — ${why}`);
  }
}
