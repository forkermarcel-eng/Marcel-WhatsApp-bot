"""Offline fixture-only context/calendar rendering; no Production requests/writes."""
import json, os
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from pathlib import Path
from playwright.sync_api import sync_playwright
import ui_render_helpers as ui

out=Path(os.environ['TRADING_TEST_OUTPUT']);out.mkdir(parents=True,exist_ok=True)
now=datetime.now(timezone.utc)
iso=lambda d:d.isoformat().replace('+00:00','Z')
original=ui.bridge
def fixture(source,url,opts):
 if opts.get('method','GET')!='GET':raise AssertionError('Context render test is read-only')
 result=original(source,url,opts)
 if 'resource=bootstrap' not in url:return result
 data=json.loads(result['body'])
 assert data.get('demo') and data.get('mode')=='MEMORY_TEST'
 data['observations']=[{'id':key,'label':label,'value':value,'unit':unit,'at':iso(now),'observation_date':iso(now)[:10],'source':'OFFLINE FIXTURE','change_bps':-2 if unit=='%' else None,'change':-.2} for key,label,value,unit in [('DGS2','US 2Y',4.82,'%'),('DGS10','US 10Y',5.19,'%'),('DFII10','US Real 10Y',2.84,'%'),('DTWEXBGS','Fed Broad Dollar Index (nicht DXY)',121.6023,'Index')]]
 data['events']=[{'id':str(i),'title':title,'at':iso(now+timedelta(hours=hours)) if hours is not None else None,'scheduled_date':iso(now)[:10],'country':'US','source':'OFFLINE FIXTURE','impact':impact,'actual':None,'forecast':None,'previous':None,'url':'https://example.org'} for i,(title,hours,impact) in enumerate([('CPI TEST',1,'HIGH'),('EIA TEST',48,'MEDIUM'),('Auction time unpublished',None,'MEDIUM')])]
 data['news']=[{'title':'Iran sanctions & gold <script>unsafe</script>','source':'OFFLINE FIXTURE','url':'https://example.org','publishedAt':iso(now),'topics':['sanctions','gold/precious metals'],'relevance':'HIGH'}]
 data['marketContext']={'goldBias':'NEUTRAL','rates':'MIXED','usd':'STRONGER','oil':'FALLING','risk':'RISK-OFF','geopolitical':'ELEVATED','calendar24h':'HIGH','reasons':['Mixed signals: neutral.'],'warnings':[],'nextHigh':data['events'][0]}
 data['marketContexts']={key:{**data['marketContext'],'name':name,'bias':'NEUTRAL','explanation':name+' fixture explanation.','regimes':[['Rates','MIXED']]} for key,name in [('MGC','GOLD'),('MCL','OIL'),('MNQ','NASDAQ'),('MYM','DOW')]}
 for event in data['events']:
  if event['at'] is None:event['scheduled_date']=now.astimezone(ZoneInfo('Europe/Berlin')).date().isoformat()
 data['news'] += [{'id':str(i),'title':'Oil supply and Fed rates '+str(i),'source':'EIA' if i%2 else 'BBC Welt','url':'https://example.org/'+str(i),'publishedAt':iso(now-timedelta(minutes=i+1))} for i in range(20)]
 data['sync']={'calendarStatus':'OK','lastSyncAt':iso(now),'reports':[]}
 result['body']=json.dumps(data);return result
ui.bridge=fixture
checks=[]
def check(name,condition):
 assert condition,name
 checks.append(name)
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ['TRADING_TEST_CHROMIUM'],headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1366,'height':1024},timezone_id='Europe/Berlin');errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)));ui.mount(page)
 check('Broad USD ticker, not DXY ticker',page.locator('#tickers').inner_text().find('Broad USD Index')>=0)
 check('Rule based context visible','GOLD MACRO BIAS' in page.locator('#view').inner_text() and 'MIXED' in page.locator('#view').inner_text())
 for key,name in [('MCL','OIL'),('MNQ','NASDAQ'),('MYM','DOW'),('MGC','GOLD')]:
  page.locator('#chart-market').select_option(key);page.wait_for_timeout(200)
  check(name+' context switch',name+' MACRO BIAS' in page.locator('#view').inner_text() and 'NEWS RADAR · '+name in page.locator('#view').inner_text())
 check('15 headlines available',page.locator('.news-scroll .news-mini').count()==15)
 check('Radar scroll container',page.locator('.news-scroll').evaluate('(e)=>getComputedStyle(e).overflowY')=='auto')
 check('Multiple sources shown','EIA' in page.locator('.news-scroll').inner_text() and 'BBC' in page.locator('.news-scroll').inner_text())
 for width,height in [(1366,1024),(820,1180),(390,844)]:
  page.set_viewport_size({'width':width,'height':height});page.wait_for_timeout(200)
  check(str(width)+' context no page overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth+2'))
  page.screenshot(path=str(out/('context-'+str(width)+'.png')),full_page=True)
 page.locator('.tabs [data-view="news"]').click()
 for mode,expected,absent in [('7d','EIA TEST',None),('24h','CPI TEST','EIA TEST'),('high','CPI TEST','EIA TEST'),('today','Auction time unpublished','EIA TEST')]:
  page.locator('[data-action="calendar-filter"][data-id="'+mode+'"]').click()
  body=page.locator('#view').inner_text()
  check(mode+' calendar filter',expected in body and (absent is None or absent not in body))
 check('Unknown time labelled', 'Uhrzeit nicht veröffentlicht' in body)
 check('No fabricated consensus',page.locator('tbody tr').first.locator('td').nth(5).inner_text()=='—')
 check('Headline escaped',page.locator('#view script').count()==0 and '<script>unsafe</script>' in body)
 check('News no mobile page overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth+2'))
 page.screenshot(path=str(out/'context-calendar-mobile.png'),full_page=True)
 check('No JS errors',not errors);browser.close()
print(json.dumps({'passed':len(checks),'checks':checks}))
