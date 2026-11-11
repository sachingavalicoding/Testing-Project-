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
