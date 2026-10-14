"""Offline render harness, test-only; real localhost API, no external navigation."""
from playwright.sync_api import sync_playwright
from pathlib import Path
import json, urllib.request, urllib.error,re
root=Path(__file__).resolve().parents[2]
def bridge(source,url,opts):
 path=str(url).split('?',1)
 if path[0]!='/api/trading':raise ValueError('Only local trading API allowed')
 headers=opts.get('headers',{})
 data=opts.get('body')
 request=urllib.request.Request('http://127.0.0.1:3090'+url,data=data.encode() if data else None,headers=headers,method=opts.get('method','GET'))
 try: response=urllib.request.urlopen(request)
 except urllib.error.HTTPError as e: response=e
 return {'status':response.status,'body':response.read().decode(),'headers':dict(response.headers)}
def mount(page):
 page.expose_binding('localApiTestBridge',bridge)
 html=(root/'Trading/index.html').read_text(encoding='utf-8')
 html=re.sub(r'<link\b[^>]*>','',html);html=re.sub(r'<script[^>]*>.*?</script>','',html,flags=re.S)
 css=(root/'platform.css').read_text(encoding='utf-8')+'\n'+(root/'Trading/trading.css').read_text(encoding='utf-8')
 html=html.replace('</head>','<style>'+css+'</style></head>')
 page.set_content(html)
 page.evaluate('''() => {window.fetch=async (url,opts={})=>{const x=await localApiTestBridge(url,opts);return new Response(x.body,{status:x.status,headers:x.headers})};if(!crypto.randomUUID)crypto.randomUUID=()=>('10000000-1000-4000-8000-100000000000').replace(/[018]/g,c=>(c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));}''')
 domain=(root/'Trading/domain.js').read_text(encoding='utf-8');names=re.findall(r'export (?:const|function|class) (\w+)',domain)
 page.add_script_tag(content='window.TradingDomain=(()=>{'+domain.replace('export ','')+';return {'+','.join(names)+'}})();')
 chart=(root/'Trading/chart.js').read_text(encoding='utf-8').replace("import {ema} from './domain.js';",'const {ema}=TradingDomain;').replace('export class ','class ')
 page.add_script_tag(content='window.ChartModule=(()=>{'+chart+';return {TradingChart}})();')
 news=(root/'Trading/news-context.js').read_text(encoding='utf-8');names=re.findall(r'export (?:const|function|class) (\w+)',news)
 page.add_script_tag(content='window.NewsContext=(()=>{'+news.replace('export ','')+';return {'+','.join(names)+'}})();')
 app=(root/'Trading/trading.js').read_text(encoding='utf-8');app=re.sub(r"import \{([^}]+)\} from './domain.js';",r'const {\1}=TradingDomain;',app);app=app.replace("import {TradingChart} from './chart.js';",'const {TradingChart}=ChartModule;')
 app=re.sub(r"import \{([^}]+)\} from './news-context.js';",r'const {\1}=NewsContext;',app)
 page.add_script_tag(content='(()=>{'+app+'})()');page.wait_for_selector('#chart-host canvas');page.wait_for_timeout(700)
