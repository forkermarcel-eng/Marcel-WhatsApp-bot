// Opt-in private-network REST adapter. Not mounted on any production route.
export function createHomeAssistant({url,token,approved=false,allowedEntities=[],fetchImpl=fetch}={}){
 const request=async path=>{
  if(!approved||!token)throw Error('Home Assistant ist nicht freigegeben.');
  const base=new URL(url),host=base.hostname;
  const octets=host.split('.').map(Number),ipv4=octets.length===4&&octets.every(n=>Number.isInteger(n)&&n>=0&&n<=255);
  const privateIP=ipv4&&(octets[0]===10||octets[0]===127||octets[0]===192&&octets[1]===168||octets[0]===172&&octets[1]>=16&&octets[1]<=31||octets[0]===100&&octets[1]>=64&&octets[1]<=127);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!(privateIP||['localhost','[::1]'].includes(host)))throw Error('Explizite private IP oder Loopback-Adresse erforderlich.');
  const response=await fetchImpl(new URL(path,base),{headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('Home Assistant ist nicht erreichbar.');const raw=await response.text();if(raw.length>1024*1024)throw Error('Home-Assistant-Antwort zu groß.');return JSON.parse(raw);
 };
 return {async state(entity){if(!/^[a-z_]+\.[a-z0-9_]+$/.test(entity)||!allowedEntities.includes(entity))throw Error('Entität nicht freigegeben.');return request('/api/states/'+encodeURIComponent(entity));},async services(){return request('/api/services');},controlEnabled:false};
}
