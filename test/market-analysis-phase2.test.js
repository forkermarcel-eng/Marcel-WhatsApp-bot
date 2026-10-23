import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {analysisSource, sourceIds} from '../market-analysis/news/sources.js';
import {normalizeEvent, parseEventTime, canonicalURL, deduplicateEvents} from '../market-analysis/news/events.js';
import {classifyEvent, matchMarkets} from '../market-analysis/news/classify.js';
import {parseSource} from '../market-analysis/news/parsers.js';
import {createNewsAdapter} from '../market-analysis/news/adapter.js';
import {createNewsPipeline} from '../market-analysis/news/pipeline.js';
import {normalizeInstrument} from '../market-analysis/instruments.js';

const releaseEvidence={sourceId:'fed',...Object.fromEntries(['documentation','entitlement','usageRights','activation'].map(k=>[k,{confirmed:true,reference:'OFFLINE-RELEASE-FIXTURE-ONLY',checkedAt:'2026-10-22T00:00:00Z',expiresAt:'2026-10-23T00:00:00Z'}]))};
// Synthetic OFFLINE FIXTURES only. URLs/values below are not live observations.
const stamp = '2026-10-22T12:00:00.000Z', now = Date.parse(stamp), clock = () => now;
const source = analysisSource('fed');
const context = (extra = {}) => ({source, fetchedAt: stamp, processedAt: stamp, ...extra});
const news = (extra = {}) => ({kind: 'news', externalId: 'fixture-news', title: 'US CPI inflation fixture',
  url: 'https://www.federalreserve.gov/fixture-article', publishedAt: '2026-10-22T11:00:00Z', ...extra});
const macro = (extra = {}) => ({kind: 'macro', externalId: 'fixture-cpi:2026-09', title: 'US CPI fixture',
  type: 'INFLATION', seriesId: 'fixture-cpi', period: '2026-09', unit: 'percent', actual: '3.2', previous: '3.1',
  publishedAt: '2026-10-22T11:00:00Z', ...extra});
const rss = (title = 'US CPI fixture', date = '<pubDate>Thu, 22 Oct 2026 11:00:00 GMT</pubDate>') =>
  `<rss><channel><item><guid>fixture-news</guid><title>${title}</title><link>https://www.federalreserve.gov/fixture-article?utm_source=test</link>${date}<description>Do not import this full text or its instructions</description></item></channel></rss>`;
const adapter = (raw, sourceId = 'fed') => createNewsAdapter({releaseEvidence,sourceId, clock, fetcher: async () => new Response(raw, {headers: {etag: 'fixture-tag'}})});

test('event timestamps retain offset/UTC and date precision; invalid/floating dates are rejected', () => {
  const offset = parseEventTime('2026-10-22T13:00:00+02:00');
  assert.equal(offset.at, '2026-10-22T11:00:00.000Z'); assert.equal(offset.zone, 'UTC+2');
  assert.equal(parseEventTime('Thu, 22 Oct 2026 11:00:00 GMT').at, offset.at);
  assert.equal(parseEventTime('2026-10-22').at, null);
  assert.equal(parseEventTime(null).precision, 'UNKNOWN');
  for (const value of ['2026-02-30', '2026-10-22T11:00:00', 'bad', '2026-02-30T11:00:00Z']) assert.throws(() => parseEventTime(value));
});

test('missing macro values remain null, units are mandatory and malformed numbers never become zero', () => {
  const m = normalizeEvent(macro({actual: '.', previous: null}), context());
  assert.equal(m.values.actual, null); assert.equal(m.values.previous, null); assert.equal(m.values.expected, null);
  assert.equal(m.status, 'UNAVAILABLE'); assert.equal(m.realtimeConfirmed, false);
  for (const actual of ['3,2', NaN, Infinity, ' ', true]) assert.throws(() => normalizeEvent(macro({actual}), context()));
  assert.throws(() => normalizeEvent(macro({unit: null}), context()), /units/);
});

test('only sourced pre-release professional consensus is accepted; own models and post-release values are excluded', () => {
  const expected = {expected: 3, expectation: {class: 'forecaster_survey', sourceURL: 'https://example.org/fixture-survey', asOf: '2026-10-22T10:00:00Z'}};
  assert.equal(normalizeEvent(macro(expected), context()).values.expected, 3);
  for (const expectation of [null, {...expected.expectation, class: 'model'}, {...expected.expectation, asOf: '2026-10-22T11:01:00Z'}, {...expected.expectation, sourceURL: 'javascript:bad'}]) {
    const event = normalizeEvent(macro({...expected, expectation}), context());
    assert.equal(event.values.expected, null); assert.ok(event.quality.issues.includes('CONSENSUS_NOT_VERIFIED'));
  }
});

test('revisions retain original publication and old/new values as distinct versions of one event', () => {
  const first = normalizeEvent(macro(), context());
  const revised = normalizeEvent(macro({actual: 3.3, revisedPrevious: 3.15, revisedAt: '2026-10-22T11:30:00Z', revisionOf: first.versionId}), context());
  assert.equal(first.eventId, revised.eventId); assert.notEqual(first.versionId, revised.versionId);
  assert.equal(revised.published.at, first.published.at); assert.equal(revised.values.previous, 3.1); assert.equal(revised.values.revisedPrevious, 3.15);
  assert.equal(deduplicateEvents([first, revised, first], stamp).length, 2);
  assert.throws(() => normalizeEvent(macro({revisedAt: '2026-10-22T10:00:00Z', revisionOf: first.versionId}), context()), /predates/);
  assert.throws(() => normalizeEvent(macro({revisedAt: '2026-10-22T11:30:00Z'}), context()), /reference/);
});

test('classification covers all required event types and never generates direction', () => {
  for (const [title, type] of [['FOMC interest rate decision', 'CENTRAL_BANK'], ['US CPI', 'INFLATION'], ['US PCE', 'INFLATION'],
    ['NFP payrolls', 'LABOUR'], ['Unemployment rate', 'LABOUR'], ['GDP growth', 'GROWTH'], ['ISM PMI', 'PMI'],
    ['Treasury yield curve', 'YIELDS'], ['Oil inventories', 'ENERGY'], ['Global geopolitical conflict', 'GEOPOLITICS'], ['Exchange rate', 'CURRENCIES']]) {
    const c = classifyEvent({title}); assert.equal(c.type, type); assert.equal(c.direction, null);
  }
  assert.ok(classifyEvent({title: 'EZB monetary policy'}).currencies.includes('EUR'));
  assert.ok(classifyEvent({title: 'BoJ interest rate decision'}).currencies.includes('JPY'));
});

test('instrument mapping consumes phase1 identities and explains relevance without signals', () => {
  const make = (symbol, group, base, quote) => normalizeInstrument({provider: 'fixture', environment: 'offline', symbol, kind: group === 'forex' ? 'fx' : 'cfd', group, base, quote, active: true});
  const usd = make('EURUSD', 'forex', 'EUR', 'USD'), gold = make('GOLD', 'metals'), oil = make('OIL', 'energy'), jpy = make('AUDJPY', 'forex', 'AUD', 'JPY');
  const matched = matchMarkets(classifyEvent({title: 'US CPI inflation'}), [usd, gold, oil, jpy]);
  assert.deepEqual(matched.map(x => x.instrumentId), [usd.id, gold.id]);
  assert.ok(matched.every(x => x.direction === null && x.reasons.length));
  assert.ok(matchMarkets(classifyEvent({title: 'Oil inventories'}), [oil]).length === 1);
  assert.equal(matchMarkets(classifyEvent({title: 'War conflict'}), [usd, gold, oil, jpy]).length, 4);
});

test('RSS/Atom normalization strips HTML and never imports article text, images or instructions', async () => {
  const rows = await parseSource(rss('&lt;b&gt;US CPI&lt;/b&gt;'), source);
  assert.equal(rows[0].title, 'US CPI'); assert.equal(rows[0].url, 'https://www.federalreserve.gov/fixture-article');
  assert.ok(!('description' in rows[0]) && !('image' in rows[0]));
  const atom = '<feed><entry><id>fixture</id><title>FOMC</title><link rel="alternate" href="https://www.federalreserve.gov/fixture"/><published>2026-10-22T11:00:00Z</published></entry></feed>';
  assert.equal((await parseSource(atom, source))[0].title, 'FOMC');
  await assert.rejects(parseSource('<!DOCTYPE rss [<!ENTITY x "bad">]>' + rss(), source), /entities/);
  await assert.rejects(parseSource(rss().replace('https://www.federalreserve.gov/', 'https://evil.example/'), source), /official source/);
});

test('BoJ legacy article links upgrade only the known official host', async () => {
  const raw = rss('Bank of Japan policy').replace('https://www.federalreserve.gov/', 'http://www.boj.or.jp/');
  assert.equal((await parseSource(raw, analysisSource('boj')))[0].url, 'https://www.boj.or.jp/fixture-article');
});

test('duplicate articles with tracking or changed GUID are deduplicated; independent sources and edits remain', () => {
  const one = normalizeEvent(news(), context());
  const two = normalizeEvent(news({externalId: 'other-guid', url: news().url + '?utm_source=x'}), context());
  const edit = normalizeEvent(news({title: 'Updated US CPI fixture', updatedAt: '2026-10-22T11:30:00Z'}), context());
  const other = normalizeEvent(news(), context({source: analysisSource('ecb')}));
  assert.equal(deduplicateEvents([one, two, edit, other], stamp).length, 3);
  assert.equal(canonicalURL('https://user:pw@example.org/a'), null);
});

test('calendar parser reuses explicit Eastern DST times and preserves all-day/ECB dates without a fake publication', async () => {
  const raw = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:fixture1\r\nDTSTART;TZID=US-Eastern:20261023T083000\r\nSUMMARY:Employment Situation\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:fixture2\r\nDTSTART;VALUE=DATE:20261101\r\nSUMMARY:CPI\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const rows = await parseSource(raw, analysisSource('bls-calendar'), {fetchedAt: stamp});
  assert.equal(rows[0].scheduledAt, '2026-10-23T12:30:00.000Z'); assert.equal(rows[1].scheduledAt, '2026-11-01');
  assert.equal(normalizeEvent(rows[1], context({source: analysisSource('bls-calendar')})).scheduled.at, null);
  const ecb = await parseSource('<dl><dt>29/10/2026</dt><dd>Governing Council: monetary policy meeting</dd></dl>', analysisSource('ecb-calendar'), {fetchedAt: stamp});
  assert.equal(ecb[0].scheduledAt, '2026-10-29'); assert.equal(ecb[0].publishedAt, null);
  await assert.rejects(parseSource(raw.replace('DTSTART;TZID=US-Eastern:', 'DTSTART:'), analysisSource('bls-calendar'), {fetchedAt: stamp}));
});

test('FRED observations retain date-only vintage without pretending it is original release time or consensus', async () => {
  const mapping = {id: 'OFFLINE-SERIES', title: 'US CPI fixture', unit: 'index', type: 'INFLATION'};
  const raw = JSON.stringify({count: 2, observations: [{date: '2026-09-01', realtime_start: '2026-10-22', value: '3.2'}, {date: '2026-08-01', value: '.'}]});
  const rows = await parseSource(raw, analysisSource('fred'), {series: mapping});
  const normalized = rows.map(x => normalizeEvent(x, context({source: analysisSource('fred')})));
  assert.equal(normalized[0].published.at, null); assert.equal(normalized[0].updated.precision, 'DATE');
  assert.equal(normalized[0].values.expected, null); assert.equal(normalized[1].values.actual, null);
  await assert.rejects(parseSource(raw.replace('"count":2', '"count":3'), analysisSource('fred'), {series: mapping}), /Incomplete/);
  await assert.rejects(parseSource(raw, analysisSource('fred')), /mapping/);
});

test('BLS monthly observations require exact series identity/units; annual averages and failed API status are rejected', async () => {
  const mapping = {id: 'OFFLINE-BLS', title: 'US unemployment fixture', type: 'LABOUR', unit: 'percent'};
  const body = {status: 'REQUEST_SUCCEEDED', Results: {series: [{seriesID: mapping.id, data: [{year: '2026', period: 'M09', value: '4.1'}]}]}};
  const rows = await parseSource(JSON.stringify(body), analysisSource('bls'), {series: mapping});
  assert.equal(rows[0].period, '2026-09'); assert.equal(rows[0].publishedAt, null);
  body.Results.series[0].data[0].period = 'M13';
  await assert.rejects(parseSource(JSON.stringify(body), analysisSource('bls'), {series: mapping}), /monthly/);
  body.status = 'REQUEST_FAILED';
  await assert.rejects(parseSource(JSON.stringify(body), analysisSource('bls'), {series: mapping}), /failure/);
});

test('structured macro preparation supports explicit models without pretending to implement every official raw API', async () => {
  for (const id of ['bea', 'eurostat', 'treasury']) {
    const rows = await parseSource(JSON.stringify({records: [macro()]}), analysisSource(id));
    assert.equal(rows.length, 1); assert.equal(analysisSource(id).networkImplemented, false);
  }
  await assert.rejects(parseSource(JSON.stringify({records: Array(251).fill({})}), analysisSource('bea')), /bounded/);
});

test('default/source-specific missing permissions block before any external request', async () => {
  for (const id of sourceIds) await assert.rejects(createNewsAdapter({releaseEvidence,sourceId: id}).read(), {code: 'TRANSPORT_NOT_CONFIGURED'});
  let calls = 0;
  for (const id of ['fed', 'fred', 'bls', 'bea', 'eurostat', 'treasury']) {
    await assert.rejects(createNewsAdapter({releaseEvidence,sourceId: id, mode: 'network', clock, fetcher: async () => { calls++; }}).read(), /PERMISSION|NOT_IMPLEMENTED/);
  }
  assert.equal(calls, 0);
});

test('conditional requests use only fixed official endpoint; errors and provider bodies do not expose arbitrary contents', async () => {
  let requests = 0;
  const a = createNewsAdapter({releaseEvidence,sourceId: 'fed', clock, fetcher: async (url, options) => {
    requests++; assert.equal(url, source.url); assert.equal(options.redirect, 'error'); assert.equal(options.headers['If-None-Match'], 'before');
    assert.ok(!options.headers.Authorization); return new Response(null, {status: 304});
  }});
  assert.equal((await a.read({previous: {etag: 'before'}})).notModified, true); assert.equal(requests, 1);
  for (const status of [401, 403, 429, 500]) {
    const a = createNewsAdapter({releaseEvidence,sourceId: 'fed', clock, fetcher: async () => new Response('PRIVATE SECRET BODY', {status, headers: {'Retry-After': '10'}})});
    await assert.rejects(a.read(), e => !e.message.includes('SECRET') && e.code === (status === 429 ? 'RATE_LIMITED' : 'SOURCE_HTTP_ERROR'));
  }
});

test('oversized/deceptive responses and cancellations fail safely', async () => {
  await assert.rejects(createNewsAdapter({releaseEvidence,sourceId: 'fed', fetcher: async () => new Response('x'.repeat(2000001))}).read(), {code: 'SOURCE_RESPONSE_INVALID'});
  const c = new AbortController(); c.abort(); let calls = 0;
  await assert.rejects(createNewsAdapter({releaseEvidence,sourceId: 'fed', fetcher: async () => { calls++; }}).read({signal: c.signal}), {code: 'ABORTED'});
  assert.equal(calls, 0);
});

test('pipeline is fully offline, retains source/quality metadata and does not mutate returned snapshots', async () => {
  const pipeline = createNewsPipeline({adapter: adapter(rss()), clock});
  const first = await pipeline.run();
  assert.equal(first.records.length, 1); assert.equal(first.stale, false);
  assert.equal(first.records[0].mode, 'offline-fixture'); assert.equal(first.records[0].realtimeConfirmed, false);
  first.records.length = 0; assert.equal(pipeline.snapshot().records.length, 1);
  assert.equal((await pipeline.run()).records.length, 1);
});

test('pipeline retains prior data on outage and rejects 304 without existing provenance', async () => {
  let status = 200;
  const a = createNewsAdapter({releaseEvidence,sourceId: 'fed', clock, fetcher: async () => status === 200 ? new Response(rss()) : new Response(null, {status})});
  const pipeline = createNewsPipeline({adapter: a, clock});
  const first = await pipeline.run(); status = 500;
  const failed = await pipeline.run(); assert.equal(failed.stale, true); assert.deepEqual(failed.records, first.records);
  status = 304; assert.equal((await pipeline.run()).stale, false);
  const fresh = createNewsPipeline({adapter: a, clock}); assert.equal((await fresh.run()).error, 'PIPELINE_INVALID');
});

test('invalid batch rows are quarantined; entirely invalid batches do not replace good data', async () => {
  const raw = JSON.stringify({records: [macro(), macro({externalId: 'bad', actual: 'not-a-number'})]});
  const pipeline = createNewsPipeline({adapter: adapter(raw, 'bea'), clock});
  const state = await pipeline.run(); assert.equal(state.records.length, 1); assert.equal(state.quarantined.length, 1);
  const bad = createNewsPipeline({adapter: adapter(JSON.stringify({records: [macro({actual: 'bad'})]}), 'bea'), clock});
  assert.equal((await bad.run()).error, 'PIPELINE_INVALID');
});

test('72-hour news retention never deletes macro history or renews an unknown article indefinitely within an instance', async () => {
  let time = now;
  const a = createNewsAdapter({releaseEvidence,sourceId: 'fed', clock: () => time, fetcher: async () => new Response(rss('US CPI fixture', ''))});
  const pipeline = createNewsPipeline({adapter: a, clock: () => time});
  const first = await pipeline.run(); const expiry = first.records[0].expiresAt;
  time += 71 * 3600000; assert.equal((await pipeline.run()).records[0].expiresAt, expiry);
  time += 2 * 3600000; assert.equal((await pipeline.run()).records.length, 0);
  time += 3600000; assert.equal((await pipeline.run()).records.length, 0);
  assert.equal(deduplicateEvents([normalizeEvent(macro(), context())], '2027-01-01T00:00:00Z').length, 1);
});

test('no phase2 module activates background processing, secrets, trading/order access or LLMs', () => {
  for (const file of ['adapter.js', 'classify.js', 'events.js', 'parsers.js', 'pipeline.js', 'sources.js']) {
    const code = fs.readFileSync(new URL('../market-analysis/news/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /from\s+['"][^'"]*(?:trading-core|\/Trading\/|brain-organisation|openai)|setInterval\s*\(|process\.env\s*[.\[]|\.query\s*\(|storeCandles\s*\(/);
  }
});

test('network source permission is source-specific, dated and rechecked after a response', async () => {
  let time = now, calls = 0;
  const grant = {sourceId: 'fed', verified: true, usage: 'internal-headline-calendar', reference: 'OFFLINE-PERMISSION-FIXTURE', checkedAt: '2026-10-22T10:00:00Z', expiresAt: '2026-10-22T12:01:00Z'};
  for (const authorization of [{...grant, sourceId: 'ecb'}, {...grant, verified: false}, {...grant, expiresAt: '2026-10-21T00:00:00Z'}]) {
    await assert.rejects(createNewsAdapter({releaseEvidence,sourceId: 'fed', mode: 'network', authorization, clock, fetcher: async () => { calls++; }}).read(), {code: 'SOURCE_PERMISSION_NOT_CONFIRMED'});
  }
  assert.equal(calls, 0);
  const a = createNewsAdapter({releaseEvidence,sourceId: 'fed', mode: 'network', authorization: grant, clock: () => time, fetcher: async () => { calls++; time += 61000; return new Response(rss()); }});
  await assert.rejects(a.read(), {code: 'SOURCE_PERMISSION_NOT_CONFIRMED'}); assert.equal(calls, 1);
});

test('pipeline processing timestamps follow actual retrieval and concurrent readers do not duplicate source requests', async () => {
  let time = now, calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const a = createNewsAdapter({releaseEvidence,sourceId: 'fed', clock: () => time, fetcher: async () => { calls++; await gate; time += 1000; return new Response(rss()); }});
  const p = createNewsPipeline({adapter: a, clock: () => time});
  const one = p.run(), two = p.run(); release(); const [first, second] = await Promise.all([one, two]);
  assert.equal(calls, 1); assert.ok(first.records[0].processedAt > first.records[0].fetchedAt);
  first.records.length = 0; assert.equal(second.records.length, 1);
});

test('bounded local state refuses overflow without truncating or replacing an earlier valid snapshot', async () => {
  let count = 1;
  const a = createNewsAdapter({releaseEvidence,sourceId: 'bea', clock, fetcher: async () => new Response(JSON.stringify({records: Array.from({length: count}, (_, i) => macro({externalId: 'fixture-' + i}))}))});
  const p = createNewsPipeline({adapter: a, clock, maxRecords: 1});
  const first = await p.run(); count = 2;
  const failed = await p.run(); assert.equal(failed.error, 'PIPELINE_INVALID'); assert.deepEqual(failed.records, first.records);
});

test('revision links cannot attach another series and unknown references are marked unverified', async () => {
  const first = normalizeEvent(macro(), context({source: analysisSource('bea')}));
  const revision = macro({actual: 3.3, revisedAt: '2026-10-22', revisionOf: first.versionId});
  const good = createNewsPipeline({adapter: adapter(JSON.stringify({records: [macro(), revision]}), 'bea'), clock});
  const records = (await good.run()).records;
  assert.equal(records.length, 2); assert.equal(records[1].quality.revisionLinkVerified, true); assert.equal(records[1].revised.at, null);
  const bad = createNewsPipeline({adapter: adapter(JSON.stringify({records: [macro(), {...revision, externalId: 'other-series'}]}), 'bea'), clock});
  const state = await bad.run(); assert.equal(state.records.length, 1); assert.equal(state.quarantined[0].reason, 'REVISION_TARGET_MISMATCH');
  const unknown = createNewsPipeline({adapter: adapter(JSON.stringify({records: [revision]}), 'bea'), clock});
  assert.ok((await unknown.run()).records[0].quality.issues.includes('REVISION_TARGET_UNAVAILABLE'));
});

test('future publication and source timezone remain explicit, not inferred publication or realtime', () => {
  const record = normalizeEvent(news({publishedAt: '2026-10-23T11:00:00Z'}), context());
  assert.ok(record.quality.issues.includes('PUBLICATION_IN_FUTURE')); assert.equal(record.realtimeConfirmed, false);
  assert.throws(() => normalizeEvent(news({timezone: 'made-up-zone'}), context()), /timezone/);
});

test('Fed calendar dates remain date-only and cancelled ICS records are not activated', async () => {
  const html = '<!DOCTYPE html><div class="panel"><h4>2026 FOMC Meetings</h4><div class="fomc-meeting"><div class="fomc-meeting__month">October</div><div class="fomc-meeting__date">27-28</div></div></div>';
  const rows = await parseSource(html, analysisSource('fed-calendar'), {fetchedAt: stamp});
  assert.equal(rows[0].scheduledAt, '2026-10-28'); assert.equal(rows[0].publishedAt, null);
  const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:fixture-cancel\r\nDTSTART:20261023T123000Z\r\nSUMMARY:Cancelled CPI\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:fixture-kept\r\nDTSTART:20261024T123000Z\r\nSUMMARY:PCE\r\nEND:VEVENT\r\nEND:VCALENDAR';
  assert.equal((await parseSource(ics, analysisSource('bea-calendar'), {fetchedAt: stamp})).length, 1);
});
