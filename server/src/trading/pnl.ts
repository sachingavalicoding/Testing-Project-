import { netPnl, roundTripCharges } from './charges.ts';

/** A long position is bought first and sold later. A short position is sold first (intraday) and bought back later. */
export type Side = 'long' | 'short';

/** Positions saved before shorting existed have no side: they are long. */
export const sideOf = (p: { side?: Side }): Side => p.side ?? 'long';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Profit before any charges, the number brokers show for an open position. */
export function grossPnl(side: Side, entry: number, exit: number, qty: number): number {
  return r2((side === 'short' ? entry - exit : exit - entry) * qty);
}

/** Profit after all charges. For a short the sell is the entry and the buy is the exit. */
export function netPnlFor(side: Side, entry: number, exit: number, qty: number): number {
  return side === 'short' ? netPnl(exit, entry, qty) : netPnl(entry, exit, qty);
}

export function chargesFor(side: Side, entry: number, exit: number, qty: number): number {
  return side === 'short' ? roundTripCharges(exit, entry, qty).total : roundTripCharges(entry, exit, qty).total;
}
