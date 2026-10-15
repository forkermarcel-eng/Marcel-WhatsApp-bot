import {load} from 'cheerio';
import {createHash} from 'node:crypto';
const id=url=>createHash('sha256').update(url).digest('hex');
export const EXTRA_NEWS=[
 {name:'IEA',url:'https://www.iea.org/news',topic:'energy supply',format:'index',ttl:120000},
 {name:'Treasury OFAC',url:'https://ofac.treasury.gov/recent-actions',topic:'sanctions',format:'index',ttl:120000},
 {name:'GDELT Discovery',url:'https://api.gdeltproject.org/api/v2/doc/doc?query=(oil%20OR%20%22Federal%20Reserve%22%20OR%20sanctions%20OR%20semiconductor)&mode=artlist&format=json&maxrecords=50&timespan=24h&sort=datedesc',format:'gdelt',ttl:3600000,topic:'Discovery'}
];
function headline(title,url,source,now,publishedAt=null,extra={}){
 try{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password)return null;url=u.href;}catch{return null;}
 if(!title)return null;
 return {id:id(url),title:String(title).replace(/\s+/g,' ').trim().slice(0,350),url,source,topic:'Makro',publishedAt,seen_at:now,observedAt:now,createdAt:now,verification:'SOURCE_REPORT',...extra};
}
export function parseNewsSource(raw,feed,now){
 if(feed.format==='gdelt'){
  const json=JSON.parse(raw);if(!Array.isArray(json.articles))throw Error('Invalid discovery format');
  return json.articles.map(a=>{const d=/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(a.seendate||'');const seen=d?`${d[1]}-${d[2]}-${d[3]}T${d[4]}:${d[5]}:${d[6]}Z`:now;
   return headline(a.title,a.url,a.domain||'GDELT Discovery',now,null,{seen_at:seen,discovery_source:'GDELT',topic:feed.topic});
  }).filter(Boolean);
 }
 const $=load(raw),rows=[];
 const selector=feed.name==='IEA'?'a.m-news-detailed-listing__link':'a[href^="/recent-actions/20"]';
 $(selector).slice(0,30).each((_,el)=>{
  const a=$(el),title=feed.name==='IEA'?a.find('h5').text():a.text(),url=new URL(a.attr('href'),feed.url).href;
  const publishedDate=feed.name==='IEA'?a.find('.m-news-detailed-listing__date').text().trim():url.match(/(\d{8})$/)?.[1];
  // Date-only indexes have no publication time/zone: retain the label, order by first seen.
  const day=feed.name==='Treasury OFAC'?publishedDate?.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3'):null;
  const parsedDate=Date.parse(day?day+'T00:00:00Z':publishedDate+' 00:00:00 UTC');
  const row=headline(title,url,feed.name,now,null,{published_date_label:publishedDate||null,published_date:Number.isFinite(parsedDate)?new Date(parsedDate).toISOString().slice(0,10):null,topic:feed.topic});if(row)rows.push(row);
 });
 if(!rows.length)throw Error('News index shape changed');return rows;
}
/** Conditional bounded GET. Cache validators only; never store article bodies. */
export async function fetchNews(url,previous={},fetcher=fetch){
 const headers={};if(previous.etag)headers['If-None-Match']=previous.etag;if((previous.last_modified||previous.lastModified))headers['If-Modified-Since']=previous.last_modified||previous.lastModified;
 const r=await fetcher(url,{headers,redirect:'error',signal:AbortSignal.timeout(12000)});
 if(r.status===304)return {notModified:true,httpStatus:304,etag:r.headers.get('etag')||previous.etag,lastModified:r.headers.get('last-modified')||previous.last_modified||previous.lastModified};
 if(!r.ok){const e=Error('News provider unavailable');e.httpStatus=r.status;const retry=r.headers.get('retry-after');e.retryMs=/^\d+$/.test(retry||'')?Number(retry)*1000:Math.max(0,Date.parse(retry)-Date.now())||0;throw e;}
 const cap=2_000_000;if(Number(r.headers.get('content-length')||0)>cap)throw Error('News response too large');
 let raw='';if(r.body?.getReader){const reader=r.body.getReader(),chunks=[];let size=0;try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>cap){await reader.cancel();throw Error('News response too large');}chunks.push(Buffer.from(x.value));}raw=Buffer.concat(chunks).toString('utf8');}finally{reader.releaseLock();}}else{raw=await r.text();if(Buffer.byteLength(raw)>cap)throw Error('News response too large');}
 return {raw,httpStatus:r.status,etag:r.headers.get('etag')?.slice(0,512)||null,lastModified:r.headers.get('last-modified')?.slice(0,128)||null};
}
