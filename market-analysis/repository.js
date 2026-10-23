import {normalizeInstrument, requireValue, utcMillis} from './instruments.js';
import {assessBars} from './quality.js';
import {digest} from './news/events.js';
import {randomUUID} from 'node:crypto';
import {saveAPIResult} from './api-storage.js';
import {transaction, iso, ms, identity, lockSource, fence, logJob} from './storage.js';

const kinds = new Set(['instrument','mapping','bar','news','macro','calendar']);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const H72 = 72 * 3600000;
function chronology(fetched, processed, stored) {
  requireValue(utcMillis(fetched) <= utcMillis(processed) && utcMillis(processed) <= utcMillis(stored), 'Invalid storage chronology.');
}

export function createAnalysisRepository({database, clock = Date.now,maxSourceRecords = 100000,maxSourceNewsSeen = 100000} = {}) {
  requireValue(database && typeof database.query === 'function', 'Explicit database required.');
  requireValue([maxSourceRecords,maxSourceNewsSeen].every(n=>Number.isInteger(n) && n>0 && n<=1000000),'Invalid storage quota.');
  async function insert(queue, row, now, ingestionId) {
    const {sourceId,kind,entityId,versionId,body,fetchedAt,processedAt,publishedAt = null,expiresAt = null} = row;
    requireValue(kinds.has(kind) && hash(versionId), 'Invalid record kind/version.');
    identity(entityId); chronology(fetchedAt,processedAt,now);
    if (publishedAt) utcMillis(publishedAt);
    const raw = JSON.stringify(body);
    requireValue(Buffer.byteLength(raw) <= 65536, 'Record exceeds storage limit.');
    queue.bytes += Buffer.byteLength(raw);
    requireValue(queue.bytes<=20000000,'Storage batch exceeds byte limit.');
    queue.rows.push({source_id:sourceId,kind,entity_id:entityId,version_id:versionId,body,published_at:publishedAt,
      fetched_at:fetchedAt,processed_at:processedAt,stored_at:now,expires_at:expiresAt ?? null,ingestion_id:ingestionId});
  }
  async function flush(tx,queue) {
    if(!queue.rows.length) return;
    await tx.query(`INSERT INTO marcel_market_analysis.records
      (source_id,kind,entity_id,version_id,body,published_at,fetched_at,processed_at,stored_at,expires_at,ingestion_id)
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(source_id text,kind text,entity_id text,version_id text,body jsonb,
        published_at timestamptz,fetched_at timestamptz,processed_at timestamptz,stored_at timestamptz,expires_at timestamptz,ingestion_id uuid)
      ON CONFLICT DO NOTHING`,[JSON.stringify(queue.rows)]);
    queue.rows = [];
  }
  async function persist(tx, batch, now, ingestionId) {
    const {sourceId, fetchedAt, processedAt, events = [], instruments = [], mappings = [], histories = []} = batch;
    const queue = {rows:[],bytes:0};
    chronology(fetchedAt,processedAt,now);
    requireValue(events.length <= 250 && instruments.length <= 10000 && mappings.length <= 1000 && histories.length <= 10, 'Batch exceeds storage limit.');
    for (const input of instruments) {
      const body = normalizeInstrument(input);
      requireValue(body.id === input.id, 'Instrument identity mismatch.');
      const {observedAt:ignoredObservation,...versionProvenance} = body.provenance;
      await insert(queue,{sourceId,kind:'instrument',entityId:body.id,
        versionId:digest({...body,provenance:versionProvenance}),body,fetchedAt,processedAt},now,ingestionId);
    }
    await flush(tx,queue);
    for (const body of mappings) {
      requireValue(Object.keys(body).sort().join(',') === 'instrumentId,mappingId,provider,symbol', 'Invalid mapping fields.');
      for (const value of Object.values(body)) identity(value);
      const target = await tx.query("SELECT body FROM marcel_market_analysis.records WHERE kind='instrument' AND entity_id=$1 ORDER BY sequence DESC LIMIT 1",[body.instrumentId]);
      requireValue(target.rows.length && target.rows[0].body.provider === body.provider && target.rows[0].body.symbol === body.symbol, 'Mapping must reference an exact verified instrument.');
      await insert(queue,{sourceId,kind:'mapping',entityId:body.mappingId,versionId:digest(body),body,fetchedAt,processedAt},now,ingestionId);
    }
    for (const event of events) {
      requireValue(['news','macro','calendar'].includes(event.kind) && event.source?.id === sourceId && hash(event.eventId) && hash(event.versionId), 'Invalid normalized event.');
      const content = Object.fromEntries(['eventId','title','url','published','scheduled','revised','updated','sourceTimezone','values','unit','period','seriesId','expectation','revisionOf'].map(key=>[key,event[key]]));
      requireValue(digest(content) === event.versionId,'Event content/version mismatch.');
      chronology(event.fetchedAt,event.processedAt,now);
      const body = structuredClone(event);
      if (event.revisionOf) {
        const targets = await tx.query("SELECT body FROM marcel_market_analysis.records WHERE source_id=$1 AND body->>'versionId'=$2 AND kind=$3 ORDER BY sequence LIMIT 1",[sourceId,event.revisionOf,event.kind]);
        const target = targets.rows[0]?.body ?? events.find(x=>x.versionId === event.revisionOf);
        requireValue(!target || target.versionId !== event.versionId && target.eventId === event.eventId && target.published.at === event.published.at && target.published.date === event.published.date, 'Revision target mismatch.');
        body.quality = {...body.quality,revisionLinkVerified:!!target};
      }
      // Phase-2 content hashes omit status: retain explicit cancellations too.
      let entityId = event.eventId, versionId = digest([event.versionId,event.status]);
      if (event.kind === 'news') {
        const articleHash = digest(event.url);
        await tx.query(`INSERT INTO marcel_market_analysis.news_seen(source_id,article_hash,first_seen_at,expires_at)
          VALUES($1,$2,$3,$4) ON CONFLICT(source_id,article_hash) DO UPDATE SET expires_at=LEAST(marcel_market_analysis.news_seen.expires_at,excluded.expires_at)`,[sourceId,articleHash,event.firstObservedAt ?? event.fetchedAt,
          new Date(Math.min(utcMillis(event.expiresAt),utcMillis(event.firstObservedAt ?? event.fetchedAt)+H72)).toISOString()]);
        const seen = (await tx.query('SELECT first_seen_at,expires_at FROM marcel_market_analysis.news_seen WHERE source_id=$1 AND article_hash=$2',[sourceId,articleHash])).rows[0];
        body.firstObservedAt = new Date(ms(seen.first_seen_at)).toISOString();
        body.expiresAt = new Date(Math.min(ms(seen.expires_at),utcMillis(event.expiresAt))).toISOString();
        if (utcMillis(body.expiresAt) <= utcMillis(now)) continue;
        entityId = articleHash;
        versionId = digest([event.url,event.title,event.published,event.updated]);
      }
      await insert(queue,{sourceId,kind:event.kind,entityId,versionId,body,fetchedAt:event.fetchedAt,
        processedAt:event.processedAt,publishedAt:event.published?.at,expiresAt:body.expiresAt},now,ingestionId);
    }
    let bars = 0;
    for (const history of histories) {
      const {instrumentId,from,to,observedAt,intervalMs,delayMs,maxAgeMs,marketStatus} = history;
      const instrument = await tx.query("SELECT entity_id FROM marcel_market_analysis.records WHERE kind='instrument' AND entity_id=$1 LIMIT 1",[identity(instrumentId)]);
      requireValue(instrument.rows.length === 1, 'Unknown history instrument.');
      const quality = assessBars({bars:history.bars,from,to,observedAt,intervalMs,delayMs,maxAgeMs,marketStatus});
      requireValue(utcMillis(observedAt) <= utcMillis(fetchedAt), 'Future bar observation.');
      bars += quality.bars.length; requireValue(bars <= 10000, 'Bar batch exceeds limit.');
      for (const bar of quality.bars) {
        const body = {instrumentId,intervalMs,bar,provenance:history.provenance ?? {mode:'unknown'},
          quality:{reasons:quality.reasons,delayMs:quality.delayMs,priceBasis:quality.priceBasis,
            coverageComplete:quality.coverage.complete,missingCount:quality.coverage.missing.length,usableForCurrentMonitoring:false},observedAt};
        await insert(queue,{sourceId,kind:'bar',entityId:JSON.stringify([instrumentId,intervalMs,bar.time]),
          versionId:digest(bar),body,fetchedAt,processedAt,publishedAt:bar.time},now,ingestionId);
      }
    }
    await flush(tx,queue);
    const n = (await tx.query('SELECT count(*)::integer AS n FROM marcel_market_analysis.records WHERE source_id=$1',[sourceId])).rows[0].n;
    const seen = (await tx.query('SELECT count(*)::integer AS n FROM marcel_market_analysis.news_seen WHERE source_id=$1',[sourceId])).rows[0].n;
    requireValue(n<=maxSourceRecords && seen<=maxSourceNewsSeen,'Source storage quota exceeded.');
  }
  return Object.freeze({
    // One transaction for data, validators, source status AND fenced job completion.
    async commitBatch(batch, {job = null} = {}) {
      return transaction(database,async tx=>{
        await lockSource(tx,'__job_control__');
        await lockSource(tx,batch.sourceId);
        const now = iso(clock),ingestionId = randomUUID();
        if(job) { requireValue(job.source_id === batch.sourceId,'Job source mismatch.'); await fence(tx,job,now,clock); }
        const state = (await tx.query('SELECT state,last_success_at FROM marcel_market_analysis.sources WHERE id=$1',[batch.sourceId])).rows[0];
        if(batch.notModified) requireValue(state.last_success_at,'304 without stored snapshot.');
        else await persist(tx,batch,now,ingestionId);
        const validators = batch.validators ?? state.state.validators ?? {};
        requireValue(Object.keys(validators).every(k=>['etag','lastModified'].includes(k)) && JSON.stringify(validators).length <= 2048,'Invalid validators.');
        chronology(batch.fetchedAt,batch.processedAt,iso(clock));
        const finishedAt = iso(clock);
        await tx.query('UPDATE marcel_market_analysis.records SET stored_at=$2 WHERE ingestion_id=$1',[ingestionId,finishedAt]);
        if(job) await fence(tx,job,finishedAt,clock);
        await tx.query(`UPDATE marcel_market_analysis.sources SET state=$2::jsonb,last_success_at=$3,error_code=NULL WHERE id=$1`,
          [batch.sourceId,JSON.stringify({validators,fetchedAt:batch.fetchedAt,processedAt:batch.processedAt,storedAt:finishedAt,mode:batch.mode ?? 'unknown',quarantined:batch.notModified ? state.state.quarantined ?? [] : batch.quarantined ?? []}),finishedAt]);
        if(job) {
          await saveAPIResult(tx,job,batch.apiResult ?? null);
          await tx.query("UPDATE marcel_market_analysis.jobs SET status='succeeded',ended_at=$2,lease_token=NULL,lease_until=NULL,error_code=NULL WHERE id=$1",[job.id,finishedAt]);
          await logJob(tx,job,finishedAt,'succeeded');
        }
      });
    },
    async read({sourceId,kind,entityId = null,asOf = iso(clock),latest = false,limit = 100,cursor = null} = {}) {
      identity(sourceId);requireValue(kinds.has(kind) && Number.isInteger(limit) && limit>=1 && limit<=500,'Invalid bounded read.');utcMillis(asOf);
      if(entityId!==null) identity(entityId);
      if(cursor!==null) requireValue(latest ? typeof cursor.entityId === 'string' : /^\d{1,18}$/.test(String(cursor.sequence)),'Invalid read cursor.');
      const select = latest ? 'DISTINCT ON(entity_id)' : '';
      const order = latest ? 'entity_id,stored_at DESC,sequence DESC' : 'sequence';
      const page = latest ? '($6::text IS NULL OR entity_id>$6)' : '($6::bigint IS NULL OR sequence>$6)';
      const result = await database.query(`SELECT ${select} * FROM marcel_market_analysis.records
        WHERE source_id=$1 AND kind=$2 AND ($3::text IS NULL OR entity_id=$3) AND stored_at<=$4
        AND (expires_at IS NULL OR expires_at>$4) AND ${page} ORDER BY ${order} LIMIT $5`,
        [sourceId,kind,entityId,asOf,limit+1,cursor ? latest ? cursor.entityId : String(cursor.sequence) : null]);
      const items = result.rows.slice(0,limit),hasMore = result.rows.length>limit,last = items.at(-1);
      return {items,hasMore,nextCursor:hasMore ? latest ? {entityId:last.entity_id} : {sequence:String(last.sequence)} : null,asOf,historicalTimingVerified:false};
    },
    async sourceStatus(sourceId,{maxAgeMs,now = iso(clock)} = {}) {
      identity(sourceId); requireValue(Number.isFinite(maxAgeMs) && maxAgeMs>0,'Freshness budget required.');utcMillis(now);
      const row = (await database.query('SELECT * FROM marcel_market_analysis.sources WHERE id=$1',[sourceId])).rows[0];
      const lastJobError = (await database.query('SELECT ended_at,error_code FROM marcel_market_analysis.jobs WHERE source_id=$1 AND error_code IS NOT NULL ORDER BY ended_at DESC NULLS LAST LIMIT 1',[sourceId])).rows[0];
      const unresolved = lastJobError?.ended_at && (!row?.last_success_at || ms(lastJobError.ended_at)>ms(row.last_success_at));
      const ageMs = row?.last_success_at ? utcMillis(now)-ms(row.last_success_at) : null;
      return {...row,...(unresolved?{error_code:lastJobError.error_code,last_error_at:lastJobError.ended_at}:{}),id:sourceId,ageMs,
        stale:ageMs === null || ageMs<0 || ageMs>maxAgeMs || !!row.error_code || !!row.state?.quarantined?.length || !!unresolved,
        realtimeConfirmed:false};
    },
    // Explicit own temporary-news cleanup only. Never touches macro/bar history or archives.
    async expireNews({limit = 250} = {}) {
      requireValue(Number.isInteger(limit) && limit>0 && limit<=1000,'Invalid cleanup limit.');
      return database.query(`DELETE FROM marcel_market_analysis.records WHERE sequence IN
        (SELECT sequence FROM marcel_market_analysis.records WHERE kind='news' AND expires_at<=$1 ORDER BY expires_at LIMIT $2) RETURNING sequence`,[iso(clock),limit]);
    },
  });
}
