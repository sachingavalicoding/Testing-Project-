export interface SizingInput {
  price: number;
  /** Cash still free (capital minus margin already blocked) */
  freeCash: number;
  /** Margin Upstox blocks for one share (from the margin API) */
  marginPerShare: number;
  /** Max rupees you agree to lose on this trade */
  riskPerTrade: number;
  /** Planned stop distance as a fraction of price, e.g. 0.01 = 1% */
  stopPct: number;
  /**
   * Your own money to put into each trade (margin), e.g. 20000. Upstox MIS leverage then multiplies it
   * (about 5x: 20000 buys about 1 lakh of shares). When set, the size comes from this and not from riskPerTrade.
   */
  capitalPerTrade?: number;
}

/**
 * How many shares to buy.
 * - With a capital per trade: that much margin (never more than the free cash).
 * - Otherwise the smaller of what the free cash can hold at the real MIS margin and what keeps the
 *   planned stop loss within riskPerTrade.
 */
export function positionSize(i: SizingInput): number {
  if (i.price <= 0 || i.marginPerShare <= 0 || i.stopPct <= 0) return 0;
  if (i.capitalPerTrade && i.capitalPerTrade > 0) return Math.max(0, Math.floor(Math.min(i.capitalPerTrade, i.freeCash) / i.marginPerShare));
  const byMargin = Math.floor(i.freeCash / i.marginPerShare);
  const byRisk = Math.floor(i.riskPerTrade / (i.price * i.stopPct));
  return Math.max(0, Math.min(byMargin, byRisk));
}
