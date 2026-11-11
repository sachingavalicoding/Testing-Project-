import type { Quote } from '../types.ts';
import { istMinutes, MARKET_OPEN, parseHHMM } from '../market/time.ts';
import type { ScannerSettings } from './types.ts';

export interface MarketRead {
  /** Median share's % change today in the list, the stand-in for the market */
  medianPct: number | undefined;
  /** Share of the list that is inside +/-0.3% today */
  flatShare: number | undefined;
  choppy: boolean;
  /** Plain words */
  text: string;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : undefined;
};

/**
 * Reads the market from the whole share list. The list is the stand-in for Nifty: when its median share is
 * inside +/- chopMovePct and most shares are barely moving, the market is flat and breakouts tend to fail.
 */
export function readMarket(quotes: Quote[], s: ScannerSettings): MarketRead {
  const ch = quotes.filter((q) => q.prevClose > 0).map((q) => ((q.ltp - q.prevClose) / q.prevClose) * 100);
  if (ch.length < 20) return { medianPct: undefined, flatShare: undefined, choppy: false, text: 'Not enough shares with prices to read the market yet' };
  const m = median(ch)!;
  const flat = ch.filter((c) => Math.abs(c) < 0.3).length / ch.length;
  const choppy = Math.abs(m) < s.chopMovePct && flat >= 0.6;
  return {
    medianPct: Math.round(m * 100) / 100,
    flatShare: Math.round(flat * 100) / 100,
    choppy,
    text: choppy
      ? `Market is flat and choppy: the median share is ${m.toFixed(2)}% and ${Math.round(flat * 100)}% of shares are barely moving`
      : `Median share ${m.toFixed(2)}% today, ${Math.round(flat * 100)}% of shares are barely moving`,
  };
}

export type Phase = 'pre-open' | 'waiting' | 'scanning' | 'closed';

/** Where the day is: before the open, the no-entry first minutes, the scan window, or after it. */
export function phaseAt(ts: number, s: ScannerSettings): { phase: Phase; text: string } {
  const m = istMinutes(ts);
  if (m < MARKET_OPEN) return { phase: 'pre-open', text: 'Before the open: building the day watchlist' };
  const from = Math.max(parseHHMM(s.scanFrom), MARKET_OPEN + s.noEntryFirstMinutes);
  if (m < from) return { phase: 'waiting', text: `No entries in the opening minutes. Scanning starts at ${fmt(from)}` };
  if (m > parseHHMM(s.scanTo)) return { phase: 'closed', text: `Scan window ended at ${s.scanTo}` };
  return { phase: 'scanning', text: 'Scanning every minute' };
}

const fmt = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Day-level blocks (apply to every share). Returns the reasons, empty when entries are allowed. */
export function dayBlocks(opts: { market: MarketRead; settings: ScannerSettings; lossToday: number; dailyLossCap: number }): string[] {
  const out: string[] = [];
  const { market, settings } = opts;
  if (settings.blockChoppy && market.choppy) out.push(market.text);
  if (settings.blockAfterLossLimit && opts.lossToday <= -opts.dailyLossCap) {
    out.push(`Daily loss limit reached (lost ₹${Math.abs(Math.round(opts.lossToday))} of ₹${opts.dailyLossCap}): no new trades today`);
  }
  return out;
}
