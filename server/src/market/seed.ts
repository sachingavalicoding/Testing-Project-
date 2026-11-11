import type { PriceFeed } from './feed.ts';
import type { MarketStore } from './store.ts';
import { istDate } from './time.ts';

/**
 * Loads today's 1-minute candles for every share so the patterns (opening range, EMA, RSI, VWAP, pullbacks)
 * have the whole day to look at straight away, not only the minutes since the server started or the list changed.
 * Runs a few requests at a time to stay inside the broker's rate limit. Returns how many shares were loaded.
 */
export async function seedHistory(
  feed: Pick<PriceFeed, 'name' | 'getCandles'>,
  store: MarketStore,
  symbols: readonly string[],
  opts: { concurrency?: number; stillWanted?: () => boolean; log?: (msg: string) => void } = {},
): Promise<number> {
  if (feed.name === 'mock') return 0; // fake history is random, do not mix it into the live candles
  const queue = [...symbols];
  const today = istDate();
  let loaded = 0;
  let failed = 0;
  const worker = async () => {
    for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
      if (opts.stillWanted && !opts.stillWanted()) return; // the share list was switched meanwhile
      try {
        const candles = (await feed.getCandles(s, '1minute', 1)).filter((c) => istDate(c.t) === today);
        if (candles.length) {
          store.seedCandles(s, candles);
          loaded++;
        }
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 5) }, worker));
  opts.log?.(`Loaded today's candles for ${loaded} of ${symbols.length} shares${failed ? ` (${failed} failed)` : ''}`);
  return loaded;
}
