// Public publisher requests only. No database, production cache or model access.
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {sources} from '../brain-world/sources.js';
import {parseFeed} from '../brain-world/service.js';
import {fetchNews} from '../trading-core/server/news-sources.js';
const args=process.argv.slice(2),position=args.indexOf('--out'),output=position>=0?args[position+1]:null;
const results=[];let next=0;
await Promise.all(Array.from({length:4},async()=>{while(next<sources.length){const source=sources[next++],start=performance.now();try{const response=await fetchNews(source.url,{},(url,options)=>fetch(url,{...options,headers:{...options.headers,'User-Agent':'MarcelBrain/1.0 (+https://marcelmarlow.com)'}}));const items=parseFeed(response.raw,source);results.push({id:source.id,name:source.name,language:source.language,reachable:true,recentItems:items.length,ms:Math.round(performance.now()-start)});}catch(error){results.push({id:source.id,name:source.name,language:source.language,reachable:false,error:String(error.message).slice(0,160),ms:Math.round(performance.now()-start)});}}}));
const report={checkedAt:new Date().toISOString(),productionAccess:false,configured:sources.length,reachable:results.filter(r=>r.reachable).length,results:results.sort((a,b)=>a.id.localeCompare(b.id))};
if(output)writeFileSync(resolve(output),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify({checkedAt:report.checkedAt,configured:report.configured,reachable:report.reachable,failures:report.results.filter(r=>!r.reachable),productionAccess:false},null,2));
