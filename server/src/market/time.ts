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
