import {load} from 'cheerio';
import {createHash} from 'node:crypto';
import tzlookup from 'tz-lookup';
import {fetchNews} from '../trading-core/server/news-sources.js';
import {sources} from './sources.js';
export const TTL=72*60*60*1000;
const ua='MarcelBrain/1.0 (+https://marcelmarlow.com)';
export const hash=x=>createHash('sha256').update(x).digest('hex');
export function safeURL(x){try{const u=new URL(x);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}
const text=x=>load(String(x||'')).text().replace(/\s+/g,' ').trim();
export function coordinates(lat,lon){lat=Number(lat);lon=Number(lon);if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat < -90||lat>90||lon < -180||lon>180)throw Object.assign(Error('Ungültige Koordinaten.'),{status:400});return {lat,lon};}
export function parseFeed(raw,source,now=Date.now()){
 const $=load(raw,{xmlMode:true}),out=[];
 if(!$('rss,feed,rdf\\:RDF').length)throw Error('Kein RSS-/Atom-Feed');
 $('item,entry').slice(0,80).each((_,el)=>{
  const row=$(el),title=text(row.find('title').first().text()).slice(0,350);
  const url=safeURL(row.find('link[rel="alternate"]').attr('href')||row.find('link').first().attr('href')||row.find('link').first().text());
  const publishedAt=new Date(row.find('pubDate').first().text()||row.find('published').first().text()||row.find('dc\\:date').first().text()||row.find('updated').first().text());
  if(!title||!url||!Number.isFinite(+publishedAt)||+publishedAt>now+300000||+publishedAt<=now-TTL)return;
  const imageUrl=safeURL(row.find('media\\:content[medium="image"],media\\:thumbnail,enclosure[type^="image/"]').first().attr('url'));
  const lat=Number(row.find('geo\\:lat').text()),lon=Number(row.find('geo\\:long').text()),point=row.find('georss\\:point').text().trim().split(/\s+/).map(Number);
  let location=null;
  if(row.find('geo\\:lat').length&&row.find('geo\\:long').length&&Number.isFinite(lat)&&Number.isFinite(lon))location=coordinates(lat,lon);
  else if(point.length===2&&point.every(Number.isFinite))location=coordinates(...point);
  out.push({id:hash(url),title,url,description:text(row.find('description,summary').first().text()).slice(0,220),imageUrl,source:source.name,sourceId:source.id,sourceCountry:source.country,language:source.language,category:source.category,publishedAt:publishedAt.toISOString(),fetchedAt:new Date(now).toISOString(),expiresAt:new Date(Math.min(+publishedAt+TTL,now+TTL)-60000).toISOString(),location,geoQuality:location?'Koordinaten aus dem Feed; Bezug nicht redaktionell geprüft':'Ereignisort unbekannt'});
 });return out;
}
export function normalizePlace(p){
 const {lat,lon}=coordinates(p.lat,p.lon),a=p.address||{};
 return {id:`${p.osm_type||'point'}:${p.osm_id||`${lat},${lon}`}`,name:p.name||a.city||a.town||a.village||a.suburb||p.display_name?.split(',')[0]||'Geografischer Punkt',displayName:p.display_name||'',country:a.country||'',countryCode:(a.country_code||'').toUpperCase(),region:a.state||a.region||a.county||'',district:a.suburb||a.neighbourhood||'',level:p.addresstype||p.type||'coordinate',lat,lon,bounds:p.boundingbox?.map(Number)||null,timezone:tzlookup(lat,lon),wikidata:p.extratags?.wikidata||null,attribution:'© OpenStreetMap-Mitwirkende · ODbL'};
}
export function normalizeWeather(data,lat,lon,now=Date.now()){
 const series=data.properties?.timeseries;if(!series?.length)throw Error('Wetterdaten fehlen');
 const timezone=tzlookup(lat,lon),day=t=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
 const current=series.find(x=>Date.parse(x.time)>=now-3600000)||series[0],d=current.data.instant.details;
 const temps=series.filter(x=>day(x.time)===day(now)).map(x=>x.data.instant.details.air_temperature).filter(Number.isFinite);
 return {temperature:d.air_temperature,humidity:d.relative_humidity,wind:d.wind_speed,windDirection:d.wind_from_direction,symbol:current.data.next_1_hours?.summary?.symbol_code||current.data.next_6_hours?.summary?.symbol_code||'cloudy',precipitation:current.data.next_1_hours?.details?.precipitation_amount??null,min:temps.length?Math.min(...temps):null,max:temps.length?Math.max(...temps):null,validAt:current.time,updatedAt:data.properties.meta.updated_at,fetchedAt:new Date(now).toISOString(),timezone,source:'MET Norway',license:'CC BY 4.0',kind:'Modellvorhersage',stale:false};
}
export function createWorldService({pool,fetcher=fetch,clock=Date.now}){
 const cached=async id=>(await pool.query('SELECT body,expires_at FROM marcel_world.cache WHERE id=$1',[id])).rows[0];
 const saveCache=async(id,body,ms)=>{await pool.query('INSERT INTO marcel_world.cache(id,body,expires_at) VALUES($1,$2,now()+$3*interval \'1 millisecond\') ON CONFLICT(id) DO UPDATE SET body=excluded.body,expires_at=excluded.expires_at',[id,body,ms]);return body;};
 async function json(url,options={}){const r=await fetcher(url,{headers:{'User-Agent':ua,Accept:'application/json',...options.headers},signal:AbortSignal.timeout(12000),redirect:'error'});if(!r.ok)throw Error(`Quelle antwortet mit HTTP ${r.status}`);const raw=await r.text();if(raw.length>3000000)throw Error('Antwort zu groß');return {body:JSON.parse(raw),headers:r.headers};}
 async function geo(params){
  const id='geo:'+hash(params.toString()),hit=await cached(id);if(hit&&+new Date(hit.expires_at)>clock())return hit.body;
  // Cross-process gate. Explicit user actions only, no autocomplete or bulk indexing.
  const client=await pool.connect();
  try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(1810202605)');
   const previous=(await client.query("SELECT body FROM marcel_world.cache WHERE id='nominatim-rate'")).rows[0]?.body;
   if(previous&&clock()-previous.at<1100)throw Object.assign(Error('Bitte einen Moment warten und die Ortssuche erneut ausführen.'),{status:429});
   await client.query("INSERT INTO marcel_world.cache(id,body,expires_at) VALUES('nominatim-rate',$1,now()+interval '1 day') ON CONFLICT(id) DO UPDATE SET body=excluded.body,expires_at=excluded.expires_at",[{at:clock()}]);await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  const operation=params.has('q')?'search':'reverse';params.set('format','jsonv2');params.set('addressdetails','1');params.set('extratags','1');params.set('accept-language','de');
  const {body}=await json(`https://nominatim.openstreetmap.org/${operation}?${params}`);
  const places=(Array.isArray(body)?body:body.error?[]:[body]).map(normalizePlace);return saveCache(id,places,30*86400000);
 }
 async function search(q){q=String(q||'').trim();if(q.length<2||q.length>160)throw Object.assign(Error('Bitte einen Ortsnamen mit 2–160 Zeichen eingeben.'),{status:400});return geo(new URLSearchParams({q,limit:'8'}));}
 async function reverse(lat,lon,zoom=12){const c=coordinates(lat,lon);return geo(new URLSearchParams({lat:c.lat.toFixed(5),lon:c.lon.toFixed(5),zoom:String(Math.max(3,Math.min(18,Number(zoom)||12)))}));}
 async function weather(lat,lon){
  const c=coordinates(lat,lon),id=`weather:${c.lat.toFixed(3)},${c.lon.toFixed(3)}`,hit=await cached(id);
  if(hit&&+new Date(hit.expires_at)>clock())return hit.body;
  try{const {body,headers}=await json(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${c.lat.toFixed(3)}&lon=${c.lon.toFixed(3)}`);const value=normalizeWeather(body,c.lat,c.lon,clock());return await saveCache(id,value,Math.max(900000,(Date.parse(headers.get('expires'))||clock()+1800000)-clock()));}
  catch(e){if(hit&&clock()-Date.parse(hit.body.fetchedAt)<86400000)return {...hit.body,stale:true,error:'Wetterquelle nicht erreichbar; letzter erfolgreicher Stand.'};throw e;}
 }
 async function placeInfo(id){
  if(!/^Q[1-9]\d{0,12}$/.test(id||''))return null;const key='place:'+id,hit=await cached(key);if(hit&&+new Date(hit.expires_at)>clock())return hit.body;
  const {body}=await json(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`),entity=body.entities?.[id];
  const link=entity?.sitelinks?.dewiki||entity?.sitelinks?.enwiki;if(!link)return null;
  const language=entity.sitelinks.dewiki?'de':'en',title=link.title;
  const {body:page}=await json(`https://${language}.wikipedia.org/w/api.php?action=query&format=json&prop=extracts%7Cpageimages%7Ccoordinates&exintro=1&explaintext=1&piprop=thumbnail&pithumbsize=900&titles=${encodeURIComponent(title)}`);
  const article=Object.values(page.query?.pages||{})[0];
  // Only the exact Wikidata sitelink is used. Image is withheld without license metadata.
  const result={title,description:article?.extract?.slice(0,700)||entity.descriptions?.de?.value||'',url:`https://${language}.wikipedia.org/wiki/${encodeURIComponent(title)}`,license:'CC BY-SA · Wikipedia',image:null};
  const file=entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value||article?.pageimage;
  if(file){try{const {body:media}=await json(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url%7Cextmetadata&iiurlwidth=1000&titles=${encodeURIComponent('File:'+file)}`);const info=Object.values(media.query?.pages||{})[0]?.imageinfo?.[0],meta=info?.extmetadata;
   if(info&&/CC BY|Public domain|CC0/i.test(meta?.LicenseShortName?.value||''))result.image={url:safeURL(info.thumburl||info.url),page:safeURL(info.descriptionurl),artist:text(meta.Artist?.value).slice(0,150),license:text(meta.LicenseShortName.value),licenseUrl:safeURL(meta.LicenseUrl?.value)};
  }catch{ /* A missing image never substitutes another city. */ }}
  return saveCache(key,result,7*86400000);
 }
 async function cleanup(){const removed=await pool.query('DELETE FROM marcel_world.news WHERE expires_at<=now()');await pool.query('DELETE FROM marcel_world.cache WHERE expires_at<now()-interval \'1 day\'');const state={at:new Date(clock()).toISOString(),deleted:removed.rowCount||0};await saveCache('maintenance',state,86400000);return state;}
 async function sync(){
  const client=await pool.connect();let locked=false;
  try{locked=(await client.query('SELECT pg_try_advisory_lock(1810202606) AS locked')).rows[0].locked;if(!locked)return;
   await cleanup();
   for(const source of sources){
    const previous=(await pool.query('SELECT body FROM marcel_world.sources WHERE id=$1',[source.id])).rows[0]?.body||{};
    if(Date.parse(previous.nextAttemptAt||0)>clock())continue;
    let state={...previous,...source,lastAttemptAt:new Date(clock()).toISOString(),nextAttemptAt:new Date(clock()+1800000).toISOString()};
    try{const response=await fetchNews(source.url,previous,(url,options)=>fetcher(url,{...options,headers:{...options.headers,'User-Agent':ua}}));
     let items=[];if(!response.notModified)items=parseFeed(response.raw,source,clock());
     for(const item of items)await pool.query('INSERT INTO marcel_world.news(id,body,published_at,fetched_at,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',[item.id,item,item.publishedAt,item.fetchedAt,item.expiresAt]);
     state={...state,etag:response.etag,lastModified:response.lastModified,lastSuccessAt:new Date(clock()).toISOString(),error:null,failures:0,received:items.length};
    }catch(e){const failures=(previous.failures||0)+1;state={...state,error:String(e.message).slice(0,160),failures,nextAttemptAt:new Date(clock()+Math.max(e.retryMs||0,Math.min(21600000,1800000*2**Math.min(failures-1,4)))).toISOString()};}
    await pool.query('INSERT INTO marcel_world.sources(id,body) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET body=excluded.body',[source.id,state]);
   }
  }finally{if(locked)await client.query('SELECT pg_advisory_unlock(1810202606)');client.release();}
 }
 async function news({category,scope='world',name,country,lat,lon,page=0}={}){
  const rows=(await pool.query('SELECT body FROM marcel_world.news WHERE expires_at>now() ORDER BY published_at DESC LIMIT 2000')).rows.map(r=>r.body);
  let list=rows;if(category&&category!=='Alle')list=list.filter(x=>x.category===category);
  if(scope==='local')list=list.filter(x=>x.location&&Math.hypot(x.location.lat-Number(lat),(x.location.lon-Number(lon))*Math.cos(Number(lat)*Math.PI/180))<.3);
  if(scope==='mentions'){const q=String(name||'').toLocaleLowerCase();list=q.length>2?list.filter(x=>x.title.toLocaleLowerCase().includes(q)):[];}
  if(scope==='country')list=list.filter(x=>x.sourceCountry===country);
  const statuses=(await pool.query('SELECT body FROM marcel_world.sources ORDER BY id')).rows.map(r=>r.body);
  return {items:list.slice(Math.max(0,Number(page)||0)*30,Math.max(0,Number(page)||0)*30+30),total:list.length,page:Number(page)||0,scope,sources:statuses,activeSources:statuses.filter(x=>x.lastSuccessAt&&!x.error&&rows.some(r=>r.sourceId===x.id)).length,reachableSources:statuses.filter(x=>x.lastSuccessAt&&!x.error).length,configuredSources:sources.length,maintenance:(await cached('maintenance'))?.body||null,markers:rows.filter(x=>x.location).slice(0,100).map(x=>({id:x.id,...x.location,title:x.title})),coverageNote:'Herkunftsland bezeichnet die Quelle, nicht den Ereignisort. Ortsnennungen sind keine verifizierten lokalen Meldungen.'};
 }
 async function bookmark(id,notes=''){
  if(!/^[a-f0-9]{64}$/.test(id||''))throw Object.assign(Error('Ungültige Nachricht.'),{status:400});
  const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(1810202604)');
   const entryId='news:'+id,existing=(await client.query('SELECT body FROM marcel_knowledge.entries WHERE id=$1',[entryId])).rows[0]?.body;if(existing){await client.query('COMMIT');return existing;}
   const item=(await client.query('SELECT body FROM marcel_world.news WHERE id=$1 AND expires_at>now()',[id])).rows[0]?.body;if(!item)throw Object.assign(Error('Nachricht ist abgelaufen oder nicht vorhanden.'),{status:404});
   const now=new Date(clock()).toISOString(),documentId='news-source:'+id;
   const document={id:documentId,title:item.title,type:'news_reference',url:item.url,source:item.source,createdAt:now,updatedAt:now,importedAt:now,status:'active',project:'marcel',contentHash:id,license:'Verweis auf Originalquelle; kein Volltextarchiv'};
   const entry={id:entryId,documentId,project:'marcel',text:`${item.title}\n${item.description||''}\nQuelle: ${item.source}\nOriginal: ${item.url}\nVeröffentlicht: ${item.publishedAt}${notes?'\nPersönliche Notiz: '+String(notes).slice(0,2000):''}`,title:item.title,url:item.url,source:item.source,publishedAt:item.publishedAt,domains:['PERSONAL_KNOWLEDGE'],topics:[item.category],kind:'source_reference',knowledgeLayer:'KNOWLEDGE_LIBRARY',status:'active',sensitivity:'private',personal:false,reviewRequired:false,sourceAuthority:'external_news',locator:item.url,contentHash:id,version:1,createdAt:now,updatedAt:now,bookmarkedBy:'owner'};
   if(String(notes).trim()){entry.personal=true;entry.reviewedBy='owner';}
   const evidence={id:'news-evidence:'+id,entryId,documentId,url:item.url,locator:item.url,quote:item.title,createdAt:now};
   for(const [collection,value]of [['documents',document],['entries',entry],['evidence',evidence]])await client.query(`INSERT INTO marcel_knowledge.${collection}(id,body) VALUES($1,$2)`,[value.id,value]);
   await client.query('COMMIT');return entry;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }
 return {search,reverse,weather,placeInfo,news,sync,cleanup,bookmark};
}
