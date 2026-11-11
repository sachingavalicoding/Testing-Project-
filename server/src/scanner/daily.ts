import type { PriceFeed } from '../market/feed.ts';
import { istDate } from '../market/time.ts';
import type { DailyInfo } from './types.ts';

/**
 * Yesterday's high, low, close and volume (and the recent average volume) for each share, from the broker's daily
 * candles. A few requests at a time. The mock feed has only random fake history, so nothing is loaded for it.
 */
export async function loadDaily(
  feed: Pick<PriceFeed, 'name' | 'getCandles'>,
  symbols: readonly string[],
  opts: { concurrency?: number; stillWanted?: () => boolean; today?: string; log?: (msg: string) => void } = {},
): Promise<Map<string, DailyInfo>> {
  const out = new Map<string, DailyInfo>();
  if (feed.name === 'mock') return out;
  const today = opts.today ?? istDate();
  const queue = [...symbols];
  let failed = 0;
  const worker = async () => {
    for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
      if (opts.stillWanted && !opts.stillWanted()) return;
      try {
        const earlier = (await feed.getCandles(s, 'day', 12)).filter((c) => istDate(c.t) < today);
        const last = earlier[earlier.length - 1];
        if (!last) continue;
        const recent = earlier.slice(-5);
        out.set(s, {
          prevHigh: last.h,
          prevLow: last.l,
          prevClose: last.c,
          prevVolume: last.v,
          avgVolume: recent.reduce((x, c) => x + c.v, 0) / recent.length,
        });
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 5) }, worker));
  opts.log?.(`Loaded yesterday's high, low and volume for ${out.size} of ${symbols.length} shares${failed ? ` (${failed} failed)` : ''}`);
  return out;
}
