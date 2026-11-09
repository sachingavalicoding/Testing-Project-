import type { MarginInfo, OrderRequest, OrderResult } from '../types.ts';

/**
 * Anything that can take orders. Paper and Upstox both implement this, so the
 * trading code is exactly the same in both modes.
 */
export interface Broker {
  readonly name: string;
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  /** MIS margin for one buy of `qty` shares at `price`. */
  getMargin(symbol: string, qty: number, price: number): Promise<MarginInfo>;
}
