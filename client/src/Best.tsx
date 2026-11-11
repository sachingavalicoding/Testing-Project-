import { useEffect, useState } from 'react';
import { get, post, rupee, type ExitHelp, type LearnStats, type ScannerPick, type ScannerState } from './api.ts';

const levelStyle = { act: 'bg-sky-900/70 border-sky-600', warn: 'bg-amber-900/50 border-amber-600', info: 'bg-slate-800 border-slate-600' } as const;

function useLoad<T>(path: string, every: number): { data?: T; error?: string; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => get<T>(path).then((d) => alive && (setData(d), setError(undefined))).catch((e: Error) => alive && setError(e.message));
    void load();
    const t = setInterval(load, every);
    return () => { alive = false; clearInterval(t); };
  }, [path, every, tick]);
  return { data, error, reload: () => setTick((n) => n + 1) };
}

function Cell({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded bg-slate-800 p-2">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`num text-sm font-semibold ${tone ?? ''}`}>{value}</div>
      {sub && <div className="num text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}

function PickCard({ p, real, onOpen, onBought }: { p: ScannerPick; real: boolean; onOpen: (s: string) => void; onBought: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const pl = p.plan;
  const buy = async () => {
    const text = `Buy ${pl.qty} ${p.symbol} at market with stop ₹${pl.stop.toFixed(2)} and target 2 ₹${pl.target2.toFixed(2)}?`;
    if (!window.confirm(real ? `REAL MONEY: ${text}` : text)) return;
    setBusy(true);
    try {
      await post('/api/orders', { symbol: p.symbol, qty: pl.qty, type: 'market', stopPrice: pl.stop, targetPrice: pl.target2 });
      setMsg({ ok: true, text: 'Bought. Sell half at target 1 yourself; exit help tells you when.' });
      onBought();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-lg bg-slate-900 p-3 text-sm">
      <div className="flex items-center justify-between" onClick={() => onOpen(p.symbol)}>
        <span className="font-semibold">{p.symbol} <span className="num text-slate-400">{p.ltp.toFixed(2)}</span> <span className={`num text-xs ${p.changePct >= 0 ? 'text-green-400' : 'text-red-400'}`}>{p.changePct >= 0 ? '+' : ''}{p.changePct}%</span></span>
        <span className="rounded bg-green-700 px-2 py-0.5 text-xs font-bold">BUY · {p.score}/100</span>
      </div>
      <div className="mb-2 text-xs text-slate-400">{p.setupLabel}</div>

      <div className="grid grid-cols-3 gap-1.5">
        <Cell label="Entry zone" value={`${pl.entryLow.toFixed(2)} – ${pl.entryHigh.toFixed(2)}`} sub="do not chase above" />
        <Cell label="Stop-loss" value={pl.stop.toFixed(2)} sub={`${pl.stopPct}% below`} tone="text-red-300" />
        <Cell label="Quantity" value={String(pl.qty)} sub={`value ${rupee(pl.positionValue)}`} />
        <Cell label="Target 1 (1R)" value={pl.target1.toFixed(2)} sub={`+${rupee(pl.gain1AfterCharges)} net`} tone="text-green-300" />
        <Cell label="Target 2 (2R)" value={pl.target2.toFixed(2)} sub={`+${rupee(pl.gain2AfterCharges)} net`} tone="text-green-300" />
        <Cell label="Reward : risk" value={`1 : ${pl.rr2}`} sub={`risk ${rupee(pl.riskAfterCharges)} net`} />
      </div>
      <div className="mt-1.5 text-xs text-slate-400">Stop: {pl.stopHow}. Sell half at target 1, move the stop to cost, trail the rest, exit at target 2.</div>

      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-slate-300">Why this pick ({p.parts.reduce((s, x) => s + x.points, 0)} points)</summary>
        <ul className="mt-1 space-y-1 text-slate-400">
          {p.parts.map((x) => (
            <li key={x.key}><span className="text-slate-200">{x.label} {x.points}/{x.max}</span>: {x.note}</li>
          ))}
        </ul>
      </details>
      <details className="mt-1 text-xs">
        <summary className="cursor-pointer text-slate-300">Invalid if…</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-400">{pl.invalidIf.map((t) => <li key={t}>{t}</li>)}</ul>
      </details>

      <button disabled={busy} onClick={() => void buy()} className="mt-2 w-full rounded bg-green-700 py-2.5 font-bold disabled:opacity-50">
        {busy ? 'Placing…' : `${real ? 'REAL ' : 'Paper '}buy ${pl.qty} with this plan`}
      </button>
      {msg && <div className={`mt-1 rounded p-1.5 text-xs ${msg.ok ? 'bg-green-900/50' : 'bg-red-900/60'}`}>{msg.text}</div>}
    </section>
  );
}

function ExitHelpPanel() {
  const { data } = useLoad<ExitHelp>('/api/scanner/exit-help', 10_000);
  if (!data?.enabled) return null;
  return (
    <section className="space-y-2">
      <h2 className="font-semibold">Exit help</h2>
      {data.items.length === 0 && <p className="text-xs text-slate-400">No open positions.</p>}
      {data.items.map((it) => (
        <div key={it.symbol} className="rounded-lg bg-slate-900 p-3 text-sm">
          <div className="flex justify-between"><span className="font-semibold">{it.symbol}</span><span className="num text-slate-400">bought {it.entry} · now {it.ltp} · stop {it.stop}</span></div>
          {it.alerts.length === 0 && <div className="text-xs text-slate-500">Nothing to do. The plan is on track.</div>}
          {it.alerts.map((a) => (
            <div key={a.code} className={`mt-1 rounded border-l-4 p-1.5 text-xs ${levelStyle[a.level]}`}>{a.text}</div>
          ))}
        </div>
      ))}
    </section>
  );
}

function ResultsPanel() {
  const { data } = useLoad<LearnStats>('/api/scanner/stats', 60_000);
  if (!data) return null;
  const any = data.bySetup.some((r) => r.picks > 0);
  if (!any) return <p className="text-xs text-slate-500">Your results by setup will show here after picks are shown and you trade them in paper mode.</p>;
  const table = (rows: LearnStats['bySetup']) => (
    <table className="w-full text-xs">
      <thead><tr className="text-left text-slate-400"><th className="py-1">Setup</th><th>Picks</th><th>Taken</th><th>Win %</th><th className="text-right">Net</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-slate-800">
            <td className="py-1">{r.label}{r.off && <span className="ml-1 rounded bg-red-800 px-1 text-[10px]">OFF</span>}</td>
            <td className="num">{r.picks}</td><td className="num">{r.taken}</td><td className="num">{r.taken ? `${r.winRate}%` : '-'}</td>
            <td className={`num text-right ${r.net > 0 ? 'text-green-400' : r.net < 0 ? 'text-red-400' : ''}`}>{rupee(r.net)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <section className="space-y-2 rounded-lg bg-slate-900 p-3">
      <h2 className="font-semibold">Your results</h2>
      <p className="text-xs text-slate-400">Counted from the picks you bought with the plan button in paper mode. A setup is turned off only when learning is on in Settings.</p>
      {table(data.bySetup)}
      <div className="pt-1 text-xs font-semibold text-slate-300">By time of day (when the pick was shown)</div>
      {table(data.byHour)}
    </section>
  );
}

export default function Best({ onPick, real }: { onPick: (s: string) => void; real: boolean }) {
  const { data: s, error, reload } = useLoad<ScannerState>('/api/scanner', 15_000);
  if (error) return <p className="text-red-400">{error}</p>;
  if (!s) return <p className="text-slate-400">Loading…</p>;
  if (!s.enabled) {
    return (
      <div className="rounded-lg bg-slate-900 p-3 text-sm">
        <div className="font-semibold">Best trades now is switched off</div>
        <p className="mt-1 text-slate-400">It finds the few highest-quality intraday trades and gives a full plan for each. Turn it on in Settings, under "Best trades scanner". Nothing is scanned or saved while it is off.</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-slate-900 p-3 text-xs text-slate-300">
        <div className="font-semibold text-slate-100">{s.phaseText}</div>
        <div className="mt-0.5">{s.market?.text}</div>
        <div className="mt-1 text-slate-500">Real prices only. A score is evidence, not a promise: any trade can lose.</div>
      </div>

      {s.blocks && s.blocks.length > 0 && (
        <div className="rounded border border-amber-600 bg-amber-900/40 p-2 text-sm">
          <div className="font-semibold">Entries are blocked</div>
          <ul className="list-disc pl-4 text-xs">{s.blocks.map((b) => <li key={b}>{b}</li>)}</ul>
        </div>
      )}

      {s.noTrade && (
        <div className="rounded-lg bg-slate-900 p-4 text-center">
          <div className="text-2xl font-bold tracking-wide text-slate-200">NO TRADE</div>
          {s.noTradeWhy?.map((w) => <div key={w} className="mt-1 text-xs text-slate-400">{w}</div>)}
        </div>
      )}

      {s.picks?.map((p) => <PickCard key={p.symbol} p={p} real={real} onOpen={onPick} onBought={reload} />)}

      {s.skipped && s.skipped.length > 0 && (
        <section className="rounded-lg bg-slate-900 p-3 text-xs">
          <h2 className="mb-1 text-sm font-semibold">Scored well but left out</h2>
          {s.skipped.map((k) => <div key={k.symbol} className="py-0.5"><span className="font-semibold">{k.symbol}</span> <span className="num text-slate-400">({k.score})</span>: {k.why}</div>)}
        </section>
      )}

      <ExitHelpPanel />

      <section className="rounded-lg bg-slate-900 p-3">
        <h2 className="mb-1 font-semibold">Day watchlist</h2>
        <p className="mb-2 text-xs text-slate-500">{s.watchNote}</p>
        <div className="space-y-1.5">
          {s.watchlist?.map((w) => (
            <details key={w.symbol} className="rounded bg-slate-800 p-2 text-xs">
              <summary className="flex cursor-pointer items-center justify-between" onClick={() => undefined}>
                <span><span className="font-semibold text-sm">{w.symbol}</span> <span className="num text-slate-400">{w.ltp.toFixed(2)}</span> <span className="text-slate-400">gap {w.gapPct}%</span></span>
                <span className="num text-slate-300">{w.liveScore !== undefined ? `live ${w.liveScore}` : `list ${w.score}`}</span>
              </summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-400">{w.why.map((t) => <li key={t}>{t}</li>)}</ul>
              <button className="mt-1 text-sky-400" onClick={() => onPick(w.symbol)}>Open chart</button>
            </details>
          ))}
          {s.watchlist?.length === 0 && <p className="text-xs text-slate-400">No shares yet: prices are still loading.</p>}
        </div>
      </section>

      <ResultsPanel />
    </div>
  );
}
