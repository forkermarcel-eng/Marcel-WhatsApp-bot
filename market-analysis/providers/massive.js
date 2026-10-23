import {requireValue, utcMillis, massiveForexInstrument} from '../instruments.js';
import {assessBars} from '../quality.js';
import {requireDataPermission} from '../data-permissions.js';

const origin = 'https://api.massive.com';
export class AnalysisDataError extends Error {
  constructor(code, retryAfterSeconds = null) {
    super(code); this.name = 'AnalysisDataError'; this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
const fail = code => { throw new AnalysisDataError(code); };

/** No ambient process.env/fetch/DB access. Network use needs explicit, dated rights. */
export function createMassiveAdapter({fetcher, mode = 'offline-fixture', authorization = null,
  apiKey = null, releaseEvidence = null, clock = Date.now, maxPages = 12, maxItems = 10000, maxBytes = 2000000,
  timeoutMs = 12000} = {}) {
  requireValue(['offline-fixture', 'network'].includes(mode), 'Invalid adapter mode.');
  requireValue(Number.isInteger(maxPages) && maxPages > 0 && maxPages <= 12 &&
    Number.isInteger(maxItems) && maxItems > 0 && maxItems <= 10000 &&
    Number.isInteger(maxBytes) && maxBytes > 0 && maxBytes <= 8000000 &&
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'Invalid adapter bounds.');
  const grant = authorization ? structuredClone(authorization) : null;
  function permitted(capability) {
    if (typeof fetcher !== 'function') fail('TRANSPORT_NOT_CONFIGURED');
    if (mode === 'offline-fixture') return;
    const now = clock();
    if (!grant || grant.provider !== 'massive' || grant.product !== 'forex' ||
      grant.verified !== true || grant.capabilities?.[capability] !== true ||
      grant.usage !== 'personal-internal' || typeof grant.reference !== 'string' || !grant.reference.trim()) fail('ENTITLEMENT_NOT_CONFIRMED');
    try {
      if (utcMillis(grant.checkedAt) > now || utcMillis(grant.expiresAt) <= now) fail('ENTITLEMENT_EXPIRED');
    } catch (error) {
      if (error instanceof AnalysisDataError) throw error;
      fail('ENTITLEMENT_NOT_CONFIRMED');
    }
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) fail('CREDENTIAL_NOT_CONFIGURED');
    requireDataPermission({id:'massive-forex',networkImplemented:true,url:origin},releaseEvidence,clock());
  }
  function provenance() {
    return {provider: 'massive', product: 'forex', mode,
      entitlementConfirmed: mode === 'network', usage: mode === 'network' ? 'personal-internal' : 'test-only',
      authorizationExpiresAt: mode === 'network' ? grant.expiresAt : null,
      displayToOthersConfirmed: false, observedAt: new Date(clock()).toISOString()};
  }
  async function read(url, signal) {
    if (signal?.aborted) throw new AnalysisDataError('ABORTED');
    const abort = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    let response;
    try {
      response = await fetcher(url.href, {method: 'GET', redirect: 'error',
        signal: abort, headers: mode === 'network' ? {Authorization: 'Bearer ' + apiKey} : {}});
      if (response.status === 429) {
        const raw = response.headers.get('retry-after');
        const retry = raw !== null && /^\d+$/.test(raw) ? Math.min(3600, Number(raw)) : null;
        throw new AnalysisDataError('RATE_LIMITED', retry);
      }
      if (!response.ok) fail(response.status === 401 || response.status === 403 ? 'ACCESS_DENIED' : 'PROVIDER_HTTP_ERROR');
      if (Number(response.headers.get('content-length') || 0) > maxBytes) fail('RESPONSE_TOO_LARGE');
      let raw = '';
      const chunks = []; let bytes = 0;
      // Bound bytes before parsing; no automatic retry or pagination worker.
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const {done, value} = await reader.read(); if (done) break;
            bytes += value.byteLength;
            if (bytes > maxBytes) { await reader.cancel(); fail('RESPONSE_TOO_LARGE'); }
            chunks.push(Buffer.from(value));
          }
          raw = Buffer.concat(chunks).toString('utf8');
        } finally { reader.releaseLock(); }
      } else {
        raw = await response.text();
        if (Buffer.byteLength(raw) > maxBytes) fail('RESPONSE_TOO_LARGE');
      }
      const body = JSON.parse(raw);
      if (body.status !== 'OK' || !Array.isArray(body.results)) fail('PROVIDER_FORMAT_ERROR');
      return body;
    } catch (error) {
      if (error instanceof AnalysisDataError) throw error;
      // Never retain/log URLs, bearer credentials or arbitrary provider bodies.
      throw new AnalysisDataError(signal?.aborted ? 'ABORTED' : abort.aborted ? 'TIMEOUT' : 'PROVIDER_RESPONSE_ERROR');
    }
  }
  async function pages(initial, signal, capability) {
    const seen = new Set(), rows = []; let url = initial;
    for (let page = 0; url; page++) {
      if (page >= maxPages || seen.has(url.href)) fail('PAGINATION_INCOMPLETE');
      permitted(capability);
      seen.add(url.href);
      const body = await read(url, signal);
      if (rows.length + body.results.length > maxItems) fail('ITEM_LIMIT_EXCEEDED');
      rows.push(...body.results);
      if (!body.next_url) break;
      let next;
      try { next = new URL(body.next_url); } catch { fail('INVALID_NEXT_PAGE'); }
      if (next.origin !== origin || next.pathname !== initial.pathname || next.username || next.password || next.hash) fail('INVALID_NEXT_PAGE');
      next.searchParams.delete('apiKey'); next.searchParams.delete('api_key');
      url = next;
    }
    return rows;
  }
  return Object.freeze({
    provider: 'massive', mode,
    async discover({signal} = {}) {
      permitted('catalog');
      const url = new URL('/v3/reference/tickers', origin);
      url.search = new URLSearchParams({market: 'fx', active: 'true', limit: '1000', sort: 'ticker', order: 'asc'});
      const rows = await pages(url, signal, 'catalog'), source = provenance();
      try { return {items: rows.map(row => massiveForexInstrument(row, source)), provenance: source}; }
      catch { fail('INSTRUMENT_FORMAT_ERROR'); }
    },
    async history({instrument, from, to, intervalMs = 60000, delayMs = null,
      maxAgeMs, isExpectedOpen = null, marketStatus = 'unknown', signal} = {}) {
      permitted('history');
      requireValue(instrument?.provider === 'massive' && instrument.environment === 'reference' &&
        instrument.kind === 'fx' && /^C:[A-Z]{6}$/.test(instrument.symbol), 'Only explicitly mapped Massive FX history is supported.');
      const start = utcMillis(from), end = utcMillis(to), now = clock();
      requireValue([60000, 300000, 900000, 3600000, 86400000].includes(intervalMs) &&
        start < end && end <= now && (end - start) / intervalMs <= 10000 &&
        start % intervalMs === 0 && end % intervalMs === 0, 'Invalid bounded history window.');
      assessBars({bars: [], from, to, intervalMs, delayMs, maxAgeMs,
        isExpectedOpen, observedAt: new Date(now).toISOString()});
      const url = new URL('/v2/aggs/ticker/' + instrument.symbol + '/range/' + intervalMs / 60000 + '/minute/' + start + '/' + (end - 1), origin);
      url.search = new URLSearchParams({sort: 'asc', limit: '10000'});
      const rows = await pages(url, signal, 'history');
      const bars = rows.map(row => {
        requireValue(Number.isSafeInteger(row.t), 'Invalid provider timestamp.');
        for (const field of ['o', 'h', 'l', 'c']) requireValue(typeof row[field] === 'number' && Number.isFinite(row[field]) && row[field] > 0, 'Invalid forex price.');
        return {time: new Date(row.t).toISOString(), open: row.o, high: row.h, low: row.l, close: row.c};
      });
      const quality = assessBars({bars, from, to, intervalMs, delayMs, maxAgeMs,
        isExpectedOpen, marketStatus, observedAt: new Date(now).toISOString()});
      if (mode === 'offline-fixture') {
        quality.reasons.push('OFFLINE_FIXTURE'); quality.usableForCurrentMonitoring = false;
      }
      return {...quality, instrumentId: instrument.id, provenance: provenance()};
    },
  });
}
