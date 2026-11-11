import type { TradeRow } from '../db/db.ts';
import { istMinutes } from '../market/time.ts';
import { SETUP_LABELS, type LearnRow, type ScannerSettings, type Setup } from './types.ts';

export interface SavedPick {
  id: number;
  day: string;
  ts: number;
  symbol: string;
  setup: Setup;
  score: number;
}

/**
 * Match your own paper trades (manual buys) to the picks they came from: same share, same day, bought after the
 * pick was first shown. Each trade is used once.
 */
export function matchTrades(picks: SavedPick[], trades: TradeRow[]): Map<number, TradeRow> {
  const used = new Set<number>();
  const out = new Map<number, TradeRow>();
  const mine = trades.filter((t) => t.mode === 'paper' && t.pattern === 'manual');
  for (const p of [...picks].sort((a, b) => a.ts - b.ts)) {
    const t = mine.find((x) => x.id !== undefined && !used.has(x.id) && x.symbol === p.symbol && x.day === p.day && x.entry_ts >= p.ts - 60_000);
    if (t && t.id !== undefined) {
      used.add(t.id);
      out.set(p.id, t);
    }
  }
  return out;
}

function row(key: string, label: string, picks: SavedPick[], matched: Map<number, TradeRow>): LearnRow {
  const trades = picks.map((p) => matched.get(p.id)).filter((t): t is TradeRow => !!t);
  const wins = trades.filter((t) => t.net_pnl > 0).length;
  return {
    key,
    label,
    picks: picks.length,
    taken: trades.length,
    wins,
    losses: trades.length - wins,
    winRate: trades.length ? Math.round((wins / trades.length) * 100) : 0,
    net: Math.round(trades.reduce((s, t) => s + t.net_pnl, 0) * 100) / 100,
  };
}

/** Results by setup and by time of day, and which setups the learner has turned off. */
export function learnStats(picks: SavedPick[], trades: TradeRow[], s: ScannerSettings): { bySetup: LearnRow[]; byHour: LearnRow[]; off: Setup[] } {
  const matched = matchTrades(picks, trades);
  const setups = (Object.keys(SETUP_LABELS) as Setup[]).map((k) => {
    const r = row(k, SETUP_LABELS[k], picks.filter((p) => p.setup === k), matched);
    r.off = s.learn && r.taken >= s.learnMinTrades && r.winRate < s.learnMinWinRate;
    return r;
  });
  const hourOf = (ts: number) => Math.floor(istMinutes(ts) / 60);
  const hours = [...new Set(picks.map((p) => hourOf(p.ts)))].sort((a, b) => a - b);
  const pad = (h: number) => String(h).padStart(2, '0');
  const byHour = hours.map((h) => row(String(h), `${pad(h)}:00 to ${pad(h)}:59`, picks.filter((p) => hourOf(p.ts) === h), matched));
  return { bySetup: setups, byHour, off: setups.filter((r) => r.off).map((r) => r.key as Setup) };
}
