import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {normalizeInstrument, massiveForexInstrument, matchInstrument, utcMillis} from '../market-analysis/instruments.js';
import {assessQuote, assessBars} from '../market-analysis/quality.js';
import {createInstrumentCatalog} from '../market-analysis/catalog.js';
import {createMassiveAdapter} from '../market-analysis/providers/massive.js';

const releaseEvidence={sourceId:'massive-forex',...Object.fromEntries(['documentation','entitlement','usageRights','activation'].map(k=>[k,{confirmed:true,reference:'OFFLINE-RELEASE-FIXTURE-ONLY',checkedAt:'2026-10-22T00:00:00Z',expiresAt:'2026-10-23T00:00:00Z'}]))};
// Deliberate OFFLINE TEST FIXTURES, not market data or claimed account rights.
const now = Date.parse('2026-10-22T12:00:00Z'), clock = () => now;
const row = (ticker = 'C:EURUSD') => ({ticker, market: 'fx', active: true,
  base_currency_symbol: ticker.slice(2, 5), currency_symbol: ticker.slice(5), name: 'Offline fixture'});
const response = (results, next_url) => new Response(JSON.stringify({status: 'OK', results, next_url}));
const instrument = () => massiveForexInstrument(row(), {mode: 'offline-fixture'});
const grant = () => ({provider: 'massive', product: 'forex', verified: true,
  usage: 'personal-internal', reference: 'OFFLINE-AUTHORIZATION-TEST-ONLY',
  checkedAt: '2026-10-22T11:00:00Z', expiresAt: '2026-10-23T00:00:00Z',
  capabilities: {catalog: true, history: true}});
const bar = (time, close = 1.1) => ({time, open: 1.1, high: 1.3, low: 1, close});

test('provider identities distinguish cash, CFD, futures and separate environments; ambiguous names are not guessed', () => {
  const base = {provider: 'fixture', environment: 'one', symbol: 'INDEX', group: 'indices'};
  const a = normalizeInstrument({...base, kind: 'index'}), b = normalizeInstrument({...base, kind: 'cfd'});
  const c = normalizeInstrument({...base, environment: 'two', kind: 'index'});
  assert.equal(new Set([a.id, b.id, c.id]).size, 3);
  assert.equal(matchInstrument([a, b, c], 'INDEX').status, 'ambiguous');
  assert.equal(matchInstrument([a, b], a.id).status, 'matched');
  assert.equal(matchInstrument([a], 'UNKNOWN').status, 'missing');
  assert.equal(a.metadata.unitsPerLot, null);
  assert.equal(a.metadataComplete, false);
});

test('automatic FX/metal classification keeps missing broker metadata unknown and rejects contradictory currencies', () => {
  assert.equal(massiveForexInstrument(row('C:XAUUSD'), {}).group, 'metals');
  assert.equal(massiveForexInstrument(row('C:USDJPY'), {}).metadata.pipSize, null);
  assert.throws(() => massiveForexInstrument({...row(), currency_symbol: 'JPY'}, {}), /Ambiguous/);
  assert.throws(() => normalizeInstrument({provider: 'x', environment: 'x', symbol: 'x', kind: 'fx', group: 'forex', metadata: {digits: -1}}), /precision/);
  assert.throws(() => utcMillis('2026-02-30T00:00:00Z'), /Invalid/);
  assert.throws(() => utcMillis('2026-10-22T12:00:00'), /timezone/);
});

test('default adapter has no transport and never reads ambient credentials', async () => {
  await assert.rejects(createMassiveAdapter().discover(), {code: 'TRANSPORT_NOT_CONFIGURED'});
  const result = await createInstrumentCatalog({adapter: createMassiveAdapter()}).read();
  assert.equal(result.error, 'TRANSPORT_NOT_CONFIGURED');
  assert.deepEqual(result.items, []);
  assert.equal(result.fetchedAt, null);
});

test('network mode fails closed before any fetch without dated product/usage/capability permission', async () => {
  let requests = 0;
  const fetcher = async () => { requests++; return response([]); };
  for (const authorization of [null, {...grant(), verified: false}, {...grant(), product: 'futures'},
    {...grant(), usage: 'public-display'}, {...grant(), capabilities: {}},
    {...grant(), expiresAt: '2026-10-21T00:00:00Z'}, {...grant(), checkedAt: '2026-10-23T00:00:00Z'}]) {
    await assert.rejects(createMassiveAdapter({releaseEvidence,mode: 'network', apiKey: 'TEST-ONLY', authorization, clock, fetcher}).discover(), /ENTITLEMENT/);
  }
  assert.equal(requests, 0);
});

test('two-page discovery, exact mapping, no credentials in returned URLs/results and no partial writes', async () => {
  const requests = [];
  const adapter = createMassiveAdapter({releaseEvidence,mode: 'network', apiKey: 'OFFLINE-SECRET-FIXTURE', authorization: grant(), clock,
    fetcher: async (url, options) => {
      requests.push(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer OFFLINE-SECRET-FIXTURE');
      assert.ok(!url.includes('OFFLINE-SECRET-FIXTURE') && !url.includes('apiKey='));
      return requests.length === 1 ? response([row()], 'https://api.massive.com/v3/reference/tickers?cursor=2&apiKey=UNTRUSTED') : response([row('C:USDJPY')]);
    }});
  const catalog = createInstrumentCatalog({adapter, clock});
  const result = await catalog.read();
  assert.equal(requests.length, 2); assert.equal(result.items.length, 2);
  assert.equal(result.provenance.displayToOthersConfirmed, false);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  result.items.length = 0;
  assert.equal((await catalog.read()).items.length, 2); assert.equal(requests.length, 2);
});

test('pagination rejects cross-origin, wrong paths, user info, fragments and cycles without forwarding bearer', async () => {
  for (const next of ['https://evil.example/v3/reference/tickers', 'https://api.massive.com/other',
    'https://x:pw@api.massive.com/v3/reference/tickers', 'https://api.massive.com/v3/reference/tickers#bad']) {
    let calls = 0;
    await assert.rejects(createMassiveAdapter({releaseEvidence,clock, fetcher: async () => { calls++; return response([row()], next); }}).discover(), {code: 'INVALID_NEXT_PAGE'});
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(createMassiveAdapter({releaseEvidence,clock, fetcher: async () => {
    calls++; return response([], 'https://api.massive.com/v3/reference/tickers?cursor=same');
  }}).discover(), {code: 'PAGINATION_INCOMPLETE'});
  assert.equal(calls, 2);
});

test('bounded pagination, item limits, HTTP denial/rate limits and malformed bodies fail explicitly', async () => {
  await assert.rejects(createMassiveAdapter({releaseEvidence,maxPages: 1, fetcher: async () => response([], 'https://api.massive.com/v3/reference/tickers?cursor=2')}).discover(), {code: 'PAGINATION_INCOMPLETE'});
  await assert.rejects(createMassiveAdapter({releaseEvidence,maxItems: 1, fetcher: async () => response([row(), row('C:USDJPY')])}).discover(), {code: 'ITEM_LIMIT_EXCEEDED'});
  for (const status of [401, 403, 500]) await assert.rejects(createMassiveAdapter({releaseEvidence,fetcher: async () => new Response('SECRET', {status})}).discover(), {code: status === 500 ? 'PROVIDER_HTTP_ERROR' : 'ACCESS_DENIED'});
  await assert.rejects(createMassiveAdapter({releaseEvidence,fetcher: async () => new Response('', {status: 429, headers: {'Retry-After': '45'}})}).discover(), {code: 'RATE_LIMITED', retryAfterSeconds: 45});
  await assert.rejects(createMassiveAdapter({releaseEvidence,fetcher: async () => new Response('not JSON SECRET')}).discover(), {code: 'PROVIDER_RESPONSE_ERROR'});
  await assert.rejects(createMassiveAdapter({releaseEvidence,fetcher: async () => new Response('{}')}).discover(), {code: 'PROVIDER_FORMAT_ERROR'});
});

test('byte ceilings apply to streaming responses, not just announced content length', async () => {
  const adapter = createMassiveAdapter({releaseEvidence,maxBytes: 20, fetcher: async () => new Response('x'.repeat(21))});
  await assert.rejects(adapter.discover(), {code: 'RESPONSE_TOO_LARGE'});
});

test('cancel and deadline are bounded and raw transport errors never reveal secrets', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(createMassiveAdapter({releaseEvidence,fetcher: async () => { calls++; }}).discover({signal: controller.signal}), {code: 'ABORTED'});
  assert.equal(calls, 0);
  await assert.rejects(createMassiveAdapter({releaseEvidence,fetcher: async () => { throw Error('Bearer SECRET https://private.invalid'); }}).discover(), error => error.message === 'PROVIDER_RESPONSE_ERROR' && !error.stack.includes('SECRET'));
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(createMassiveAdapter({releaseEvidence,timeoutMs: 5, fetcher: async (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Error('deadline')), {once: true});
    })}).discover(), {code: 'TIMEOUT'});
  } finally { clearTimeout(keepAlive); }
});

test('catalog preserves last successful immutable snapshot, timestamps and outage status after failed refresh', async () => {
  let fail = false;
  const adapter = createMassiveAdapter({releaseEvidence,clock, fetcher: async () => fail ? new Response('', {status: 503}) : response([row()])});
  const catalog = createInstrumentCatalog({adapter, clock});
  const first = await catalog.read(); fail = true;
  const failed = await catalog.read({refresh: true});
  assert.equal(failed.stale, true); assert.equal(failed.error, 'PROVIDER_HTTP_ERROR');
  assert.deepEqual(failed.items, first.items); assert.equal(failed.fetchedAt, first.fetchedAt);
  assert.equal((await catalog.read()).stale, true);
  fail = false; assert.equal((await catalog.read({refresh: true})).stale, false);
});

test('incomplete catalog pages and conflicting mappings never replace a good catalog', async () => {
  let stage = 0;
  const catalog = createInstrumentCatalog({clock, adapter: createMassiveAdapter({releaseEvidence,clock, fetcher: async () => {
    if (stage === 0) return response([row()]);
    if (stage === 1) return response([row(), {...row(), name: 'Conflict'}]);
    return response([row('C:USDJPY')], 'https://evil.example/page');
  }})});
  const before = await catalog.read(); stage = 1;
  assert.equal((await catalog.read({refresh: true})).error, 'CATALOG_INVALID'); stage = 2;
  assert.deepEqual((await catalog.read({refresh: true})).items, before.items);
});

test('quote quality does not equate arrival, unknown delay or market closure with freshness', () => {
  const base = {bid: 1.1, ask: 1.2, sourceAt: '2026-10-22T11:59:00Z', receivedAt: '2026-10-22T12:00:00Z', maxAgeMs: 120000, delayMs: 0, marketStatus: 'open'};
  assert.equal(assessQuote(base).usableForCurrentMonitoring, true);
  assert.ok(assessQuote({...base, sourceAt: null}).reasons.includes('SOURCE_TIME_UNKNOWN'));
  assert.ok(assessQuote({...base, sourceAt: '2026-10-22T10:00:00Z'}).reasons.includes('STALE'));
  assert.ok(assessQuote({...base, sourceAt: '2026-10-23T00:00:00Z'}).reasons.includes('FUTURE_SOURCE_TIME'));
  assert.ok(assessQuote({...base, delayMs: null}).reasons.includes('DELAY_UNKNOWN'));
  assert.ok(assessQuote({...base, marketStatus: 'closed'}).reasons.includes('SESSION_NOT_CONFIRMED_OPEN'));
  assert.ok(assessQuote({...base, ask: 1}).reasons.includes('CROSSED_QUOTE'));
});

test('two-page FX history uses requested window, sorts/deduplicates and checks session coverage', async () => {
  const requests = [];
  const from = '2026-10-22T11:58:00Z', to = '2026-10-22T12:00:00Z';
  const r = t => ({t: Date.parse(t), o: 1.1, h: 1.3, l: 1, c: 1.2});
  const adapter = createMassiveAdapter({releaseEvidence,clock, fetcher: async url => {
    requests.push(url);
    return requests.length === 1 ? response([r(from)], 'https://api.massive.com/v2/aggs/ticker/C:EURUSD/range/1/minute/' + Date.parse(from) + '/' + (Date.parse(to) - 1) + '?cursor=2') : response([r('2026-10-22T11:59:00Z'), r(from)]);
  }});
  const result = await adapter.history({instrument: instrument(), from, to, maxAgeMs: 120000, delayMs: 0, isExpectedOpen: () => true});
  assert.equal(requests.length, 2); assert.ok(requests[0].includes(String(Date.parse(from))));
  assert.equal(result.bars.length, 2); assert.equal(result.bars.at(-1).time, '2026-10-22T11:59:00.000Z');
  assert.equal(result.coverage.complete, true); assert.equal(result.provenance.mode, 'offline-fixture');
  assert.equal(result.usableForCurrentMonitoring, false); assert.ok(result.reasons.includes('OFFLINE_FIXTURE'));
});

test('history rejects bad requests before fetch, incomplete and ambiguous data are not fresh complete series', async () => {
  let calls = 0;
  const adapter = createMassiveAdapter({releaseEvidence,clock, fetcher: async () => { calls++; return response([]); }});
  const base = {instrument: instrument(), from: '2026-10-22T11:58:00Z', to: '2026-10-22T12:00:00Z'};
  await assert.rejects(adapter.history(base), /freshness|observation/); assert.equal(calls, 0);
  const quality = {from: base.from, to: base.to, observedAt: base.to, intervalMs: 60000, maxAgeMs: 120000, delayMs: 0};
  assert.equal(assessBars({...quality, bars: [bar(base.from)]}).coverage.complete, null);
  assert.ok(assessBars({...quality, bars: [bar(base.from)], isExpectedOpen: () => true}).reasons.includes('SESSION_GAPS'));
  assert.throws(() => assessBars({...quality, bars: [bar(base.from), bar(base.from, 1.2)]}), /Conflicting/);
  assert.throws(() => assessBars({...quality, bars: [{...bar(base.from), low: 2}]}), /OHLC/);
  assert.throws(() => assessBars({...quality, bars: [bar('2026-10-22T10:00:00Z')]}), /outside/);
  const delayed = assessBars({...quality, bars: [bar(base.from), bar('2026-10-22T11:59:00Z')], delayMs: 60000, isExpectedOpen: () => true});
  assert.equal(delayed.excludedUnpublishedBars, 1); assert.equal(delayed.usableForCurrentMonitoring, false);
  assert.ok(assessBars({...quality, bars: [bar(base.from)]}).reasons.includes('SESSION_NOT_CONFIRMED_OPEN'));
});

test('catalog cache never extends a provider authorization past its expiry', async () => {
  let time = now, calls = 0;
  const adapter = createMassiveAdapter({releaseEvidence,clock: () => time, mode: 'network', apiKey: 'OFFLINE-TEST',
    authorization: {...grant(), expiresAt: '2026-10-22T12:01:00Z'}, fetcher: async () => { calls++; return response([row()]); }});
  const catalog = createInstrumentCatalog({adapter, clock: () => time});
  await catalog.read(); time += 61000;
  const expired = await catalog.read();
  assert.equal(calls, 1); assert.equal(expired.stale, true); assert.equal(expired.error, 'ENTITLEMENT_EXPIRED');
});

test('unknown transport/delay and old historical slices cannot claim current monitoring', async () => {
  const result = assessBars({bars: [bar('2026-10-08T00:00:00Z')], from: '2026-10-08T00:00:00Z', to: '2026-10-08T00:01:00Z', observedAt: '2026-10-22T12:00:00Z', intervalMs: 60000, maxAgeMs: 120000});
  assert.equal(result.usableForCurrentMonitoring, false); assert.ok(result.reasons.includes('STALE'));
  assert.ok(result.reasons.includes('DELAY_UNKNOWN')); assert.equal(result.coverage.complete, null);
});

test('concurrent catalog consumers share one refresh but receive independent snapshots', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const catalog = createInstrumentCatalog({clock, adapter: createMassiveAdapter({releaseEvidence,clock, fetcher: async () => {
    calls++; await gate; return response([row()]);
  }})});
  const a = catalog.read(), b = catalog.read({refresh: true}); release();
  const [one, two] = await Promise.all([a, b]);
  assert.equal(calls, 1); one.items.length = 0; assert.equal(two.items.length, 1);
});

test('authorization is rechecked before each page, not only before the first request', async () => {
  let time = now, calls = 0;
  const adapter = createMassiveAdapter({releaseEvidence,clock: () => time, mode: 'network', apiKey: 'OFFLINE-TEST',
    authorization: {...grant(), expiresAt: '2026-10-22T12:01:00Z'}, fetcher: async () => {
      calls++; time += 61000; return response([row()], 'https://api.massive.com/v3/reference/tickers?cursor=2');
    }});
  await assert.rejects(adapter.discover(), {code: 'ENTITLEMENT_EXPIRED'}); assert.equal(calls, 1);
});

test('FX adapter rejects nonpositive quotes instead of applying unrelated negative-energy-price rules', async () => {
  const adapter = createMassiveAdapter({releaseEvidence,clock, fetcher: async () => response([{t: now - 60000, o: -2, h: -1, l: -3, c: -2}])});
  await assert.rejects(adapter.history({instrument: instrument(), from: '2026-10-22T11:59:00Z', to: '2026-10-22T12:00:00Z', maxAgeMs: 120000}), /forex price/);
});

test('analysis module graph has no protected application imports, storage, ambient provider configuration or background activation', () => {
  for (const file of ['instruments.js', 'quality.js', 'catalog.js', 'providers/massive.js']) {
    const code = fs.readFileSync(new URL('../market-analysis/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /from\s+['"][^'"]*(?:trading-core|Trading\/|brain-organisation|brain-world|Brain\/)|setInterval\s*\(|process\.env\s*[.\[]|storeCandles\s*\(|\.query\s*\(/);
  }
});
