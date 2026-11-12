const IST_OFFSET_MS = 5.5 * 3600_000;

/** Minutes since midnight in India time. */
export function istMinutes(ts = Date.now()): number {
  const d = new Date(ts + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function istDate(ts = Date.now()): string {
  return new Date(ts + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function parseHHMM(text: string): number {
  const [h, m] = text.split(':').map(Number);
  return h * 60 + m;
}

export const MARKET_OPEN = 9 * 60 + 15;
export const MARKET_CLOSE = 15 * 60 + 30;

/** Upstox tokens stop working at 03:30 IST every day. Returns the next such moment after `ts` (epoch ms). */
export function nextTokenExpiry(ts = Date.now()): number {
  const local = ts + IST_OFFSET_MS;
  const dayStart = Math.floor(local / 86_400_000) * 86_400_000;
  let expiry = dayStart + 3.5 * 3600_000;
  if (local >= expiry) expiry += 86_400_000;
  return expiry - IST_OFFSET_MS;
}
