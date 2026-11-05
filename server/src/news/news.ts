export interface NewsItem {
  title: string;
  link: string;
  source: string;
  /** epoch ms */
  ts: number;
}

export interface NewsSummary {
  symbol: string;
  /** Rough mood from headlines: below 0 bad, above 0 good */
  score: number;
  items: NewsItem[];
  /** A results / earnings / board meeting headline in the last 2 days */
  resultsSoon: boolean;
  fetchedAt: number;
}

const GOOD = [
  'profit rises', 'profit jumps', 'profit surges', 'record profit', 'beats estimates', 'wins order', 'bags order',
  'order win', 'upgrade', 'upgraded', 'target raised', 'buy rating', 'surges', 'jumps', 'rallies', 'record high',
  'strong growth', 'dividend', 'bonus', 'buyback', 'approval', 'stake buy', 'expansion',
];
const BAD = [
  'profit falls', 'profit drops', 'loss widens', 'net loss', 'misses estimates', 'downgrade', 'downgraded', 'sell rating',
  'target cut', 'plunges', 'tumbles', 'slumps', 'crashes', 'fraud', 'probe', 'raid', 'penalty', 'fine', 'sebi notice',
  'default', 'resigns', 'resignation', 'recall', 'ban', 'lawsuit', 'insolvency', 'block deal sell', 'promoter sells',
];
const RESULTS = /(q[1-4]\s*(fy\s?\d+)?\s*results?|quarterly results?|earnings|board meeting)/i;

export function scoreHeadline(title: string): number {
  const t = title.toLowerCase();
  let score = 0;
  for (const w of GOOD) if (t.includes(w)) score += 1;
  for (const w of BAD) if (t.includes(w)) score -= 1;
  return Math.max(-2, Math.min(2, score));
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>(.*?)</${name}>`, 's'));
  return m ? decode(m[1]) : '';
}

/** Reads a Google News RSS feed. */
export function parseRss(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>(.*?)<\/item>/gs)) {
    const block = m[1];
    const title = tag(block, 'title');
    if (!title) continue;
    items.push({ title, link: tag(block, 'link'), source: tag(block, 'source'), ts: Date.parse(tag(block, 'pubDate')) || 0 });
  }
  return items;
}

export function summarise(symbol: string, items: NewsItem[], now = Date.now()): NewsSummary {
  const recent = items.filter((i) => i.ts === 0 || now - i.ts < 3 * 86_400_000).slice(0, 8);
  const score = recent.reduce((s, i) => s + scoreHeadline(i.title), 0);
  const resultsSoon = recent.some((i) => RESULTS.test(i.title) && (i.ts === 0 || now - i.ts < 2 * 86_400_000));
  return { symbol, score: Math.max(-4, Math.min(4, score)), items: recent.slice(0, 5), resultsSoon, fetchedAt: now };
}

/** Bad news or results around the corner: do not enter. */
export function shouldBlock(n: NewsSummary): string | undefined {
  if (n.score <= -2) return `bad news (score ${n.score}): ${n.items[0]?.title ?? ''}`;
  if (n.resultsSoon) return 'results / board meeting news in the last 2 days';
  return undefined;
}

/**
 * Headlines per share from Google News (free, no key). Cached so we do not hammer it.
 * News search is by NSE symbol, so a few names may bring unrelated headlines: treat the score as a hint, not a fact.
 */
export class NewsService {
  private cache = new Map<string, NewsSummary>();

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly ttlMs = 10 * 60_000,
    private readonly timeoutMs = 4000,
  ) {}

  async get(symbol: string): Promise<NewsSummary | undefined> {
    const hit = this.cache.get(symbol);
    if (hit && Date.now() - hit.fetchedAt < this.ttlMs) return hit;
    try {
      const q = encodeURIComponent(`"${symbol}" NSE share when:3d`);
      const res = await this.fetchFn(`https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`, {
        headers: { 'User-Agent': 'Mozilla/5.0 StockIQ' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return hit;
      const summary = summarise(symbol, parseRss(await res.text()));
      this.cache.set(symbol, summary);
      return summary;
    } catch {
      return hit; // news is a helper: if it is down, trading and picks still work
    }
  }
}
