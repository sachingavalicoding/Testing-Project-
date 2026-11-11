import { useEffect, useState } from 'react';
import { get, rupee, type AppSettings, type ListRules } from './api.ts';

type Cap = 'large' | 'mid' | 'small';
const names: Record<Cap, string> = { large: 'Large cap', mid: 'Mid cap', small: 'Small cap' };

function Field({ label, hint, value, onChange, step = 1 }: { label: string; hint: string; value: number; onChange: (n: number) => void; step?: number }) {
  return (
    <label className="block py-1.5">
      <span className="flex items-center justify-between text-sm">
        <span>{label}</span>
        <input type="number" inputMode="decimal" step={step} value={Number.isFinite(value) ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
          className="num w-28 rounded bg-slate-800 px-2 py-1 text-right" />
      </span>
      <span className="text-xs text-slate-500">{hint}</span>
    </label>
  );
}

export default function Settings() {
  const [s, setS] = useState<AppSettings>();
  const [active, setActive] = useState<Cap>('large');
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  useEffect(() => {
    get<{ settings: AppSettings; active: Cap }>('/api/settings').then((r) => { setS(r.settings); setActive(r.active); }).catch((e: Error) => setMsg({ ok: false, text: e.message }));
  }, []);
  if (!s) return <p className="text-slate-400">{msg?.text ?? 'Loading…'}</p>;

  const setList = (cap: Cap, patch: Partial<ListRules>) => setS({ ...s, lists: { ...s.lists, [cap]: { ...s.lists[cap], ...patch } } });

  const save = async () => {
    const r = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { setS(j.settings); setMsg({ ok: true, text: 'Saved. New limits apply to the next entries.' }); }
    else setMsg({ ok: false, text: j.error ?? 'Could not save' });
  };

  return (
    <div className="space-y-3">
      {msg && <div className={`rounded p-2 text-sm ${msg.ok ? 'bg-green-900/50' : 'bg-red-900/60'}`}>{msg.text}</div>}

      {(['large', 'mid', 'small'] as Cap[]).map((cap) => (
        <section key={cap} className={`rounded-lg bg-slate-900 p-3 ${active === cap ? 'ring-1 ring-sky-600' : ''}`}>
          <h2 className="mb-1 font-semibold">{names[cap]} {active === cap && <span className="text-xs font-normal text-sky-400">(in use now)</span>}</h2>
          <Field label="Skip if already moved (%)" hint="Do not buy shares that already moved more than this today" step={0.5}
            value={s.lists[cap].maxDayMovePct} onChange={(n) => setList(cap, { maxDayMovePct: n })} />
          <Field label="Risk per trade (₹)" hint="Most you accept to lose on one trade, charges included"
            value={s.lists[cap].riskPerTrade} onChange={(n) => setList(cap, { riskPerTrade: n })} />
          <Field label="Max open positions" hint="How many shares can be held at the same time"
            value={s.lists[cap].maxOpenPositions} onChange={(n) => setList(cap, { maxOpenPositions: n })} />
          <Field label="Paper slippage (%)" hint="Makes paper fills a bit worse, like real life. Small caps slip more" step={0.05}
            value={s.lists[cap].slippagePct} onChange={(n) => setList(cap, { slippagePct: n })} />
        </section>
      ))}

      <section className="rounded-lg bg-slate-900 p-3">
        <h2 className="mb-1 font-semibold">For all lists</h2>
        <Field label="Daily loss cap (₹)" hint={`Sell everything and stop for the day at this loss (now ${rupee(s.dailyLossCap)})`}
          value={s.dailyLossCap} onChange={(n) => setS({ ...s, dailyLossCap: n })} />
        <label className="flex items-center justify-between py-1.5 text-sm">
          <span>Buy only above today's average price (VWAP)<br /><span className="text-xs text-slate-500">Avoids buying while sellers are in control</span></span>
          <input type="checkbox" checked={s.requireAboveVwap} onChange={(e) => setS({ ...s, requireAboveVwap: e.target.checked })} className="h-5 w-5" />
        </label>
        <label className="flex items-center justify-between py-1.5 text-sm">
          <span>Skip shares with bad news or results due<br /><span className="text-xs text-slate-500">Uses news headlines. If news is down, trading goes on</span></span>
          <input type="checkbox" checked={s.newsFilter} onChange={(e) => setS({ ...s, newsFilter: e.target.checked })} className="h-5 w-5" />
        </label>
      </section>

      <section className="rounded-lg bg-slate-900 p-3">
        <h2 className="mb-1 font-semibold">Better entries and profit target</h2>
        <label className="flex items-center justify-between py-1.5 text-sm">
          <span>Only take high quality entries<br /><span className="text-xs text-slate-500">Needs short-term uptrend (EMA9 above EMA21), healthy RSI, price not stretched above VWAP, no entries in the first 10 minutes or after 2:30 PM, and skips the day when most shares are falling</span></span>
          <input type="checkbox" checked={s.qualityGate} onChange={(e) => setS({ ...s, qualityGate: e.target.checked })} className="h-5 w-5" />
        </label>
        <Field label="Profit target (%)" hint="Sell when a share gains this much from the buy price. Minimum 0.75, 1 to 1.5 suits Nifty shares" step={0.25}
          value={s.targetPct} onChange={(n) => setS({ ...s, targetPct: n })} />
        <Field label="Reward to risk (times)" hint="The target must be at least this many times the stop distance, otherwise the trade is skipped" step={0.25}
          value={s.minRewardRisk} onChange={(n) => setS({ ...s, minRewardRisk: n })} />
      </section>

      <button onClick={save} className="w-full rounded bg-sky-700 py-3 font-bold">Save settings</button>
    </div>
  );
}
