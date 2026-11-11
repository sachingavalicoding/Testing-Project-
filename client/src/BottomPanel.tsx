import { useEffect, useState } from 'react';
import { del, get, post, rupee, type EventRow, type Status, type Trade } from './api.ts';

type Tab = 'positions' | 'orders' | 'trades' | 'log';
const pnlColor = (n: number) => (n > 0 ? 'text-green-400' : n < 0 ? 'text-red-400' : 'text-slate-300');

export default function BottomPanel({ status, onSelect }: { status?: Status; onSelect: (s: string) => void }) {
  const [tab, setTab] = useState<Tab>('positions');
  const [err, setErr] = useState<string>();
  const positions = status?.positions ?? [];
  const pending = status?.pending ?? [];
  const real = status?.mode === 'real';

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); setErr(undefined); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="rounded-lg bg-slate-900">
      <div className="flex border-b border-slate-800 text-sm">
        {([['positions', `Positions (${positions.length})`], ['orders', `Waiting orders (${pending.length})`], ['trades', 'Today'], ['log', 'Log']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-3 py-2 ${tab === k ? 'border-b-2 border-sky-500 text-sky-400' : 'text-slate-400'}`}>{l}</button>
        ))}
      </div>
      {err && <div className="m-2 rounded bg-red-900/60 p-2 text-sm">{err}</div>}
      <div className="max-h-64 overflow-auto p-2 text-sm">
        {tab === 'positions' && (positions.length === 0 ? <p className="p-1 text-slate-500">No open positions.</p> : (
          <table className="num w-full">
            <thead className="text-xs text-slate-500"><tr><td>Share</td><td className="px-1.5 text-right">Qty</td><td className="px-1.5 text-right">In</td><td className="px-1.5 text-right">Now</td><td className="px-1.5 text-right">Stop</td><td className="px-1.5 text-right">P&L</td><td /></tr></thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.symbol} className="cursor-pointer border-t border-slate-800" onClick={() => onSelect(p.symbol)}>
                  <td className="py-1.5">{p.symbol} {p.side === 'short' && <span className="rounded bg-red-800 px-1 text-[10px] font-bold">SHORT</span>} <span className="text-xs text-slate-500">{p.pattern}</span></td>
                  <td className="px-1.5 text-right">{p.qty}</td><td className="px-1.5 text-right">{p.entry}</td><td className="px-1.5 text-right">{p.ltp}</td>
                  <td className="px-1.5 text-right">{p.stop}</td><td className={`px-1.5 text-right ${pnlColor(p.pnl)}`}>{rupee(p.pnl)}</td>
                  <td className="pl-2 text-right">
                    <button className="rounded bg-red-800 px-2 py-0.5 text-xs"
                      onClick={(e) => { e.stopPropagation(); if (!real || window.confirm(`REAL MONEY: ${p.side === 'short' ? 'buy back' : 'sell all'} ${p.symbol}?`)) void act(() => post(`/api/positions/${encodeURIComponent(p.symbol)}/close`)); }}>{p.side === 'short' ? 'Cover' : 'Sell'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
        {tab === 'orders' && (pending.length === 0 ? <p className="p-1 text-slate-500">No waiting orders. A limit buy below the price waits here until the price comes down.</p> : (
          <table className="num w-full">
            <tbody>
              {pending.map((o) => (
                <tr key={o.id} className="border-t border-slate-800">
                  <td className="py-1.5">{o.symbol}</td><td>Buy {o.qty}</td><td>at ≤ ₹{o.limitPrice}</td>
                  <td className="text-right"><button className="rounded bg-slate-700 px-2 py-0.5 text-xs" onClick={() => void act(() => del(`/api/orders/${o.id}`))}>Cancel</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
        {tab === 'trades' && <TodayTrades />}
        {tab === 'log' && <LogList />}
      </div>
    </div>
  );
}

function TodayTrades() {
  const [r, setR] = useState<{ trades: Trade[]; net: number; count: number; charges: number }>();
  useEffect(() => {
    const load = () => get<typeof r>('/api/report/today').then(setR).catch(() => undefined);
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  if (!r) return <p className="text-slate-500">Loading…</p>;
  if (r.count === 0) return <p className="p-1 text-slate-500">No finished trades today.</p>;
  return (
    <div>
      <div className="mb-1 text-xs text-slate-400">{r.count} trades · net <span className={pnlColor(r.net)}>{rupee(r.net)}</span> · charges {rupee(r.charges)}</div>
      {r.trades.map((t) => (
        <div key={t.id} className="num flex justify-between border-t border-slate-800 py-1">
          <span>{t.symbol} ×{t.qty} <span className="text-xs text-slate-500">{t.pattern} · {t.exit_reason}</span></span>
          <span className={pnlColor(t.net_pnl)}>{rupee(t.net_pnl)}</span>
        </div>
      ))}
    </div>
  );
}

function LogList() {
  const [rows, setRows] = useState<EventRow[]>([]);
  useEffect(() => {
    const load = () => get<EventRow[]>('/api/events').then(setRows).catch(() => undefined);
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="space-y-1 text-xs">
      {rows.map((r) => (
        <div key={r.id} className={r.level === 'error' ? 'text-red-400' : r.level === 'warn' ? 'text-amber-400' : 'text-slate-300'}>
          <span className="text-slate-500">{new Date(r.ts).toLocaleTimeString('en-IN')}</span> {r.message}
        </div>
      ))}
    </div>
  );
}
