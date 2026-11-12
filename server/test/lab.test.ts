import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { Db, type TradeRow } from '../src/db/db.ts';
import { defaultSettings, validateSettings, type AppSettings } from '../src/settings.ts';
import { ablation, evaluate, mutate, optimize, allKnobs, knobValue, rng, clone } from '../src/lab/optimize.ts';
import { buildReport, exitKind } from '../src/lab/report.ts';
import { recordStore, importHistory } from '../src/lab/recorder.ts';
import { ReplayRun, runDay } from '../src/lab/replay.ts';
import { applyLearned, loadDays, registerLab } from '../src/lab/routes.ts';
import { MarketStore } from '../src/market/store.ts';
import { syntheticDay } from './labData.ts';

const settings = (): AppSettings =>
  defaultSettings({ money: { capital: 5_000_000, riskPerTrade: 500, maxOpenPositions: 15, dailyLossCap: 20000, maxDayMovePctByList: { large: 3, mid: 6, small: 12 } } } as never);

describe('report', () => {
  const t = (o: Partial<TradeRow>): TradeRow => ({ day: '2026-11-10', mode: 'paper', symbol: 'A', qty: 1, entry_price: 100, exit_price: 100, entry_ts: Date.UTC(2026, 10, 10, 5, 0), exit_ts: 0, pattern: 'squeeze', entry_reason: '', exit_reason: 'Stop hit at 99', charges: 5, net_pnl: -50, side: 'long', ...o });
  it('groups by pattern, side, exit and says what to do', () => {
    const r = buildReport([t({}), t({}), t({}), t({ pattern: 'vwappb', net_pnl: 300, exit_reason: 'Target 3 hit at 105' }), t({ pattern: 'vwappb', net_pnl: 200, side: 'short', exit_reason: 'Target 3 hit' }), t({ pattern: 'vwappb', net_pnl: 100 })]);
    expect(r.total.trades).toBe(6);
    expect(r.total.net).toBe(450);
    expect(r.byPattern.find((b) => b.key === 'squeeze')!.net).toBe(-150);
    expect(r.bySide.map((b) => b.key).sort()).toEqual(['Buy', 'Short']);
    expect(r.byExit.find((b) => b.key === 'Target hit')!.trades).toBe(2);
    expect(r.findings.join(' ')).toMatch(/squeeze.*switching it off/);
    expect(r.byPattern.find((b) => b.key === 'vwappb')!.profitFactor).toBe(99);
  });
  it('handles no trades and classifies exits', () => {
    expect(buildReport([]).findings).toEqual(['No trades yet.']);
    expect([exitKind('Kill-all pressed'), exitKind('Square-off time 15:15'), exitKind('Manual sell'), exitKind('Stop hit')]).toEqual(['Kill all / loss cap', 'Square-off', 'Manual', 'Stop hit']);
  });
});

describe('saved candles', () => {
  it('saves from the live store, loads back, and saving twice does not duplicate', () => {
    const db = new Db(':memory:');
    const store = new MarketStore();
    const now = Date.UTC(2026, 10, 10, 6, 0, 30);
    for (let i = 0; i < 5; i++) store.update([{ symbol: 'AAA', ltp: 100 + i, prevClose: 99, open: 100, high: 105, low: 99, volume: 1000 * (i + 1), ts: now - (5 - i) * 60_000 }]);
    expect(recordStore(db, store, ['AAA', 'NOPE'], now)).toBe(1);
    expect(recordStore(db, store, ['AAA'], now)).toBe(1);
    expect(db.recordedDays()).toEqual([{ day: '2026-11-10', symbols: 1, candles: 5 }]);
    const d = db.loadDay('2026-11-10').get('AAA')!;
    expect(d.prevClose).toBe(99);
    expect(d.candles.map((c) => c.c)).toEqual([100, 101, 102, 103, 104]);
  });
  it('imports earlier days and uses the day before as the previous close', async () => {
    const db = new Db(':memory:');
    const day = (d: number, base: number) => Array.from({ length: 3 }, (_, i) => ({ t: Date.UTC(2026, 10, d, 4, i), o: base, h: base + 1, l: base - 1, c: base + i, v: 10 }));
    const feed = { name: 'upstox', getMinuteHistory: async () => [...day(5, 100), ...day(6, 110)] };
    const r = await importHistory(feed, db, ['X'], 5);
    expect(r).toEqual({ shares: 1, days: 2, failed: 0 });
    expect(db.loadDay('2026-11-06').get('X')!.prevClose).toBe(102);
    await expect(importHistory({ name: 'mock' }, db, ['X'], 5)).rejects.toThrow(/cannot fetch/);
  });
});

describe('replay', () => {
  it('plays a day through the real trader and is repeatable', async () => {
    const day = syntheticDay('2026-11-10', 7, 40);
    const a = await runDay(day, settings());
    const b = await runDay(day, settings());
    expect(a.net).toBe(b.net);
    expect(a.trades).toBe(b.trades);
    expect(a.rows.every((t) => t.exit_ts >= t.entry_ts)).toBe(true);
  }, 60_000);

  it('steps minute by minute and reports a clock and progress', async () => {
    const run = new ReplayRun(syntheticDay('2026-11-10', 3, 25), settings());
    expect(run.clockLabel).toBe('09:15');
    await run.stepMinute();
    await run.stepMinute();
    const s = run.snapshot();
    expect(s.progress).toBeGreaterThan(0);
    expect(s.progress).toBeLessThan(0.01);
    expect(s.finished).toBe(false);
    run.db.close();
  });

  it('turning shorts off removes every short', async () => {
    const s = settings();
    s.shortSelling = false;
    const r = await runDay(syntheticDay('2026-11-10', 11, 40, -0.02), s);
    expect(r.rows.filter((t) => t.side === 'short')).toHaveLength(0);
  }, 60_000);

  it('switching a pattern off stops it from trading', async () => {
    const day = syntheticDay('2026-11-10', 5, 40);
    const base = await runDay(day, settings());
    const ids = Object.keys(base.byPattern);
    if (ids.length === 0) return;
    const s = settings();
    s.disabledPatterns = [ids[0]];
    const r = await runDay(day, s);
    expect(r.byPattern[ids[0]]).toBeUndefined();
  }, 60_000);
});

describe('learner', () => {
  const days = [syntheticDay('2026-11-09', 21, 30), syntheticDay('2026-11-10', 22, 30, -0.015)];

  it('evaluates several days and sums them', async () => {
    const e = await evaluate(days, settings());
    expect(e.days).toBe(2);
    expect(e.perDay.map((d) => d.day)).toEqual(['2026-11-09', '2026-11-10']);
    expect(e.net).toBeCloseTo(e.perDay.reduce((a, d) => a + d.net, 0), 1);
  }, 120_000);

  it('ablation lists every check with what it adds', async () => {
    const r = await ablation([days[0]], settings());
    expect(r.rows.length).toBeGreaterThan(15);
    expect(r.rows.map((x) => x.name)).toContain('MACD agrees');
    const adds = r.rows.map((x) => x.adds);
    expect(adds).toEqual([...adds].sort((a, b) => b - a));
  }, 300_000);

  it('optimize never ends worse than it started, is repeatable with a seed, and reports its changes', async () => {
    const run = () => optimize([days[0]], settings(), { rounds: 2, variants: 3, seed: 42 });
    const a = await run();
    const b = await run();
    expect(a.best.score).toBeGreaterThanOrEqual(a.start.score);
    expect(a.best.net).toBe(b.best.net);
    expect(a.changes).toEqual(b.changes);
    expect(a.rounds).toHaveLength(2);
    expect(() => validateSettings(a.settings)).not.toThrow();
  }, 300_000);

  it('can stop part way', async () => {
    let n = 0;
    const r = await optimize([days[0]], settings(), { rounds: 5, variants: 3, seed: 1, shouldStop: () => ++n > 400 });
    expect(r.stopped).toBe(true);
  }, 120_000);

  it('mutate keeps settings valid for every knob', () => {
    const rand = rng(9);
    for (const k of allKnobs()) {
      const s = clone(settings());
      mutate(s, k, (n) => Math.floor(rand() * n));
      expect(() => validateSettings(s)).not.toThrow();
      expect(typeof knobValue(s, k)).toBe('string');
    }
  });

  it('applyLearned copies only what the Lab may change', () => {
    const live = settings();
    live.paperCash = 123_456;
    const learned = clone(settings());
    learned.paperCash = 1;
    learned.dailyLossCap = 1;
    learned.entryChecks.minAdx = 30;
    learned.lists.large.checks.minAdx = 30;
    learned.disabledPatterns = ['squeeze'];
    const out = applyLearned(live, learned);
    expect(out.paperCash).toBe(123_456);
    expect(out.dailyLossCap).toBe(live.dailyLossCap);
    expect(out.lists.large.checks.minAdx).toBe(30);
    expect(out.disabledPatterns).toEqual(['squeeze']);
  });
});

describe('lab routes', () => {
  async function build() {
    const db = new Db(':memory:');
    const app = Fastify();
    let s = settings();
    registerLab(app, { db, store: new MarketStore(), feed: { name: 'mock' } as never, settings: { get: () => s, update: (x) => (s = validateSettings(x)) } });
    await app.ready();
    return { app, db };
  }
  it('says there is nothing to learn from yet, and rejects a bad replay', async () => {
    const { app } = await build();
    expect((await app.inject({ method: 'POST', url: '/api/lab/optimize', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/lab/ablation' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/lab/replay', payload: { day: '2026-01-01' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/lab/apply' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/lab/replay' })).json()).toEqual({ active: false });
    expect((await app.inject({ method: 'GET', url: '/api/lab/report' })).json().findings).toEqual(['No trades yet.']);
  });
  it('replays a saved day at top speed and can pause, change speed and stop', async () => {
    const { app, db } = await build();
    const day = syntheticDay('2026-11-10', 4, 25);
    for (const [sym, e] of day.symbols) db.saveCandles(day.day, sym, e.candles, e.prevClose);
    expect(loadDays(db).map((d) => d.day)).toEqual(['2026-11-10']);
    expect((await app.inject({ method: 'GET', url: '/api/lab/days' })).json().learnable).toEqual(['2026-11-10']);
    expect((await app.inject({ method: 'POST', url: '/api/lab/replay', payload: { day: day.day, speed: 0 } })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 400));
    const st = (await app.inject({ method: 'GET', url: '/api/lab/replay' })).json();
    expect(st.active).toBe(true);
    expect(st.progress).toBeGreaterThan(0);
    expect((await app.inject({ method: 'POST', url: '/api/lab/replay/control', payload: { action: 'pause' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/lab/replay/control', payload: { action: 'speed', speed: 25 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/lab/replay' })).json().speed).toBe(25);
    expect((await app.inject({ method: 'POST', url: '/api/lab/replay/control', payload: { action: 'bogus' } })).statusCode).toBe(400);
    await app.inject({ method: 'POST', url: '/api/lab/replay/control', payload: { action: 'stop' } });
    expect((await app.inject({ method: 'GET', url: '/api/lab/replay' })).json()).toEqual({ active: false });
  }, 60_000);
});
