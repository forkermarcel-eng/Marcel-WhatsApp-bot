import {readFileSync} from 'node:fs';
const geo=JSON.parse(readFileSync(new URL('../Brain/assets/earth-countries.geojson',import.meta.url),'utf8'));
export const fold=s=>String(s||'').normalize('NFKD').replace(/\p{Diacritic}/gu,'').toLocaleLowerCase('de').replace(/ß/g,'ss').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export const latin=s=>/\p{Script=Latin}/u.test(s||'');
const countryNames=new Intl.DisplayNames(['de'],{type:'region'});
export const countries=geo.features.map(f=>{const p=f.properties,code=p.ISO_A2_EH||p.ISO_A2;return {id:'country:'+code,name:p.NAME_DE||countryNames.of(code),country:p.NAME_DE||countryNames.of(code),countryCode:code,wikidata:p.WIKIDATAID||null,level:'country',lat:p.LABEL_Y,lon:p.LABEL_X,aliases:[p.NAME_DE,p.NAME_EN,p.NAME_LONG,p.ADMIN,p.NAME,p.ADM0_A3],geometry:f.geometry};}).filter(c=>/^[A-Z]{2}$/.test(c.countryCode)&&Number.isFinite(c.lat)&&Number.isFinite(c.lon));
function inRing(lon,lat,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const [x,y]=ring[i],[a,b]=ring[j];if((y>lat)!==(b>lat)&&lon<(a-x)*(lat-y)/(b-y)+x)inside=!inside;}return inside;}
export function contains(geometry,lat,lon){if(!geometry)return false;const polygons=geometry.type==='MultiPolygon'?geometry.coordinates:geometry.type==='Polygon'?[geometry.coordinates]:[];return polygons.some(p=>inRing(lon,lat,p[0])&&!p.slice(1).some(r=>inRing(lon,lat,r)));}
export const countryAt=(lat,lon)=>countries.find(c=>contains(c.geometry,lat,lon))||null;
export function preferredName(p){const n=p.namedetails||{},original=p.name||p.display_name?.split(',')[0]||'';return n['name:de']||n['name:en']||n['name:latin']||n.int_name||Object.entries(n).find(([k,v])=>/Latn/.test(k)&&latin(v))?.[1]||original;}
export function compactGerman(text,max=300){
 // Wikipedia pronunciation is useful in a full article, but consumes a compact card.
 text=String(text||'');let start=text.indexOf('(');if(start>=0&&start<100){let depth=0,end=-1;for(let i=start;i<text.length;i++){if(text[i]==='(')depth++;if(text[i]===')'&&!--depth){end=i;break;}}if(end>start&&/standarddeutsch|bairisch|Aussprache|IPA|[əɐʏɪˈ]/u.test(text.slice(start,end)))text=(text.slice(0,start)+text.slice(end+1)).replace(/\s+/g,' ');}
if(!String(text||'').trim())return '';const sentences=[...new Intl.Segmenter('de',{granularity:'sentence'}).segment(String(text))].map(s=>s.segment.trim());let out='';for(const s of sentences.slice(0,2)){if((out+' '+s).trim().length>max)break;out=(out+' '+s).trim();}return out||String(text).slice(0,max).replace(/\s+\S*$/,'')+'…';}
export function mentions(text,aliases){const hay=' '+fold(text)+' ';return (aliases||[]).some(a=>{const s=fold(a);return s.length>=3&&hay.includes(' '+s+' ');});}
export function placeIndex(places=[]){const all=[...countries,...places.filter(p=>p?.name&&Number.isFinite(p.lat)&&Number.isFinite(p.lon))];const index=new Map();for(const p of all){const key=p.id||`${p.lat},${p.lon}`;if(!index.has(key)){const aliases=[...new Set([p.name,...p.aliases||[]])].filter(Boolean);index.set(key,{...p,geometry:undefined,aliases,tokens:aliases.map(fold).filter(s=>s.length>=3)});}}return [...index.values()];}
export function enrichLocations(item,index){const refs=[...(item.geoRefs||[])];
 if(item.location){const c=countryAt(item.location.lat,item.location.lon);refs.push({id:'point:'+item.id,name:item.eventPlace||item.title,level:'point',...item.location,countryCode:c?.countryCode||'',country:c?.name||'',role:item.geoRole||'feed_location',quality:item.geoQuality});}
 // A textual mention never becomes a verified event location.
 const title=' '+fold(item.title)+' ';
 for(const p of index){if(p.tokens.some(t=>title.includes(' '+t+' ')))refs.push({id:p.id,name:p.name,lat:p.lat,lon:p.lon,countryCode:p.countryCode||'',country:p.country||'',region:p.region||'',level:p.level||'city',wikidata:p.wikidata||null,timezone:p.timezone||null,role:'mentioned',quality:p.level==='country'?'Landesbezug im Titel':'Ortsnennung im Titel · Ereignisort ungeprüft'});}
 const unique=new Map();for(const r of refs)if(Number.isFinite(r.lat)&&Number.isFinite(r.lon)&&!unique.has(r.id))unique.set(r.id,r);return [...unique.values()].slice(0,8);
}
export function proximity(a,b,km=35){if(!a||!b||!Number.isFinite(Number(b.lat))||!Number.isFinite(Number(b.lon)))return false;const dlon=((a.lon-Number(b.lon)+540)%360)-180;return Math.hypot(a.lat-Number(b.lat),dlon*Math.cos(Number(b.lat)*Math.PI/180))*111.2<=km;}
export function relation(item,place){if(!place)return 'world';
 const refs=item.geoRefs||[];
 if(refs.some(r=>r.role==='event'&&proximity(r,place)))return 'local';
 if(refs.some(r=>r.level!=='country'&&r.name&&mentions(r.name,[place.name,...place.aliases||[]])&&proximity(r,place,80)))return 'place';
 if(mentions(item.title,[place.name,...place.aliases||[]])&&place.level!=='country')return 'place';
 if(place.region&&(mentions(item.title,[place.region])||item.coverage?.regions?.some(r=>fold(r)===fold(place.region))))return 'region';
 if(place.countryCode&&(refs.some(r=>r.countryCode===place.countryCode)||item.coverage?.eventCountry===place.countryCode))return 'country';
 return null;
}
