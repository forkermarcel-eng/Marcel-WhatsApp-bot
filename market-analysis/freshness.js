import {requireValue,utcMillis} from './instruments.js';
import {ms} from './storage.js';

// Source availability, content age and observation age are different measures.
// Calendar dates and unknown historical release times never become invented instants.
export function assessStoredRecord(row,{now,maxAgeMs,maxFetchAgeMs = maxAgeMs} = {}) {
  requireValue(Number.isFinite(maxAgeMs) && maxAgeMs>0 && Number.isFinite(maxFetchAgeMs) && maxFetchAgeMs>0,'Explicit freshness budgets required.');
  const time = utcMillis(now),body = row.body,sourceAt = row.kind === 'bar'
    ? utcMillis(body.bar.time)+body.intervalMs : body.revised?.at ? utcMillis(body.revised.at) : row.published_at ? ms(row.published_at) : null;
  const fetchedAgeMs = time-ms(row.fetched_at),storedAgeMs = time-ms(row.stored_at),sourceAgeMs = sourceAt===null ? null : time-sourceAt;
  const reasons = [];
  if(sourceAgeMs===null) reasons.push('SOURCE_TIME_UNKNOWN');
  else if(sourceAgeMs<0) reasons.push('FUTURE_SOURCE_TIME');
  else if(sourceAgeMs>maxAgeMs) reasons.push('DATA_OLD');
  if(fetchedAgeMs<0 || storedAgeMs<0) reasons.push('FUTURE_OBSERVATION');
  if(fetchedAgeMs>maxFetchAgeMs) reasons.push('FETCH_OLD');
  if(row.expires_at && ms(row.expires_at)<=time) reasons.push('EXPIRED');
  const provenance = body.provenance;
  if(body.mode === 'offline-fixture' || provenance?.mode === 'offline-fixture') reasons.push('OFFLINE_FIXTURE');
  if(provenance?.authorizationExpiresAt && utcMillis(provenance.authorizationExpiresAt)<=time) reasons.push('ENTITLEMENT_EXPIRED');
  return {sourceAgeMs,fetchedAgeMs,storedAgeMs,reasons,stale:reasons.length>0,realtimeConfirmed:false,
    usableForCurrentMonitoring:false};
}
