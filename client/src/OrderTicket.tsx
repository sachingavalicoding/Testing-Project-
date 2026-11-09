import { useEffect, useState } from 'react';
import { post, rupee, type Quote, type Status } from './api.ts';

const INPUT = 'num w-28 rounded bg-slate-800 px-2 py-1 text-right';

function NumField({ label, value, onChange, step = 1, placeholder }: { label: string; value: string; onChange: (v: string) => void; step?: number; placeholder?: string }) {
  return (
    <label className="flex items-center justify-between py-1 text-sm">
      <span className="text-slate-300">{label}</span>
      <input type="number" inputMode="decimal" step={step} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={INPUT} />
    </label>
  );
}

export default function OrderTicket({ symbol, quote, status }: { symbol: string; quote?: Quote; status?: Status }) {
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [type, setType] = useState<'market' | 'limit'>('market');
  const [qty, setQty] = useState('1');
  const [limit, setLimit] = useState('');
  const [stop, setStop] = useState('');
  const [target, setTarget] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);

  const ltp = quote?.ltp;
  const position = status?.positions.find((p) => p.symbol === symbol);
  const ref = type === 'limit' && Number(limit) > 0 ? Number(limit) : ltp;
  const q = Math.floor(Number(qty));
  const stopN = Number(stop);
  const risk = ref && stopN > 0 && stopN < ref && q > 0 ? (ref - stopN) * q : undefined;
  const real = status?.mode === 'real';

  // New share: start a fresh ticket.
  useEffect(() => { setLimit(''); setStop(''); setTarget(''); setMsg(undefined); }, [symbol]);

  const pctStop = (p: number) => ref && setStop((Math.floor((ref * (1 - p / 100)) * 20) / 20).toFixed(2));
  const pctTarget = (p: number) => ref && setTarget((Math.ceil((ref * (1 + p / 100)) * 20) / 20).toFixed(2));

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); setMsg({ ok: true, text: done }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    setBusy(false);
  };

  const buy = () => {
    if (real && !window.confirm(`REAL MONEY: buy ${q} ${symbol}${type === 'limit' ? ` at ₹${limit} or lower` : ' at market'}?`)) return;
    void run(
      () => post('/api/orders', {
        symbol, qty: q, type,
        limitPrice: type === 'limit' ? Number(limit) : undefined,
        stopPrice: stop ? stopN : undefined,
        stopPct: stop ? undefined : 1,
        targetPrice: target ? Number(target) : undefined,
      }),
      type === 'limit' ? 'Waiting order placed' : 'Bought',
    );
  };

  const sell = () => {
    if (real && !window.confirm(`REAL MONEY: sell all ${position?.qty} ${symbol} now?`)) return;
    void run(() => post(`/api/positions/${encodeURIComponent(symbol)}/close`), 'Sold');
  };

  return (
    <div className="rounded-lg bg-slate-900 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold">{symbol}</span>
        <span className="num text-sm">{ltp ? `₹${ltp.toFixed(2)}` : '…'}</span>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-1">
        <button onClick={() => setSide('BUY')} className={`rounded py-2 font-bold ${side === 'BUY' ? 'bg-green-700' : 'bg-slate-800 text-slate-400'}`}>Buy</button>
        <button onClick={() => setSide('SELL')} className={`rounded py-2 font-bold ${side === 'SELL' ? 'bg-red-700' : 'bg-slate-800 text-slate-400'}`}>Sell</button>
      </div>

      {side === 'BUY' ? (
        <>
          <div className="mb-2 grid grid-cols-2 gap-1 text-sm">
            {(['market', 'limit'] as const).map((t) => (
              <button key={t} onClick={() => setType(t)} className={`rounded py-1 capitalize ${type === t ? 'bg-sky-700' : 'bg-slate-800'}`}>{t}</button>
            ))}
          </div>
          <NumField label="Quantity" value={qty} onChange={setQty} />
          {type === 'limit' && <NumField label="Buy at or below ₹" value={limit} onChange={setLimit} step={0.05} placeholder={ltp?.toFixed(2)} />}
          <NumField label="Stop-loss ₹" value={stop} onChange={setStop} step={0.05} placeholder="auto 1%" />
          <div className="mb-1 flex justify-end gap-1 text-xs">
            {[0.5, 1, 2].map((p) => <button key={p} onClick={() => pctStop(p)} className="rounded bg-slate-800 px-2 py-0.5">-{p}%</button>)}
          </div>
          <NumField label="Target ₹ (optional)" value={target} onChange={setTarget} step={0.05} />
          <div className="mb-2 flex justify-end gap-1 text-xs">
            {[1, 2, 3].map((p) => <button key={p} onClick={() => pctTarget(p)} className="rounded bg-slate-800 px-2 py-0.5">+{p}%</button>)}
          </div>
          <div className="mb-3 space-y-0.5 text-xs text-slate-400">
            {ref && q > 0 && <div>Value ≈ {rupee(ref * q)} · free cash {rupee(status?.freeCash ?? 0)}</div>}
            {risk !== undefined && <div>If the stop is hit you lose about {rupee(risk)} + charges</div>}
            {!stop && <div>No stop typed: a 1% stop is set for you</div>}
          </div>
          <button disabled={busy || !ltp || !(q > 0)} onClick={buy}
            className={`w-full rounded py-3 font-bold disabled:opacity-40 ${real ? 'bg-red-600' : 'bg-green-700'}`}>
            BUY {symbol} · {real ? 'REAL' : 'PAPER'}
          </button>
        </>
      ) : position ? (
        <div className="space-y-2 text-sm">
          <div className="num flex justify-between"><span>Holding</span><span>{position.qty} @ {position.entry}</span></div>
          <div className="num flex justify-between"><span>Stop</span><span>{position.stop}</span></div>
          <div className="num flex justify-between"><span>Profit / loss now</span>
            <span className={position.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>{rupee(position.pnl)}</span></div>
          <button disabled={busy} onClick={sell} className="w-full rounded bg-red-700 py-3 font-bold disabled:opacity-40">SELL ALL {symbol} · {real ? 'REAL' : 'PAPER'}</button>
        </div>
      ) : (
        <p className="text-sm text-slate-400">You do not hold {symbol}. Short selling is not allowed here, so there is nothing to sell.</p>
      )}

      {msg && <div className={`mt-3 rounded p-2 text-sm ${msg.ok ? 'bg-green-900/50' : 'bg-red-900/60'}`}>{msg.text}</div>}
    </div>
  );
}
