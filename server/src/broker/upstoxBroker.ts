import type { MarginInfo, OrderRequest, OrderResult } from '../types.ts';
import type { Broker } from './broker.ts';
import type { UpstoxClient } from './upstoxClient.ts';

/** Real Upstox orders. Only reachable when REAL_TRADING_ENABLED=true and the user switched to real mode. */
export class UpstoxBroker implements Broker {
  readonly name = 'upstox';

  constructor(private readonly client: UpstoxClient) {}

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const body = {
      quantity: req.qty,
      product: 'I', // intraday (MIS)
      validity: 'DAY',
      price: req.limitPrice ?? 0,
      tag: 'stockiq',
      instrument_token: this.client.keyFor(req.symbol),
      order_type: req.limitPrice === undefined ? 'MARKET' : 'LIMIT',
      transaction_type: req.side,
      disclosed_quantity: 0,
      trigger_price: 0,
      is_amo: false,
    };
    const data = await this.client.request<{ order_id: string }>('POST', this.client.hft('/v2/order/place'), body);
    // Fill details come later from the order book (reconciliation step).
    return { orderId: data.order_id, status: 'open', filledQty: 0 };
  }

  async getMargin(symbol: string, qty: number, price: number): Promise<MarginInfo> {
    const data = await this.client.request<{ required_margin: number }>('POST', this.client.api('/v2/charges/margin'), {
      instruments: [
        { instrument_key: this.client.keyFor(symbol), quantity: qty, transaction_type: 'BUY', product: 'I', price },
      ],
    });
    const required = data.required_margin;
    const value = qty * price;
    if (!(required > 0)) return { symbol, leverage: 1, marginPerShare: price };
    return { symbol, leverage: value / required, marginPerShare: required / qty };
  }
}
