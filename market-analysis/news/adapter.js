import {fetchFinanceSource} from '../../brain-world/finance-sources.js';
import {utcMillis, requireValue} from '../instruments.js';
import {analysisSource} from './sources.js';
import {parseSource} from './parsers.js';
import {requireDataPermission} from '../data-permissions.js';

export class NewsSourceError extends Error {
  constructor(code, retryMs = 0) { super(code); this.name = 'NewsSourceError'; this.code = code; this.retryMs = retryMs; }
}
export function createNewsAdapter({sourceId, mode = 'offline-fixture', fetcher = null,
  authorization = null, releaseEvidence = null, clock = Date.now} = {}) {
  const source = analysisSource(sourceId), grant = authorization ? structuredClone(authorization) : null;
  requireValue(['offline-fixture', 'network'].includes(mode), 'Invalid source mode.');
  function permit() {
    if (typeof fetcher !== 'function') throw new NewsSourceError('TRANSPORT_NOT_CONFIGURED');
    if (mode === 'offline-fixture') return;
    if (!source.networkImplemented) throw new NewsSourceError('NETWORK_ADAPTER_NOT_IMPLEMENTED');
    try {
      if (grant?.sourceId !== source.id || grant.verified !== true || grant.usage !== 'internal-headline-calendar' ||
        typeof grant.reference !== 'string' || !grant.reference.trim() || utcMillis(grant.checkedAt) > clock() || utcMillis(grant.expiresAt) <= clock()) throw Error();
    } catch { throw new NewsSourceError('SOURCE_PERMISSION_NOT_CONFIRMED'); }
    requireDataPermission(source,releaseEvidence,clock());
  }
  return Object.freeze({source: structuredClone(source), mode,
    async read({signal, previous = {}, series = null} = {}) {
      permit();
      if (signal?.aborted) throw new NewsSourceError('ABORTED');
      const fetchedAt = new Date(clock()).toISOString();
      try {
        // Reuse only this existing pure bounded HTTP helper. Never its workers.
        const result = await fetchFinanceSource(source.url, previous, (url, options) => fetcher(url, {
          ...options, signal: AbortSignal.any([options.signal, ...(signal ? [signal] : [])]),
        }));
        if (signal?.aborted) throw new NewsSourceError('ABORTED');
        permit();
        if (result.notModified) return {notModified: true, fetchedAt, validators: {etag: result.etag, lastModified: result.lastModified}, mode};
        const records = await parseSource(result.raw, source, {series, fetchedAt});
        return {records, source: structuredClone(source), fetchedAt, mode,
          validators: {etag: result.etag, lastModified: result.lastModified}};
      } catch (error) {
        if (error instanceof NewsSourceError) throw error;
        throw new NewsSourceError(signal?.aborted ? 'ABORTED' : error.httpStatus === 429 ? 'RATE_LIMITED' :
          error.httpStatus ? 'SOURCE_HTTP_ERROR' : 'SOURCE_RESPONSE_INVALID', Math.min(3600000, Math.max(0, Number(error.retryMs) || 0)));
      }
    },
  });
}
