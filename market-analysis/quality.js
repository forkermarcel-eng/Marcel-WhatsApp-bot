import {requireValue, utcMillis} from './instruments.js';

export function assessQuote({bid = null, ask = null, last = null, sourceAt = null, receivedAt,
  maxAgeMs, delayMs = null, marketStatus = 'unknown'}) {
  const received = utcMillis(receivedAt);
  requireValue(Number.isFinite(maxAgeMs) && maxAgeMs >= 0, 'A freshness budget is required.');
  requireValue(delayMs === null || (Number.isFinite(delayMs) && delayMs >= 0), 'Invalid delay.');
  for (const x of [bid, ask, last]) requireValue(x === null || (typeof x === 'number' && Number.isFinite(x)), 'Invalid quote price.');
  const source = sourceAt === null ? null : utcMillis(sourceAt);
  const reasons = [];
  if (source === null) reasons.push('SOURCE_TIME_UNKNOWN');
  else if (source > received) reasons.push('FUTURE_SOURCE_TIME');
  else if (received - source > maxAgeMs) reasons.push('STALE');
  if (bid === null && ask === null && last === null) reasons.push('PRICE_MISSING');
  if (bid !== null && ask !== null && ask < bid) reasons.push('CROSSED_QUOTE');
  if (marketStatus !== 'open') reasons.push('SESSION_NOT_CONFIRMED_OPEN');
  if (delayMs === null) reasons.push('DELAY_UNKNOWN');
  return {bid, ask, last, sourceAt, receivedAt, marketStatus, delayMs,
    ageMs: source === null ? null : received - source,
    usableForCurrentMonitoring: reasons.length === 0, reasons};
}

// Validated historical bars are not automatically complete or a current quote.
export function assessBars({bars, from, to, observedAt, intervalMs, delayMs = null,
  maxAgeMs, isExpectedOpen = null, marketStatus = 'unknown'}) {
  const start = utcMillis(from), end = utcMillis(to), observed = utcMillis(observedAt);
  requireValue(Number.isInteger(intervalMs) && intervalMs > 0 && start < end &&
    start % intervalMs === 0 && end % intervalMs === 0, 'Invalid aligned bar window.');
  requireValue(end <= observed && Number.isFinite(maxAgeMs) && maxAgeMs >= 0, 'Invalid observation window.');
  requireValue(delayMs === null || (Number.isFinite(delayMs) && delayMs >= 0), 'Invalid delay.');
  requireValue(Array.isArray(bars) && bars.length <= 10000 && (end - start) / intervalMs <= 10000, 'Bar window exceeds local limit.');
  const map = new Map();
  for (const bar of bars) {
    const time = utcMillis(bar.time);
    requireValue(time >= start && time < end && time % intervalMs === 0, 'Bar outside requested interval.');
    for (const field of ['open', 'high', 'low', 'close']) requireValue(typeof bar[field] === 'number' && Number.isFinite(bar[field]), 'Invalid OHLC price.');
    requireValue(bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close) && bar.low <= bar.high, 'Invalid OHLC range.');
    const old = map.get(time);
    requireValue(!old || JSON.stringify(old) === JSON.stringify(bar), 'Conflicting bars at the same timestamp.');
    map.set(time, structuredClone(bar));
  }
  const sorted = [...map].sort(([a], [b]) => a - b);
  const closed = sorted.filter(([at]) => at + intervalMs <= observed - (delayMs ?? 0));
  const lastEnd = closed.length ? closed.at(-1)[0] + intervalMs : null;
  const reasons = [];
  if (closed.length < sorted.length) reasons.push('UNPUBLISHED_BARS_EXCLUDED');
  if (!closed.length) reasons.push('NO_CLOSED_BARS');
  if (lastEnd !== null && observed - lastEnd > maxAgeMs) reasons.push('STALE');
  if (delayMs === null) reasons.push('DELAY_UNKNOWN');
  if (marketStatus !== 'open') reasons.push('SESSION_NOT_CONFIRMED_OPEN');
  const missing = [];
  if (isExpectedOpen) {
    requireValue(typeof isExpectedOpen === 'function', 'Invalid session predicate.');
    for (let at = start; at < end; at += intervalMs) {
      const expected = isExpectedOpen(new Date(at).toISOString());
      requireValue(typeof expected === 'boolean', 'Session predicate must return a boolean.');
      if (expected && !map.has(at)) missing.push(new Date(at).toISOString());
    }
    if (missing.length) reasons.push('SESSION_GAPS');
  } else reasons.push('SESSION_COVERAGE_UNKNOWN');
  return {bars: closed.map(([, bar]) => bar), excludedUnpublishedBars: sorted.length - closed.length,
    sourceAt: closed.length ? closed.at(-1)[1].time : null, observedAt,
    intervalMs, delayMs, priceBasis: 'provider-quotes',
    coverage: {complete: isExpectedOpen ? missing.length === 0 : null, missing},
    usableForCurrentMonitoring: reasons.length === 0, reasons};
}
