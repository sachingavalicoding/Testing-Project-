import type { Db } from '../db/db.ts';
import { nextTokenExpiry } from '../market/time.ts';

const KEY = 'upstox_token';

/** Keeps the Upstox access token on the server (in the local database) until Upstox stops accepting it. */
export function saveToken(db: Db, token: string, now = Date.now()): void {
  db.setSetting(KEY, JSON.stringify({ token, expiresAt: nextTokenExpiry(now) }));
}

/** Returns the saved token only if it has not passed its 03:30 IST expiry. */
export function loadToken(db: Db, now = Date.now()): string | undefined {
  const raw = db.getSetting(KEY);
  if (!raw) return undefined;
  try {
    const { token, expiresAt } = JSON.parse(raw) as { token?: string; expiresAt?: number };
    return token && typeof expiresAt === 'number' && now < expiresAt ? token : undefined;
  } catch {
    return undefined;
  }
}

export function clearToken(db: Db): void {
  db.setSetting(KEY, '');
}
