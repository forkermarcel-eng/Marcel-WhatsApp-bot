// Analysis-only identities. No Trading registry, orders or provider credentials.
import {DateTime} from 'luxon';
const groups = new Set(['forex', 'metals', 'indices', 'energy', 'commodities']);
const kinds = new Set(['fx', 'spot', 'index', 'cfd', 'future']);
const metals = new Set(['XAU', 'XAG', 'XPT', 'XPD']);
export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
export function utcMillis(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value), 'An explicit timestamp with timezone is required.');
  const parsed = DateTime.fromISO(value, {setZone: true});
  const ms = parsed.isValid ? parsed.toMillis() : NaN;
  requireValue(Number.isFinite(ms), 'Invalid timestamp.');
  return ms;
}
export function instrumentId({provider, environment, symbol, kind}) {
  for (const part of [provider, environment, symbol, kind]) {
    requireValue(typeof part === 'string' && part.length > 0 && part.length <= 160 && !/[\x00-\x1f]/.test(part), 'Invalid instrument identity.');
  }
  return [provider, environment, kind, symbol].map(encodeURIComponent).join(':');
}
export function normalizeInstrument(input) {
  requireValue(input && groups.has(input.group) && kinds.has(input.kind), 'Unsupported instrument classification.');
  const identity = {provider: input.provider, environment: input.environment, symbol: input.symbol, kind: input.kind};
  const metadata = input.metadata ?? {};
  const positive = key => {
    const value = metadata[key] ?? null;
    requireValue(value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0), 'Invalid numeric instrument metadata.');
    return value;
  };
  const digits = metadata.digits ?? null;
  requireValue(digits === null || (Number.isInteger(digits) && digits >= 0 && digits <= 12), 'Invalid price precision.');
  const contract = {
    digits, tickSize: positive('tickSize'), pipSize: positive('pipSize'),
    unitsPerLot: positive('unitsPerLot'), quantityStep: positive('quantityStep'),
    session: metadata.session ?? null, priceBasis: metadata.priceBasis ?? null,
    shortAllowed: typeof metadata.shortAllowed === 'boolean' ? metadata.shortAllowed : null,
  };
  // A ticker does not prove broker contract size, trading hours or price basis.
  const missing = Object.entries(contract).filter(([, v]) => v === null).map(([k]) => k);
  return {
    id: instrumentId(identity), ...identity, group: input.group,
    name: typeof input.name === 'string' ? input.name.slice(0, 250) : input.symbol,
    base: input.base ?? null, quote: input.quote ?? null,
    active: input.active === true, metadata: contract,
    metadataComplete: missing.length === 0, missingMetadata: missing,
    provenance: structuredClone(input.provenance ?? {mode: 'unknown'}),
  };
}
export function massiveForexInstrument(row, provenance) {
  requireValue(row?.market === 'fx' && /^C:[A-Z]{6}$/.test(row.ticker ?? ''), 'Invalid Massive forex catalog row.');
  requireValue(typeof row.active === 'boolean', 'Missing instrument activity.');
  const base = row.base_currency_symbol, quote = row.currency_symbol;
  requireValue(/^[A-Z]{3}$/.test(base ?? '') && /^[A-Z]{3}$/.test(quote ?? '') && row.ticker === 'C:' + base + quote, 'Ambiguous currency mapping.');
  return normalizeInstrument({
    provider: 'massive', environment: 'reference', symbol: row.ticker,
    kind: metals.has(base) ? 'spot' : 'fx', group: metals.has(base) ? 'metals' : 'forex',
    base, quote, name: row.name, active: row.active, provenance,
    // No unverified digits, pip values, lots or broker sessions are inferred.
  });
}
export function matchInstrument(catalog, query) {
  const exact = catalog.filter(x => x.id === query);
  const candidates = exact.length ? exact : catalog.filter(x => x.symbol === query);
  return {status: candidates.length === 1 ? 'matched' : candidates.length ? 'ambiguous' : 'missing', candidates: candidates.map(x => x.id)};
}
