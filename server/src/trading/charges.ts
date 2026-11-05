// Upstox intraday (MIS) equity charges on NSE. Rates change sometimes: check
// https://upstox.com/brokerage-charges/ and update CHARGE_RATES if they differ.
export const CHARGE_RATES = {
  brokerageFlat: 20, // ₹ per executed order...
  brokeragePct: 0.001, // ...or 0.1% of order value, whichever is lower
  sttSellPct: 0.00025, // 0.025% on sell side (intraday)
  exchangePct: 0.0000297, // NSE transaction charge 0.00297%
  sebiPct: 0.000001, // ₹10 per crore
  stampBuyPct: 0.00003, // 0.003% on buy side
  gstPct: 0.18, // on brokerage + exchange + SEBI
};

export interface ChargeBreakdown {
  brokerage: number;
  stt: number;
  exchange: number;
  sebi: number;
  stamp: number;
  gst: number;
  total: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Charges for one full round trip: buy `qty` at `buy` and sell at `sell`. */
export function roundTripCharges(buy: number, sell: number, qty: number, rates = CHARGE_RATES): ChargeBreakdown {
  const buyValue = buy * qty;
  const sellValue = sell * qty;
  const brokerage =
    Math.min(rates.brokerageFlat, buyValue * rates.brokeragePct) + Math.min(rates.brokerageFlat, sellValue * rates.brokeragePct);
  const stt = Math.round(sellValue * rates.sttSellPct);
  const exchange = (buyValue + sellValue) * rates.exchangePct;
  const sebi = (buyValue + sellValue) * rates.sebiPct;
  const stamp = Math.round(buyValue * rates.stampBuyPct);
  const gst = (brokerage + exchange + sebi) * rates.gstPct;
  const total = brokerage + stt + exchange + sebi + stamp + gst;
  return {
    brokerage: r2(brokerage),
    stt: r2(stt),
    exchange: r2(exchange),
    sebi: r2(sebi),
    stamp: r2(stamp),
    gst: r2(gst),
    total: r2(total),
  };
}

/** Net profit (negative = loss) after all charges. */
export function netPnl(buy: number, sell: number, qty: number): number {
  return r2((sell - buy) * qty - roundTripCharges(buy, sell, qty).total);
}
