import {requireValue, utcMillis} from './instruments.js';
import {AnalysisDataError} from './providers/massive.js';

// Explicit calls only: no interval, database, env access or background registration.
export function createInstrumentCatalog({adapter, clock = Date.now, ttlMs = 86400000} = {}) {
  requireValue(adapter && typeof adapter.discover === 'function', 'A catalog adapter is required.');
  requireValue(Number.isFinite(ttlMs) && ttlMs > 0 && ttlMs <= 86400000, 'Invalid catalog cache lifetime.');
  let cache = null, lastFailure = null, pending = null;
  async function load({refresh = false, signal} = {}) {
      const now = clock();
      const authorizationValid = !cache?.provenance?.authorizationExpiresAt || now < utcMillis(cache.provenance.authorizationExpiresAt);
      if (!refresh && cache && authorizationValid && now >= utcMillis(cache.fetchedAt) && now < utcMillis(cache.fetchedAt) + ttlMs) {
        return structuredClone({...cache, cached: true, ...(lastFailure ?? {})});
      }
      try {
        const result = await adapter.discover({signal});
        requireValue(result && Array.isArray(result.items) && result.items.length <= 10000, 'Invalid catalog result.');
        const unique = new Map();
        for (const item of result.items) {
          requireValue(item.id && item.provider === adapter.provider, 'Invalid catalog identity.');
          const previous = unique.get(item.id);
          requireValue(!previous || JSON.stringify(previous) === JSON.stringify(item), 'Conflicting instrument mapping.');
          if (item.active) unique.set(item.id, item);
        }
        const items = [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
        cache = structuredClone({items, provenance: result.provenance, fetchedAt: new Date(clock()).toISOString(),
          stale: false, cached: false, error: null});
        lastFailure = null;
        return structuredClone(cache);
      } catch (error) {
        if (signal?.aborted || error?.code === 'ABORTED') throw new AnalysisDataError('ABORTED');
        lastFailure = {stale: true,
          error: error instanceof AnalysisDataError ? error.code : 'CATALOG_INVALID',
          retryAfterSeconds: error instanceof AnalysisDataError ? error.retryAfterSeconds : null};
        return structuredClone({items: cache?.items ?? [], provenance: cache?.provenance ?? null,
          fetchedAt: cache?.fetchedAt ?? null, cached: !!cache, ...lastFailure});
      }
  }
  return Object.freeze({
    async read(options = {}) {
      if (options.signal?.aborted) throw new AnalysisDataError('ABORTED');
      // One explicit refresh per instance; no parallel refresh can regress cache.
      if (!pending) pending = load(options);
      const task = pending;
      try { return structuredClone(await task); }
      finally { if (pending === task) pending = null; }
    },
  });
}
