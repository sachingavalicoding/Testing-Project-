export const TICK = 0.05;

export function roundToTick(price: number, dir: 'up' | 'down' | 'nearest' = 'nearest'): number {
  const n = price / TICK;
  const f = dir === 'up' ? Math.ceil(n - 1e-9) : dir === 'down' ? Math.floor(n + 1e-9) : Math.round(n);
  return Math.round(f * TICK * 100) / 100;
}
