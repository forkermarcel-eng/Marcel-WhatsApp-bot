import {requireValue, utcMillis} from '../instruments.js';
import {normalizeEvent, deduplicateEvents} from './events.js';
import {NewsSourceError} from './adapter.js';

// Explicit local runs, with bounded in-memory state only. No timer/DB/API/LLM.
export function createNewsPipeline({adapter, instruments = [], clock = Date.now, maxRecords = 1000} = {}) {
  requireValue(adapter && typeof adapter.read === 'function' && Number.isInteger(maxRecords) && maxRecords > 0 && maxRecords <= 1000, 'Invalid pipeline configuration.');
  let state = {records: [], validators: {}, lastSuccessAt: null, lastCheckedAt: null, error: null, stale: true, quarantined: []};
  let pending = null;
  const firstSeen = new Map();
  async function run(options) {
    let processedAt = new Date(clock()).toISOString();
    try {
      const data = await adapter.read({...options, previous: state.validators});
      processedAt = new Date(clock()).toISOString();
      if (data.notModified) {
        requireValue(state.lastSuccessAt !== null, '304 without an earlier snapshot.');
        state = {...state, records: deduplicateEvents(state.records, processedAt), lastCheckedAt: processedAt, stale: false, error: null};
        return;
      }
      requireValue(Array.isArray(data.records) && data.records.length <= 250, 'Invalid batch.');
      const normalized = [], quarantined = [];
      for (const input of data.records) {
        try { normalized.push(normalizeEvent(input, {...data, processedAt, instruments})); }
        catch { quarantined.push({index: normalized.length + quarantined.length, reason: 'EVENT_INVALID'}); }
      }
      const versions = new Map([...state.records, ...normalized].map(x => [x.versionId, x]));
      for (let i = normalized.length - 1; i >= 0; i--) {
        const record = normalized[i];
        if (!record.revisionOf) continue;
        const target = versions.get(record.revisionOf);
        if (!target) { record.quality.issues.push('REVISION_TARGET_UNAVAILABLE'); continue; }
        if (target.eventId !== record.eventId || target.published.at !== record.published.at || target.published.date !== record.published.date) {
          normalized.splice(i, 1); quarantined.push({index: i, reason: 'REVISION_TARGET_MISMATCH'});
        } else record.quality.revisionLinkVerified = true;
      }
      // A syntactically valid empty feed differs from an entirely invalid batch.
      requireValue(!data.records.length || normalized.length > 0, 'No valid events in source batch.');
      const nextSeen = new Map(firstSeen);
      for (const record of normalized.filter(x => x.kind === 'news')) {
        const key = record.source.id + ':' + record.url;
        const first = nextSeen.get(key) ?? record.fetchedAt; nextSeen.set(key, first);
        record.firstObservedAt = first;
        record.expiresAt = new Date(Math.min(utcMillis(record.expiresAt), utcMillis(first) + 72 * 3600000)).toISOString();
      }
      requireValue(nextSeen.size <= maxRecords, 'Local first-seen capacity exceeded.');
      const records = deduplicateEvents([...state.records, ...normalized], processedAt);
      requireValue(records.length <= maxRecords, 'Local retention capacity exceeded.');
      state = {records, validators: data.validators ?? {}, lastSuccessAt: processedAt, lastCheckedAt: processedAt,
        stale: false, error: null, quarantined};
      firstSeen.clear(); for (const [key, value] of nextSeen) firstSeen.set(key, value);
    } catch (error) {
      if (options.signal?.aborted || error?.code === 'ABORTED') throw new NewsSourceError('ABORTED');
      state = {...state, records: deduplicateEvents(state.records, processedAt), lastCheckedAt: processedAt,
        stale: true, error: error instanceof NewsSourceError ? error.code : 'PIPELINE_INVALID'};
    }
  }
  return Object.freeze({
    snapshot() { return structuredClone(state); },
    async run(options = {}) {
      if (options.signal?.aborted) throw new NewsSourceError('ABORTED');
      if (!pending) pending = run(options);
      const task = pending;
      try { await task; return structuredClone(state); }
      finally { if (pending === task) pending = null; }
    },
  });
}
