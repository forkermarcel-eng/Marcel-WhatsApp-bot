import {load} from 'cheerio';
import {createHash} from 'node:crypto';
import tzlookup from 'tz-lookup';
import {fetchNews} from '../trading-core/server/news-sources.js';
import {sources,sourceChecks} from './sources.js';
import {preferredName,latin,compactGerman,placeIndex,enrichLocations,relation,countryAt,fold} from './geography.js';
import {presentItem} from './presentation.js';
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
  const stamp=row.find('pubDate').first().text()||row.find('published').first().text()||row.find('dc\\:date').first().text()||row.find('updated').first().text();
  const publishedAt=new Date(stamp.replace(/\bCEST\b/,'+0200').replace(/\bCET\b/,'+0100'));
  if(!title||!url||!Number.isFinite(+publishedAt)||+publishedAt>now+300000||+publishedAt<=now-TTL)return;
  const embedded=load(row.find('description,summary,content\\:encoded').first().text());
  const imageUrl=safeURL(row.find('media\\:content[medium="image"],media\\:content[type^="image/"],media\\:thumbnail,enclosure[type^="image/"]').first().attr('url')||embedded('img').first().attr('src'));
  const lat=Number(row.find('geo\\:lat').text()),lon=Number(row.find('geo\\:long').text()),point=row.find('georss\\:point').text().trim().split(/\s+/).map(Number);
  let location=null;
  if(row.find('geo\\:lat').length&&row.find('geo\\:long').length&&Number.isFinite(lat)&&Number.isFinite(lon))location=coordinates(lat,lon);
  else if(point.length===2&&point.every(Number.isFinite))location=coordinates(...point);
  out.push({id:hash(url),title,url,description:text(row.find('description,summary').first().text()).slice(0,220),imageUrl,source:source.name,sourceId:source.id,sourceCountry:source.country,language:source.language,category:source.category,publishedAt:publishedAt.toISOString(),fetchedAt:new Date(now).toISOString(),expiresAt:new Date(Math.min(+publishedAt+TTL,now+TTL)-60000).toISOString(),location,geoQuality:location?'Koordinaten aus dem Feed; Bezug nicht redaktionell geprüft':'Ereignisort unbekannt'});
  if(source.id==='usgs'&&out.at(-1)?.location){out.at(-1).geoRole='event';out.at(-1).geoQuality='Ereigniskoordinaten aus dem offiziellen USGS-Feed';}
 });return out;
}
export function normalizePlace(p){
 const {lat,lon}=coordinates(p.lat,p.lon),a=p.address||{};
 const name=preferredName(p)||a.city||a.town||a.village||a.suburb||'Geografischer Punkt',countryCode=(a.country_code||'').toUpperCase(),region=a.state||a.region||a.county||'';
 let country=a.country||'';try{if(countryCode)country=new Intl.DisplayNames(['de'],{type:'region'}).of(countryCode);}catch{}
 return {id:`${p.osm_type||'point'}:${p.osm_id||`${lat},${lon}`}`,name,originalName:p.name||name,aliases:[...new Set([name,p.name,p.namedetails?.['name:de'],p.namedetails?.['name:en']].filter(Boolean))],displayName:[name,latin(region)?region:'',country].filter(Boolean).join(', '),country,countryCode,region,district:a.suburb||a.neighbourhood||'',level:p.addresstype||p.type||'coordinate',lat,lon,bounds:p.boundingbox?.map(Number)||null,timezone:tzlookup(lat,lon),wikidata:p.extratags?.wikidata||null,attribution:'© OpenStreetMap-Mitwirkende · ODbL'};
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
 const saveCache=async(id,body,ms)=>{await pool.query('INSERT INTO marcel_world.cache(id,body,expires_at) VALUES($1,$2,now()+$3*interval \'1 millisecond\') ON CONFLICT(id) DO UPDATE SET body=excluded.body,expires_at=excluded.expires_at',[id,JSON.stringify(body),ms]);return body;};
 async function json(url,options={}){const r=await fetcher(url,{headers:{'User-Agent':ua,Accept:'application/json',...options.headers},signal:AbortSignal.timeout(12000),redirect:'error'});if(!r.ok)throw Error(`Quelle antwortet mit HTTP ${r.status}`);const raw=await r.text();if(raw.length>3000000)throw Error('Antwort zu groß');return {body:JSON.parse(raw),headers:r.headers};}
 async function geo(params){
  const id='geo:v2:'+hash(params.toString()),hit=await cached(id);if(hit&&+new Date(hit.expires_at)>clock())return hit.body;
  // Cross-process gate. Explicit user actions only, no autocomplete or bulk indexing.
  const client=await pool.connect();
  try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(1810202605)');
   const previous=(await client.query("SELECT body FROM marcel_world.cache WHERE id='nominatim-rate'")).rows[0]?.body;
   if(previous&&clock()-previous.at<1100)throw Object.assign(Error('Bitte einen Moment warten und die Ortssuche erneut ausführen.'),{status:429});
   await client.query("INSERT INTO marcel_world.cache(id,body,expires_at) VALUES('nominatim-rate',$1,now()+interval '1 day') ON CONFLICT(id) DO UPDATE SET body=excluded.body,expires_at=excluded.expires_at",[{at:clock()}]);await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  const operation=params.has('q')?'search':'reverse';params.set('format','jsonv2');params.set('addressdetails','1');params.set('extratags','1');params.set('namedetails','1');params.set('accept-language','de,en');
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
  if(!/^Q[1-9]\d{0,12}$/.test(id||''))return null;const key='place:de:v2:'+id,hit=await cached(key);if(hit&&+new Date(hit.expires_at)>clock())return hit.body;
  const {body}=await json(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`),entity=body.entities?.[id];
  if(!entity)return null;const link=entity.sitelinks?.dewiki,title=link?.title||entity.labels?.de?.value||entity.labels?.en?.value||id;
  let article=null;if(link){const {body:page}=await json(`https://de.wikipedia.org/w/api.php?action=query&format=json&prop=extracts%7Cpageimages&exintro=1&explaintext=1&piprop=thumbnail%7Cname&pithumbsize=900&titles=${encodeURIComponent(title)}`);article=Object.values(page.query?.pages||{})[0];}
  // Only the exact Wikidata sitelink is used. Image is withheld without license metadata.
  const fullDescription=article?.extract?.slice(0,2500)||entity.descriptions?.de?.value||'';
  const result={title,description:compactGerman(fullDescription,280),fullDescription,url:link?`https://de.wikipedia.org/wiki/${encodeURIComponent(title)}`:`https://www.wikidata.org/wiki/${id}`,license:link?'Wikipedia · CC BY-SA':'Wikidata · CC0',image:null};
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
    if(previous.url===source.url&&Date.parse(previous.nextAttemptAt||0)>clock())continue;
    let state={...previous,...source,lastAttemptAt:new Date(clock()).toISOString(),nextAttemptAt:new Date(clock()+1800000).toISOString()};
    try{const response=await fetchNews(source.url,previous.url===source.url?previous:{},(url,options)=>fetcher(url,{...options,headers:{...options.headers,'User-Agent':ua}}));
     let items=[];if(!response.notModified)items=parseFeed(response.raw,source,clock());
     for(const item of items){item.coverage=source.coverage||null;item.bookmarkPolicy=source.bookmarkPolicy||'reference';await pool.query('INSERT INTO marcel_world.news(id,body,published_at,fetched_at,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',[item.id,item,item.publishedAt,item.fetchedAt,item.expiresAt]);}
     state={...state,etag:response.etag,lastModified:response.lastModified,lastSuccessAt:new Date(clock()).toISOString(),error:null,failures:0,received:items.length};
    }catch(e){const failures=(previous.failures||0)+1;state={...state,error:String(e.message).slice(0,160),failures,nextAttemptAt:new Date(clock()+Math.max(e.retryMs||0,Math.min(21600000,1800000*2**Math.min(failures-1,4)))).toISOString()};}
    await pool.query('INSERT INTO marcel_world.sources(id,body) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET body=excluded.body',[source.id,state]);
   }
  }finally{if(locked)await client.query('SELECT pg_advisory_unlock(1810202606)');client.release();}
 }
 async function knownPlaces(){return (await pool.query("SELECT body FROM marcel_world.cache WHERE id LIKE 'geo:%' AND expires_at>now() LIMIT 500")).rows.flatMap(r=>Array.isArray(r.body)?r.body:[]);}
 async function news({category,scope='auto',name,country,region,level,lat,lon,placeId,language='de',ids,page=0}={}){
  page=Math.min(300,Math.max(0,Math.floor(Number(page)||0)));
  const [raw,places,statuses]=await Promise.all([
   pool.query('SELECT body FROM marcel_world.news WHERE expires_at>now() ORDER BY published_at DESC LIMIT 10000').then(r=>r.rows.map(x=>x.body)),
   knownPlaces(),pool.query('SELECT body FROM marcel_world.sources ORDER BY id').then(r=>r.rows.map(x=>x.body))]);
  const stored=places.find(p=>p.id===placeId);
  const place=stored||((name||country)&&Number.isFinite(Number(lat))&&Number.isFinite(Number(lon))?{name:String(name||''),level:String(level||'coordinate'),region:String(region||''),countryCode:String(country||''),lat:Number(lat),lon:Number(lon)}:null);
  const index=placeIndex(place?[...places,place]:places);
  const rows=raw.map(item=>{const p=presentItem(item),source=sources.find(s=>s.id===p.sourceId);return {...p,coverage:p.coverage||source?.coverage||null,bookmarkPolicy:p.bookmarkPolicy||source?.bookmarkPolicy||'reference',geoRefs:enrichLocations(p,index)};});
  const markerRows=rows.filter(x=>language==='originals'?x.language!=='de'&&x.kind!=='earthquake':x.language==='de');
  const markerGroups=new Map();
  for(const item of markerRows)for(const ref of item.geoRefs){const key=(item.kind==='earthquake'?'event:':'news:')+ref.id;let m=markerGroups.get(key);if(!m){m={...ref,id:key,kind:item.kind==='earthquake'?'earthquake':'news',ids:[],count:0,title:ref.level==='point'?(item.eventPlace||item.title):ref.name};markerGroups.set(key,m);}m.ids.push(item.id);m.count++;}
  let list=markerRows;if(category&&category!=='Alle')list=list.filter(x=>x.category===category);
  const wanted=Array.isArray(ids)?new Set(ids.filter(x=>/^[a-f0-9]{64}$/.test(x)).slice(0,500)):null;
  if(wanted?.size)list=list.filter(x=>wanted.has(x.id));
  list=list.map(x=>({...x,relation:relation(x,place)}));
  if(!wanted?.size&&place&&['auto','local','mentions','region','country'].includes(scope))list=list.filter(x=>scope==='auto'?x.relation:scope==='mentions'?x.relation==='place':x.relation===scope);
  if(scope==='source-country')list=list.filter(x=>x.sourceCountry===country);
  const priority={local:0,place:1,region:2,country:3,world:4};
  if(place&&!wanted?.size)list.sort((a,b)=>(priority[a.relation]??5)-(priority[b.relation]??5)||Date.parse(b.publishedAt)-Date.parse(a.publishedAt));
  const groups=Object.fromEntries(['local','place','region','country'].map(k=>[k,list.filter(x=>x.relation===k).length]));
  const perPage=!place&&scope==='auto'?8:30;
  return {items:list.slice(page*perPage,page*perPage+perPage),total:list.length,page,perPage,groups,scope,language,sources:statuses,sourceChecks,activeSources:statuses.filter(x=>x.lastSuccessAt&&!x.error&&rows.some(r=>r.sourceId===x.id)).length,germanSources:statuses.filter(x=>x.language==='de'&&!x.error&&rows.some(r=>r.sourceId===x.id)).length,reachableSources:statuses.filter(x=>x.lastSuccessAt&&!x.error).length,configuredSources:sources.length,maintenance:(await cached('maintenance'))?.body||null,markers:[...markerGroups.values()],coverageNote:'Ortsnennungen, Ereigniskoordinaten und Regionalangebote sind getrennt gekennzeichnet. Der Sitz einer Quelle begründet keinen Ereignisort.'};
 }
 async function favorites(place,remove=false){
  const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(1810202607)');const current=(await client.query("SELECT body FROM marcel_knowledge.meta WHERE id='world:favorites' FOR UPDATE")).rows[0]?.body||{id:'world:favorites',items:[]};
   if(place){const c=coordinates(place.lat,place.lon),id=String(place.id||`${c.lat},${c.lon}`).slice(0,150);current.items=current.items.filter(p=>p.id!==id);if(!remove){if(current.items.length>=100)throw Object.assign(Error('Maximal 100 Lieblingsorte.'),{status:400});current.items.push({id,...c,name:String(place.name||'Geografischer Punkt').slice(0,150),country:String(place.country||'').slice(0,100),countryCode:String(place.countryCode||'').slice(0,2),region:String(place.region||'').slice(0,150),level:String(place.level||'coordinate').slice(0,30),timezone:typeof place.timezone==='string'?place.timezone.slice(0,100):null,wikidata:/^Q\d+$/.test(place.wikidata||'')?place.wikidata:null});}
    current.updatedAt=new Date(clock()).toISOString();await client.query('INSERT INTO marcel_knowledge.meta(id,body) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET body=excluded.body',[current.id,JSON.stringify(current)]);
   }await client.query('COMMIT');return current.items;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }
 async function bookmark(id,notes=''){
  if(!/^[a-f0-9]{64}$/.test(id||''))throw Object.assign(Error('Ungültige Nachricht.'),{status:400});
  const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(1810202604)');
   const entryId='news:'+id,existing=(await client.query('SELECT body FROM marcel_knowledge.entries WHERE id=$1',[entryId])).rows[0]?.body;if(existing){await client.query('COMMIT');return existing;}
   let item=(await client.query('SELECT body FROM marcel_world.news WHERE id=$1 AND expires_at>now()',[id])).rows[0]?.body;if(!item)throw Object.assign(Error('Nachricht ist abgelaufen oder nicht vorhanden.'),{status:404});
   const policy=item.bookmarkPolicy||sources.find(s=>s.id===item.sourceId)?.bookmarkPolicy;item=presentItem(item);item.geoRefs=enrichLocations(item,placeIndex(await knownPlaces()));
   if(policy==='link-only')item={...item,title:'Gespeicherter Quellenlink · '+item.source,description:''};
   const now=new Date(clock()).toISOString(),documentId='news-source:'+id;
   const document={id:documentId,title:item.title,type:'news_reference',url:item.url,source:item.source,createdAt:now,updatedAt:now,importedAt:now,status:'active',project:'marcel',contentHash:id,license:'Verweis auf Originalquelle; kein Volltextarchiv'};
   const entry={id:entryId,documentId,project:'marcel',text:`${item.title}\n${item.description||''}\nQuelle: ${item.source}\nOriginal: ${item.url}\nVeröffentlicht: ${item.publishedAt}${notes?'\nPersönliche Notiz: '+String(notes).slice(0,2000):''}`,title:item.title,url:item.url,source:item.source,publishedAt:item.publishedAt,domains:['PERSONAL_KNOWLEDGE'],topics:[item.category],kind:'source_reference',knowledgeLayer:'KNOWLEDGE_LIBRARY',status:'active',sensitivity:'private',personal:false,reviewRequired:false,sourceAuthority:'external_news',locator:item.url,contentHash:id,version:1,createdAt:now,updatedAt:now,bookmarkedBy:'owner'};
   entry.geographicReferences=item.geoRefs;entry.description=item.description||'';entry.notes=String(notes).slice(0,2000);
   if(String(notes).trim()){entry.personal=true;entry.reviewedBy='owner';}
   const evidence={id:'news-evidence:'+id,entryId,documentId,url:item.url,locator:item.url,quote:item.title,createdAt:now};
   for(const [collection,value]of [['documents',document],['entries',entry],['evidence',evidence]])await client.query(`INSERT INTO marcel_knowledge.${collection}(id,body) VALUES($1,$2)`,[value.id,value]);
   await client.query('COMMIT');return entry;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }
 return {search,reverse,weather,placeInfo,news,sync,cleanup,bookmark,favorites};
}
