import {randomUUID} from 'node:crypto';
import {fail,short} from './model.js';

// The dashboard currently has exactly one authenticated owner. Never accept an
// owner from request data. These records share the existing private export and
// repository transaction, without adding tables or changing existing items.
const prefix='owner-desk-';
const types=new Set(['draft','document']);
export function createOrganisationDesk(repository){
 const valid=(type)=>{if(!types.has(type))throw fail('Unbekannter Bereich.');return type;};
 return {
  async list(type){valid(type);return (await repository.list('settings')).filter(x=>x.id.startsWith(prefix+type+'-')&&x.deskType===type).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));},
  async save(input){
   const type=valid(input.type),id=input.id||prefix+type+'-'+randomUUID();
   if(typeof id!=='string'||!id.startsWith(prefix+type+'-')||!/^[a-z0-9-]{1,100}$/.test(id))throw fail('Ungültige Eintrags-ID.');
   const title=short(input.title,300),text=short(input.text,64000);
   if(!title)throw fail('Titel oder Betreff fehlt.');
   const extra=type==='draft'?{to:short(input.to,1000)}:{folder:short(input.folder,100),status:short(input.status,30)};
   if(type==='document'&&!['offen','in Bearbeitung','erledigt'].includes(extra.status))throw fail('Ungültiger Dokumentstatus.');
   if(type==='draft'&&extra.to&&extra.to.split(/[,;]/).some(x=>!/^\s*[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+\s*$/.test(x)))throw fail('Empfängeradresse prüfen.');
   return repository.transaction(async tx=>{
    const old=await tx.get('settings',id);
    if(old&&old.version!==input.version)throw fail('Eintrag wurde inzwischen geändert. Bitte neu laden.',409);
    if(!old&&input.id)throw fail('Eintrag nicht gefunden.',404);
    if(old&&old.title===title&&old.text===text&&Object.entries(extra).every(([key,value])=>old[key]===value))return old;
    const item={id,deskType:type,title,text,...extra,version:(old?.version||0)+1,createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
    await tx.put('settings',item);return item;
   });
  }
 };
}
