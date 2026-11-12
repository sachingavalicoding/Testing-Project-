import type { Db } from '../db/db.ts';
import type { PriceFeed } from '../market/feed.ts';
import type { MarketStore } from '../market/store.ts';
import { istDate } from '../market/time.ts';
import type { Candle } from '../types.ts';

/** Saves today's finished 1-minute candles of the given shares, so the day can be replayed and learned from later. Returns how many shares were saved. */
export function recordStore(db: Db, store: MarketStore, symbols: readonly string[], now = Date.now()): number {
  const day = istDate(now);
  const current = Math.floor(now / 60_000) * 60_000;
  let saved = 0;
  for (const s of symbols) {
    const candles = store.candlesFor(s).filter((c) => c.t < current && istDate(c.t) === day);
    if (candles.length === 0) continue;
    db.saveCandles(day, s, candles, store.quote(s)?.prevClose);
    saved++;
  }
  return saved;
}

/**
 * Fetches 1-minute candles of earlier days from the broker and saves them, so there is more than one day to learn from.
 * Needs a feed with getMinuteHistory (Upstox). The previous close of a day is the last close of the day before it.
 */
export async function importHistory(
  feed: Pick<PriceFeed, 'name' | 'getMinuteHistory'>,
  db: Db,
  symbols: readonly string[],
  days: number,
  opts: { concurrency?: number; log?: (m: string) => void } = {},
): Promise<{ shares: number; days: number; failed: number }> {
  if (!feed.getMinuteHistory) throw new Error('This price feed cannot fetch earlier days (log in to Upstox)');
  const today = istDate();
  const seenDays = new Set<string>();
  let shares = 0;
  let failed = 0;
  const queue = [...symbols];
  const worker = async () => {
    for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
      try {
        const all: Candle[] = await feed.getMinuteHistory!(s, days);
        const byDay = new Map<string, Candle[]>();
        for (const c of all) {
          const d = istDate(c.t);
          if (d === today) continue; // today is recorded from the live feed
          (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(c);
        }
        const keys = [...byDay.keys()].sort();
        keys.forEach((d, i) => {
          const list = byDay.get(d)!;
          const prevList = i > 0 ? byDay.get(keys[i - 1]) : undefined;
          // The first day in the batch has no earlier day to take the previous close from: its own open is the closest guess.
          db.saveCandles(d, s, list, prevList?.[prevList.length - 1].c ?? list[0].o);
          seenDays.add(d);
        });
        if (keys.length) shares++;
      } catch (e) {
        failed++;
        opts.log?.(`History for ${s} failed: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 3) }, worker));
  return { shares, days: seenDays.size, failed };
}
