import { NIFTY_100 } from './nifty100.ts';
import { MIDCAP_100 } from './midcap100.ts';
import { SMALLCAP_100 } from './smallcap100.ts';

export type UniverseId = 'large' | 'mid' | 'small';

export interface UniverseInfo {
  id: UniverseId;
  name: string;
  symbols: readonly string[];
  /** Shown in the app when this list is picked. */
  warning?: string;
}

export const UNIVERSES: Record<UniverseId, UniverseInfo> = {
  large: { id: 'large', name: 'Large cap (Nifty 100)', symbols: NIFTY_100 },
  mid: {
    id: 'mid',
    name: 'Mid cap (Midcap 100)',
    symbols: MIDCAP_100,
    warning: 'Mid caps swing more than large caps and get less leverage. Expect bigger moves, both ways.',
  },
  small: {
    id: 'small',
    name: 'Small cap (Smallcap 100)',
    symbols: SMALLCAP_100,
    warning:
      'Small caps swing the most, fill at worse prices, and often get little or no intraday leverage. Losses can be bigger. Try on paper first.',
  },
};

export function isUniverseId(x: unknown): x is UniverseId {
  return x === 'large' || x === 'mid' || x === 'small';
}
