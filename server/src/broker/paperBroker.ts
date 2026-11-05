import { randomUUID } from 'node:crypto';
import type { MarginInfo, OrderRequest, OrderResult } from '../types.ts';
import type { Broker } from './broker.ts';

/**
 * Pretend broker. Fills market orders at the current price, so paper and real
 * use exactly the same trading code.
 */
export class PaperBroker implements Broker {
  readonly name = 'paper';

  constructor(
    private readonly priceOf: (symbol: string) => number | undefined,
    /** Real margin source (Upstox) when logged in; otherwise a fixed guess. */
    private readonly marginSource?: (symbol: string, qty: number, price: number) => Promise<MarginInfo>,
    private readonly fallbackLeverage = 5,
  ) {}

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const price = req.limitPrice ?? this.priceOf(req.symbol);
    if (price === undefined) return { orderId: '', status: 'rejected', filledQty: 0, message: 'No price yet' };
    return { orderId: `paper-${randomUUID()}`, status: 'filled', avgPrice: price, filledQty: req.qty };
  }

  async getMargin(symbol: string, qty: number, price: number): Promise<MarginInfo> {
    if (this.marginSource) {
      try {
        return await this.marginSource(symbol, qty, price);
      } catch {
        // fall through to the guess below
      }
    }
    return { symbol, leverage: this.fallbackLeverage, marginPerShare: price / this.fallbackLeverage };
  }
}
