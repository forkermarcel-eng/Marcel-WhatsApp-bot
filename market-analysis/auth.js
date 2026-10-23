import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
export const analysisCookie='marcel_analysis_session';
const hash=s=>createHash('sha256').update(s).digest('hex');
const sign=(body,key,scope)=>createHmac('sha256',key).update(scope+':'+body).digest('base64url');
function encode(data,key,scope){const body=Buffer.from(JSON.stringify(data)).toString('base64url');return body+'.'+sign(body,key,scope);}
function decode(token,key,scope,now,maxLifetime){
 try{if(typeof key!=='string'||!key||typeof token!=='string'||token.length>2048)return null;const [body,sig,...extra]=token.split('.');if(extra.length||!body||!sig)return null;const expected=sign(body,key,scope);if(sig.length!==expected.length||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;const data=JSON.parse(Buffer.from(body,'base64url').toString());if(data.v!==1||!Number.isSafeInteger(data.iat)||!Number.isSafeInteger(data.exp)||data.iat>now||data.exp<=now||data.exp-data.iat>maxLifetime||data.exp<=data.iat||!/^[a-f0-9]{64}$/.test(data.sub)||!/^[a-f0-9]{64}$/.test(data.sid))return null;return data;}catch{return null;}
}
export function mintAnalysisSession({username,dashboardSession,password,now=Date.now()}){
 return encode({v:1,sub:hash('dashboard:'+username),sid:hash(dashboardSession),iat:now,exp:now+86400000},password,'analysis-cookie-v1');
}
export function analysisIdentity(req,{password,now=Date.now()}={}){
 const cookies=Object.fromEntries(String(req.headers?.cookie||'').split(';').map(s=>{const at=s.indexOf('=');return at<0?['','']:[s.slice(0,at).trim(),s.slice(at+1)];}));
 const identity=decode(cookies[analysisCookie],password,'analysis-cookie-v1',now,86400000);
 return identity&&identity.sid===hash(cookies.marcel_dashboard_session||'')?identity:null;
}
export function mintAnalysisAssertion(identity,key,now=Date.now()){
 return encode({v:1,sub:identity.sub,sid:identity.sid,iat:now,exp:Math.min(identity.exp,now+30000)},key,'analysis-proxy-v1');
}
export function verifyAnalysisAssertion(req,{key,now=Date.now()}={}){
 return decode(req.headers?.['x-marcel-analysis-session'],key,'analysis-proxy-v1',now,30000);
}
export function secureBearer(req,key){
 if(typeof key!=='string'||!key)return false;const actual=req.headers?.authorization,expected='Bearer '+key;
 return typeof actual==='string'&&Buffer.byteLength(actual)===Buffer.byteLength(expected)&&timingSafeEqual(Buffer.from(actual),Buffer.from(expected));
}
