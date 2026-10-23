import {createHash} from 'node:crypto';
import {DateTime} from 'luxon';
import {requireValue, utcMillis} from '../instruments.js';
import {classifyEvent, matchMarkets} from './classify.js';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function canonicalURL(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.href.length > 2048) return null;
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(k)) u.searchParams.delete(k);
    u.searchParams.sort(); return u.href;
  } catch { return null; }
}
export function parseEventTime(value) {
  if (value === null || value === undefined || value === '') return {at: null, date: null, precision: 'UNKNOWN', zone: null, issue: 'TIME_MISSING'};
  requireValue(typeof value === 'string' && value.length <= 100, 'Invalid time value.');
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    requireValue(DateTime.fromISO(value).isValid, 'Invalid calendar date.');
    return {at: null, date: value, precision: 'DATE', zone: null, issue: 'TIME_DATE_ONLY'};
  }
  let d;
  if (/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) { utcMillis(value); d = DateTime.fromISO(value, {setZone: true}); }
  else d = DateTime.fromRFC2822(value, {setZone: true});
  requireValue(d.isValid && /(?:Z|[+-]\d{2}:?\d{2}|GMT|UT|UTC|[ECMP][SD]T)$/.test(value), 'Ambiguous or invalid event timezone.');
  return {at: d.toUTC().toISO(), date: d.toUTC().toISODate(), precision: 'INSTANT', zone: d.zoneName, issue: null};
}
function number(value) {
  if (value === null || value === undefined || value === '' || value === '.') return null;
  requireValue(typeof value === 'number' || (typeof value === 'string' && /^[-+]?\d+(?:\.\d+)?$/.test(value)), 'Invalid economic value.');
  const n = Number(value); requireValue(Number.isFinite(n), 'Invalid economic value.'); return n;
}
export function normalizeEvent(input, {source, fetchedAt, processedAt, mode = 'offline-fixture', instruments = []}) {
  const fetched = utcMillis(fetchedAt), processed = utcMillis(processedAt);
  requireValue(processed >= fetched, 'Processing precedes retrieval.');
  requireValue(input && ['news', 'macro', 'calendar'].includes(input.kind), 'Invalid record kind.');
  requireValue(typeof input.title === 'string' && input.title.trim() && input.title.length <= 500, 'Invalid event title.');
  for (const [key, pattern] of [['country', /^[A-Z]{2}$/], ['currency', /^[A-Z]{3}$/]]) {
    requireValue(input[key] == null || pattern.test(input[key]), 'Invalid country or currency.');
  }
  const url = canonicalURL(input.url ?? source.url);
  requireValue(url, 'A traceable HTTPS source is required.');
  const published = parseEventTime(input.publishedAt), scheduled = parseEventTime(input.scheduledAt);
  const revised = parseEventTime(input.revisedAt), updated = parseEventTime(input.updatedAt);
  const classification = classifyEvent({...input, sourceCountry: source.country});
  const values = {actual: number(input.actual), expected: null, previous: number(input.previous), revisedPrevious: number(input.revisedPrevious)};
  const issues = [published.issue].filter(Boolean);
  let expectation = null;
  if (input.expected != null && input.expected !== '') {
    const e = input.expectation;
    const asOf = e?.asOf ? parseEventTime(e.asOf) : null;
    if (['compiled_consensus', 'forecaster_survey'].includes(e?.class) && canonicalURL(e?.sourceURL) && asOf?.at && published.at && utcMillis(asOf.at) < utcMillis(published.at)) {
      values.expected = number(input.expected); expectation = {class: e.class, sourceURL: canonicalURL(e.sourceURL), asOf: asOf.at};
    } else issues.push('CONSENSUS_NOT_VERIFIED');
  }
  const unit = typeof input.unit === 'string' && input.unit.trim() ? input.unit.slice(0, 80) : null;
  requireValue(!Object.values(values).some(x => x !== null) || unit, 'Numeric observations require explicit units.');
  if (published.at && utcMillis(published.at) > fetched) issues.push('PUBLICATION_IN_FUTURE');
  if (revised.precision !== 'UNKNOWN') {
    requireValue(input.revisionOf && typeof input.revisionOf === 'string', 'Revision requires an original version reference.');
    requireValue(!published.at || !revised.at || utcMillis(revised.at) >= utcMillis(published.at), 'Revision predates original publication.');
  }
  const externalId = input.externalId == null ? null : String(input.externalId).slice(0, 250);
  const seriesId = input.seriesId == null ? null : String(input.seriesId).slice(0, 160);
  const period = input.period == null ? null : String(input.period).slice(0, 80);
  if (input.kind === 'macro') requireValue(externalId || (seriesId && period), 'Economic observation needs an explicit identity.');
  const eventId = digest([source.id, input.kind, externalId ?? (seriesId && period ? seriesId + ':' + period : url)]);
  const sourceTimezone = input.timezone ?? published.zone ?? null;
  requireValue(sourceTimezone === null || (typeof sourceTimezone === 'string' && DateTime.now().setZone(sourceTimezone).isValid), 'Invalid source timezone.');
  const content = {eventId, title: input.title.trim(), url, published, scheduled, revised, updated, sourceTimezone,
    values, unit, period, seriesId, expectation, revisionOf: input.revisionOf ?? null};
  const versionId = digest(content);
  const expiresAt = input.kind === 'news' ? new Date(Math.min(fetched + 72 * 3600000,
    published.at ? utcMillis(published.at) + 72 * 3600000 : Infinity)).toISOString() : null;
  return {...content, eventId, versionId, source: {id: source.id, name: source.name}, kind: input.kind,
    classification, affectedMarkets: matchMarkets(classification, instruments),
    status: input.cancelled ? 'CANCELLED' : revised.precision !== 'UNKNOWN' ? 'REVISED' : values.actual !== null || input.kind === 'news' ? 'RELEASED' : input.kind === 'macro' ? 'UNAVAILABLE' : 'SCHEDULED',
    fetchedAt: new Date(fetched).toISOString(), firstObservedAt: new Date(fetched).toISOString(), processedAt: new Date(processed).toISOString(), expiresAt,
    mode, realtimeConfirmed: false, quality: {issues, hasActual: values.actual !== null,
      hasConsensus: values.expected !== null, historicalTimingVerified: false, revisionLinkVerified: false}};
}

// Adapted deduplication keys from day-trader-skill trader-news/news.py:dedupe.
// MIT attribution in NOTICE.md; preserve versions and independent sources.
export function deduplicateEvents(events, now) {
  const at = utcMillis(now), seen = new Map(), result = [];
  for (const record of events) {
    if (record.expiresAt && utcMillis(record.expiresAt) <= at) continue;
    const key = record.kind === 'news' ? record.source.id + ':' + digest([record.url, record.title, record.published, record.updated]) : record.source.id + ':' + record.versionId;
    const old = seen.get(key);
    if (old) {
      if (utcMillis(record.fetchedAt) < utcMillis(old.fetchedAt)) {
        old.fetchedAt = record.fetchedAt; old.expiresAt = record.expiresAt;
      }
      continue;
    }
    const copy = structuredClone(record);
    // Similar headlines are only a suggested cluster, never merged facts.
    const title = record.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    copy.clusterId = digest([record.kind, title, record.published.date ?? record.scheduled.date ?? record.eventId,
      record.period, record.classification.type, record.classification.countries]);
    seen.set(key, copy); result.push(copy);
  }
  return result;
}
