import { netPnl } from './charges.ts';
import { roundToTick, TICK } from './ticks.ts';

/**
 * First stop for a new long position.
 * Uses `stopPct` below entry, but moves it UP if needed so the loss including
 * all charges can never be more than `maxLoss` rupees.
 */
export function initialStop(entry: number, qty: number, stopPct: number, maxLoss: number): number {
  let stop = roundToTick(entry * (1 - stopPct), 'down');
  // Raise the stop tick by tick until the worst-case loss fits the cap.
  while (stop < entry && -netPnl(entry, stop, qty) > maxLoss) stop = roundToTick(stop + TICK);
  return stop;
}

/**
 * First stop for a new SHORT position: `stopPct` ABOVE the entry, pulled DOWN if needed so the loss including
 * all charges can never be more than `maxLoss` rupees.
 */
export function initialStopShort(entry: number, qty: number, stopPct: number, maxLoss: number): number {
  let stop = roundToTick(entry * (1 + stopPct), 'up');
  while (stop > entry && -netPnl(stop, entry, qty) > maxLoss) stop = roundToTick(stop - TICK);
  return stop;
}

export interface LadderRule {
  /** Every time the share gains this much % from entry, the stop moves up one rung. */
  stepPct: number;
}

/**
 * Percent ladder / profit lock.
 * - Gain of 1 step: stop moves to break-even (entry price plus charges).
 * - Each further step: stop locks one more step of profit.
 * The stop never moves down.
 */
export function ladderStop(entry: number, qty: number, highest: number, currentStop: number, rule: LadderRule): number {
  const gainPct = ((highest - entry) / entry) * 100;
  const rungs = Math.floor(gainPct / rule.stepPct + 1e-9);
  if (rungs < 1) return currentStop;
  let target: number;
  if (rungs === 1) {
    // Break-even including charges.
    target = entry;
    while (netPnl(entry, target, qty) < 0) target = roundToTick(target + TICK);
  } else {
    target = roundToTick(entry * (1 + ((rungs - 1) * rule.stepPct) / 100), 'down');
  }
  return Math.max(currentStop, target);
}

/**
 * Percent ladder for a SHORT, the mirror of ladderStop. `lowest` is the lowest price since the entry.
 * One step down: the stop comes DOWN to break-even (entry minus the charges). Each further step locks one more
 * step of profit. The stop never moves up.
 */
export function ladderStopShort(entry: number, qty: number, lowest: number, currentStop: number, rule: LadderRule): number {
  const gainPct = ((entry - lowest) / entry) * 100;
  const rungs = Math.floor(gainPct / rule.stepPct + 1e-9);
  if (rungs < 1) return currentStop;
  let target: number;
  if (rungs === 1) {
    // Break-even including charges: buy back at `target`, sell was at `entry`.
    target = entry;
    while (netPnl(target, entry, qty) < 0) target = roundToTick(target - TICK);
  } else {
    target = roundToTick(entry * (1 - ((rungs - 1) * rule.stepPct) / 100), 'up');
  }
  return Math.min(currentStop, target);
}

/** How far the three targets sit from the entry, as multiples of the risk (entry to stop distance). */
export interface TargetPlan {
  t1: number;
  t2: number;
  t3: number;
}

/** Prices of target 1, 2 and 3 for a trade: `risk * multiple` above the entry (below it for a short). */
export function buildTargets(entry: number, stop: number, side: 'long' | 'short', plan: TargetPlan): number[] {
  const risk = Math.abs(entry - stop);
  return [plan.t1, plan.t2, plan.t3].map((m) =>
    side === 'short' ? roundToTick(entry - risk * m, 'down') : roundToTick(entry + risk * m, 'up'),
  );
}

export interface StageResult {
  /** Targets reached so far (0 to targets.length) */
  stage: number;
  stop: number;
  /** True when the last target was reached: sell everything */
  done: boolean;
}

/**
 * Staged targets with a trailing stop, for one position.
 * - Target 1 reached: the stop moves to break-even (charges included), so the trade can no longer lose.
 * - Target 2 reached: the stop moves up to target 1.
 * - Target 3 reached: sell everything.
 * The stop never moves the wrong way.
 */
export function advanceTargets(
  side: 'long' | 'short',
  entry: number,
  qty: number,
  ltp: number,
  targets: number[],
  stage: number,
  stop: number,
): StageResult {
  const short = side === 'short';
  let st = stage;
  let nextStop = stop;
  while (st < targets.length && (short ? ltp <= targets[st] : ltp >= targets[st])) {
    st++;
    let lock: number;
    if (st === 1) {
      lock = entry;
      if (short) while (netPnl(lock, entry, qty) < 0) lock = roundToTick(lock - TICK);
      else while (netPnl(entry, lock, qty) < 0) lock = roundToTick(lock + TICK);
    } else {
      lock = targets[st - 2];
    }
    nextStop = short ? Math.min(nextStop, lock) : Math.max(nextStop, lock);
  }
  return { stage: st, stop: nextStop, done: st >= targets.length };
}
