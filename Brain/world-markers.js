// Group genuine geographic references. A cluster retains all article IDs and an
// actual member coordinate; its centre never pretends to be an event location.
export function clusterMarkers(items,zoom=3.3){
 const size=zoom>3.7?24:zoom>2.8?12:zoom>2?5:zoom>1.5?2:.35,groups=new Map();
 for(const item of items||[]){if(!Number.isFinite(item.lat)||!Number.isFinite(item.lon)||Math.abs(item.lat)>90||Math.abs(item.lon)>180)continue;
  const key=`${item.kind||'news'}:${Math.floor((item.lat+90)/size)}:${Math.floor((item.lon+180)/size)}`;
  let group=groups.get(key);if(!group){group={...item,key,ids:[],members:0};groups.set(key,group);}group.members++;group.ids.push(...(item.ids||[]));
 }
 return [...groups.values()].map(g=>({...g,ids:[...new Set(g.ids)],count:new Set(g.ids).size}));
}
