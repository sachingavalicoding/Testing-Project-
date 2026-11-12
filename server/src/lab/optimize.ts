import { PATTERNS } from '../trading/patterns.ts';
import type { AppSettings, EntryChecks } from '../settings.ts';
import { runDay, type DayData, type DayResult } from './replay.ts';

export interface EvalResult {
  net: number;
  trades: number;
  wins: number;
  winRate: number;
  profitFactor: number;
  worstDay: number;
  profitableDays: number;
  days: number;
  perDay: Array<{ day: string; net: number; trades: number }>;
  byPattern: Record<string, { trades: number; net: number }>;
  /** What the learner maximises: net profit, with a penalty for a bad worst day and too few trades to learn from */
  score: number;
}

/** Plays every saved day with these settings and adds the results up. */
export async function evaluate(days: DayData[], settings: AppSettings, shouldStop?: () => boolean): Promise<EvalResult> {
  const results: DayResult[] = [];
  for (const d of days) {
    results.push(await runDay(d, settings, { shouldStop }));
    if (shouldStop?.()) break;
  }
  return summarise(results);
}

export function summarise(results: DayResult[]): EvalResult {
  const byPattern: EvalResult['byPattern'] = {};
  let net = 0, trades = 0, wins = 0, gw = 0, gl = 0;
  for (const r of results) {
    net += r.net; trades += r.trades; wins += r.wins; gw += r.grossWin; gl += r.grossLoss;
    for (const [k, v] of Object.entries(r.byPattern)) {
      const b = (byPattern[k] ??= { trades: 0, net: 0 });
      b.trades += v.trades; b.net += v.net;
    }
  }
  const worstDay = results.length ? Math.min(...results.map((r) => r.net)) : 0;
  // Too few trades teaches nothing: such a result is never the best.
  const enough = trades >= Math.max(5, results.length * 4);
  const score = enough ? net + 0.5 * Math.min(0, worstDay) : -1e6 + net;
  return {
    net: Math.round(net * 100) / 100,
    trades,
    wins,
    winRate: trades ? Math.round((wins / trades) * 1000) / 10 : 0,
    profitFactor: gl > 0 ? Math.round(Math.min(99, gw / gl) * 100) / 100 : gw > 0 ? 99 : 0,
    worstDay: Math.round(worstDay * 100) / 100,
    profitableDays: results.filter((r) => r.net > 0).length,
    days: results.length,
    perDay: results.map((r) => ({ day: r.day, net: r.net, trades: r.trades })),
    byPattern,
    score: Math.round(score * 100) / 100,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The knobs the learner may turn. Only large caps are traded now, so a value goes into the global entry checks and
// into the large-cap list's own checks (which win over the global ones).
// ---------------------------------------------------------------------------------------------------------------

type CheckKey = keyof EntryChecks;
const CHECK_VALUES: Partial<Record<CheckKey, number[]>> = {
  minScore: [55, 60, 65, 70, 75, 80, 85],
  minVolumeRatio: [0, 1, 1.3, 1.6, 2, 2.5],
  maxStretchPct: [0, 0.3, 0.5, 0.8, 1.2],
  candleStrength: [0, 0.5, 0.6, 0.7],
  roomToTarget: [0, 0.5, 0.8, 1.2],
  trendSlope: [0, 1],
  minAdx: [0, 15, 18, 22, 26],
  macdConfirm: [0, 1],
  slowTrend: [0, 1],
  atrStopMult: [0, 1, 1.5, 2, 2.5],
};
const STOP_WIDTHS = [0.3, 0.4, 0.5, 0.6, 0.8, 1];
const EXIT_PLANS: Array<[number, number, number]> = [[0.5, 1, 1.5], [0.6, 1.1, 1.7], [0.8, 1.4, 2], [1, 1.75, 2.5], [1.2, 2, 3]];

const CHECK_NAMES: Record<string, string> = {
  minScore: 'Minimum pattern score',
  minVolumeRatio: 'Volume vs average',
  maxStretchPct: 'Most stretched from EMA9',
  candleStrength: 'Signal candle strength',
  roomToTarget: 'Room to target 1',
  trendSlope: 'EMA21 slope',
  minAdx: 'Trend strength (ADX)',
  macdConfirm: 'MACD agrees',
  slowTrend: 'EMA50 agrees',
  atrStopMult: 'ATR stop floor',
};

export function clone(s: AppSettings): AppSettings {
  return JSON.parse(JSON.stringify(s)) as AppSettings;
}

export function setCheck(s: AppSettings, key: CheckKey, value: number): void {
  s.entryChecks[key] = value;
  if (key in s.lists.large.checks) s.lists.large.checks[key] = value;
}

export function getCheck(s: AppSettings, key: CheckKey): number {
  return s.lists.large.checks[key] ?? s.entryChecks[key];
}

export type Knob =
  | { kind: 'check'; key: CheckKey }
  | { kind: 'stopWidth' }
  | { kind: 'exitPlan' }
  | { kind: 'short' }
  | { kind: 'pattern'; id: string }
  | { kind: 'vwap' };

export function allKnobs(): Knob[] {
  return [
    ...(Object.keys(CHECK_VALUES) as CheckKey[]).map((key): Knob => ({ kind: 'check', key })),
    { kind: 'stopWidth' }, { kind: 'exitPlan' }, { kind: 'short' }, { kind: 'vwap' },
    ...PATTERNS.map((p): Knob => ({ kind: 'pattern', id: p.id })),
  ];
}

/** Plain name of a knob for the screen */
export function knobName(k: Knob): string {
  switch (k.kind) {
    case 'check': return CHECK_NAMES[k.key] ?? k.key;
    case 'stopWidth': return 'Minimum stop width';
    case 'exitPlan': return 'Targets 1 / 2 / 3';
    case 'short': return 'Short selling';
    case 'vwap': return 'Buy above / short below VWAP';
    case 'pattern': return `Pattern ${k.id}`;
  }
}

/** Current value of a knob, as text */
export function knobValue(s: AppSettings, k: Knob): string {
  switch (k.kind) {
    case 'check': return String(getCheck(s, k.key));
    case 'stopWidth': return `${s.minStopWidthPct}%`;
    case 'exitPlan': return s.exitPlan.enabled ? `${s.exitPlan.t1} / ${s.exitPlan.t2} / ${s.exitPlan.t3}` : 'off';
    case 'short': return s.shortSelling ? 'on' : 'off';
    case 'vwap': return s.requireAboveVwap ? 'on' : 'off';
    case 'pattern': return s.disabledPatterns.includes(k.id) ? 'off' : 'on';
  }
}

/** Sets a knob to one of its allowed values. `pick` returns an index below n (a random one for the learner). */
export function mutate(s: AppSettings, k: Knob, pick: (n: number) => number): void {
  switch (k.kind) {
    case 'check': { const v = CHECK_VALUES[k.key]!; setCheck(s, k.key, v[pick(v.length)]); break; }
    case 'stopWidth': s.minStopWidthPct = STOP_WIDTHS[pick(STOP_WIDTHS.length)]; break;
    case 'exitPlan': { const [t1, t2, t3] = EXIT_PLANS[pick(EXIT_PLANS.length)]; s.exitPlan = { enabled: true, t1, t2, t3 }; break; }
    case 'short': s.shortSelling = !s.shortSelling; break;
    case 'vwap': s.requireAboveVwap = !s.requireAboveVwap; break;
    case 'pattern': s.disabledPatterns = s.disabledPatterns.includes(k.id) ? s.disabledPatterns.filter((x) => x !== k.id) : [...s.disabledPatterns, k.id]; break;
  }
}

/** Turns one thing OFF (for the "what does each check add?" test). */
export function switchOff(s: AppSettings, k: Knob): void {
  switch (k.kind) {
    case 'check': setCheck(s, k.key, 0); break;
    case 'stopWidth': s.minStopWidthPct = 0.3; break;
    case 'exitPlan': s.exitPlan = { ...s.exitPlan, enabled: false }; break;
    case 'short': s.shortSelling = false; break;
    case 'vwap': s.requireAboveVwap = false; break;
    case 'pattern': if (!s.disabledPatterns.includes(k.id)) s.disabledPatterns = [...s.disabledPatterns, k.id]; break;
  }
}

export interface AblationRow {
  name: string;
  value: string;
  netWithout: number;
  tradesWithout: number;
  /** Positive: this check earns money */
  adds: number;
}

/** Runs the days once with each check (or pattern) turned off. A check that adds money when on is worth keeping. */
export async function ablation(
  days: DayData[],
  base: AppSettings,
  onProgress?: (done: number, total: number) => void,
  shouldStop?: () => boolean,
): Promise<{ base: EvalResult; rows: AblationRow[] }> {
  const baseEval = await evaluate(days, base, shouldStop);
  const knobs = allKnobs().filter((k) => k.kind !== 'exitPlan' && k.kind !== 'stopWidth');
  const rows: AblationRow[] = [];
  let i = 0;
  for (const k of knobs) {
    if (shouldStop?.()) break;
    const s = clone(base);
    switchOff(s, k);
    const r = await evaluate(days, s, shouldStop);
    rows.push({ name: knobName(k), value: knobValue(base, k), netWithout: r.net, tradesWithout: r.trades, adds: Math.round((baseEval.net - r.net) * 100) / 100 });
    onProgress?.(++i, knobs.length);
  }
  return { base: baseEval, rows: rows.sort((a, b) => b.adds - a.adds) };
}

export interface RoundLog {
  round: number;
  tried: number;
  best: number;
  net: number;
  trades: number;
  change?: string;
}

export interface OptimizeResult {
  start: EvalResult;
  best: EvalResult;
  settings: AppSettings;
  /** What changed against the settings it started from */
  changes: Array<{ name: string; from: string; to: string }>;
  rounds: RoundLog[];
  stopped: boolean;
}

/** Small seeded random numbers so a run can be repeated exactly. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hill climbing. Each round it tries a few variants (1-2 settings changed at random), plays all saved days for each, and keeps
 * the best one if it beats the current best. After the rounds it returns the best settings and what changed.
 */
export async function optimize(
  days: DayData[],
  base: AppSettings,
  opts: { rounds?: number; variants?: number; seed?: number; onRound?: (log: RoundLog, best: AppSettings) => void; shouldStop?: () => boolean } = {},
): Promise<OptimizeResult> {
  const rounds = opts.rounds ?? 12;
  const variants = opts.variants ?? 6;
  const rand = rng(opts.seed ?? Date.now());
  const pick = (n: number) => Math.floor(rand() * n);
  const knobs = allKnobs();
  let best = clone(base);
  const start = await evaluate(days, best, opts.shouldStop);
  let bestEval = start;
  const log: RoundLog[] = [];
  let stopped = false;
  for (let r = 1; r <= rounds; r++) {
    if (opts.shouldStop?.()) { stopped = true; break; }
    let roundBest: { s: AppSettings; e: EvalResult; change: string } | undefined;
    for (let v = 0; v < variants; v++) {
      if (opts.shouldStop?.()) { stopped = true; break; }
      const s = clone(best);
      const changed: string[] = [];
      for (let m = 0; m < (rand() < 0.5 ? 1 : 2); m++) {
        const k = knobs[pick(knobs.length)];
        const before = knobValue(s, k);
        mutate(s, k, pick);
        const after = knobValue(s, k);
        if (before !== after) changed.push(`${knobName(k)} ${before} → ${after}`);
      }
      if (changed.length === 0) continue;
      const e = await evaluate(days, s, opts.shouldStop);
      if (!roundBest || e.score > roundBest.e.score) roundBest = { s, e, change: changed.join(', ') };
    }
    if (roundBest && roundBest.e.score > bestEval.score) {
      best = roundBest.s;
      bestEval = roundBest.e;
      log.push({ round: r, tried: variants, best: bestEval.score, net: bestEval.net, trades: bestEval.trades, change: roundBest.change });
    } else {
      log.push({ round: r, tried: variants, best: bestEval.score, net: bestEval.net, trades: bestEval.trades });
    }
    opts.onRound?.(log[log.length - 1], best);
    if (stopped) break;
  }
  const changes: OptimizeResult['changes'] = [];
  for (const k of knobs) {
    const a = knobValue(base, k);
    const b = knobValue(best, k);
    if (a !== b) changes.push({ name: knobName(k), from: a, to: b });
  }
  return { start, best: bestEval, settings: best, changes, rounds: log, stopped };
}
