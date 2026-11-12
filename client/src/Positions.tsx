import { rupee, type Position } from './api.ts';

const pnlColor = (n: number) => (n > 0 ? 'text-green-400' : n < 0 ? 'text-red-400' : 'text-slate-300');

/** One open position as a card: P&L, a price ruler (stop → entry → targets) and the target chips. */
export default function PositionCard({ p, onOpen, onClose, real }: { p: Position; onOpen?: () => void; onClose?: () => void; real?: boolean }) {
  const short = p.side === 'short';
  const stage = p.stage ?? 0;
  const targets = p.targets ?? (p.target ? [p.target] : []);
  const levels = [p.stop, p.entry, p.ltp, ...targets];
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  const span = hi - lo || 1;
  const at = (v: number) => `${Math.min(100, Math.max(0, ((v - lo) / span) * 100))}%`;
  const risk = Math.abs(p.entry - (p.stop0 ?? p.stop)) || 1;
  const r = (short ? p.entry - p.ltp : p.ltp - p.entry) / risk;
  const winning = p.pnl >= 0;
  const stopLocked = short ? p.stop <= p.entry : p.stop >= p.entry;

  return (
    <div className={`rounded-xl border bg-slate-900/80 p-3 shadow-sm ${winning ? 'border-green-400/20' : 'border-red-400/20'}`}>
      <div className="flex items-start justify-between gap-2">
        <button className="text-left" onClick={onOpen}>
          <div className="flex items-center gap-2">
            <span className="text-base font-bold tracking-tight">{p.symbol}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${short ? 'bg-red-400/20 text-red-400' : 'bg-green-400/20 text-green-400'}`}>{short ? 'SHORT' : 'LONG'}</span>
            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">× {p.qty}</span>
          </div>
          <div className="num mt-0.5 text-xs text-slate-400">In {p.entry}{p.estimated ? '*' : ''} · Now <span className="text-slate-100">{p.ltp}</span></div>
        </button>
        <div className="text-right">
          <div className={`num text-lg font-bold leading-tight ${pnlColor(p.pnl)}`}>{p.pnl > 0 ? '+' : ''}{rupee(p.pnl)}</div>
          <div className={`num text-xs ${pnlColor(r)}`}>{r > 0 ? '+' : ''}{r.toFixed(2)}R</div>
        </div>
      </div>

      {/* price ruler: stop on one end, last target on the other */}
      <div className="relative mt-4 mb-6 h-1.5 rounded-full bg-slate-800">
        <div className="absolute inset-y-0 rounded-full bg-gradient-to-r from-red-400/40 via-slate-500/30 to-green-400/50" style={{ left: 0, right: 0, opacity: short ? 0.5 : 1 }} />
        <Marker left={at(p.stop)} label={stopLocked ? 'Locked' : 'Stop'} sub={String(p.stop)} tone="red" />
        <Marker left={at(p.entry)} label="In" sub="" tone="slate" small />
        {targets.map((t, i) => (
          <Marker key={t} left={at(t)} label={targets.length > 1 ? `T${i + 1}` : 'Target'} sub={String(t)} tone={i < stage ? 'green' : 'slate'} reached={i < stage} />
        ))}
        <div className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-slate-950 bg-sky-400 shadow" style={{ left: at(p.ltp) }} title={`Now ${p.ltp}`} />
      </div>

      <div className="flex items-center justify-between">
        <div className="text-[11px] text-slate-500">{p.pattern}</div>
        {onClose && (
          <button className="rounded-md bg-red-400/15 px-2.5 py-1 text-xs font-semibold text-red-400 hover:bg-red-400/25"
            onClick={() => { if (!real || window.confirm(`REAL MONEY: ${short ? 'buy back' : 'sell all'} ${p.symbol}?`)) onClose(); }}>
            {short ? 'Cover' : 'Sell now'}
          </button>
        )}
      </div>
      <details className="mt-1 text-[11px] text-slate-500">
        <summary className="cursor-pointer select-none">Why we took it</summary>
        <p className="mt-1 leading-snug">{p.reason}</p>
      </details>
    </div>
  );
}

function Marker({ left, label, sub, tone, small, reached }: { left: string; label: string; sub: string; tone: 'red' | 'green' | 'slate'; small?: boolean; reached?: boolean }) {
  const dot = tone === 'red' ? 'bg-red-400' : tone === 'green' ? 'bg-green-400' : 'bg-slate-500';
  const text = tone === 'red' ? 'text-red-400' : tone === 'green' ? 'text-green-400' : 'text-slate-500';
  return (
    <div className="absolute top-1/2 -translate-x-1/2" style={{ left }}>
      <div className={`-translate-y-1/2 rounded-full ${dot} ${small ? 'h-2 w-2' : 'h-2.5 w-2.5'} ${reached ? 'ring-2 ring-green-400/30' : ''}`} />
      <div className={`num absolute left-1/2 top-2.5 -translate-x-1/2 whitespace-nowrap text-center text-[9px] leading-tight ${text}`}>
        {label}
        {sub && <div className="opacity-70">{sub}</div>}
      </div>
    </div>
  );
}
