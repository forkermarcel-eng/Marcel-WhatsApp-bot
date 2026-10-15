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
requests=[]
refresh_count=0
timezone_example=False
def fixture(source,url,opts):
 global refresh_count
 requests.append(url)
 if opts.get('method','GET')!='GET':raise AssertionError('Context render test is read-only')
 result=original(source,url,opts)
 if 'resource=bootstrap' not in url and 'resource=news' not in url:return result
 data=json.loads(result['body'])
 if 'resource=bootstrap' in url:assert data.get('demo') and data.get('mode')=='MEMORY_TEST'
 else:refresh_count+=1
 if 'settings' in data:data['settings']['timezone']='America/New_York'
 data['observations']=[{'id':key,'label':label,'value':value,'unit':unit,'at':iso(now),'observation_date':iso(now)[:10],'source':'OFFLINE FIXTURE','change_bps':-2 if unit=='%' else None,'change':-.2} for key,label,value,unit in [('DGS2','US 2Y',4.82,'%'),('DGS10','US 10Y',5.19,'%'),('DFII10','US Real 10Y',2.84,'%'),('DTWEXBGS','Fed Broad Dollar Index (nicht DXY)',121.6023,'Index')]]
 data['events']=[{'id':str(i),'title':title,'at':iso(now+timedelta(hours=hours)) if hours is not None else None,'scheduled_date':iso(now)[:10],'country':'US','source':'OFFLINE FIXTURE','impact':impact,'actual':None,'forecast':None,'previous':None,'url':'https://example.org'} for i,(title,hours,impact) in enumerate([('CPI TEST',1,'HIGH'),('EIA TEST',48,'MEDIUM'),('Auction time unpublished',None,'MEDIUM')])]
 data['news']=[{'title':'Iran sanctions & gold <script>unsafe</script>','source':'OFFLINE FIXTURE','url':'https://example.org','publishedAt':iso(now),'topics':['sanctions','gold/precious metals'],'relevance':'HIGH'}]
 data['marketContext']={'goldBias':'NEUTRAL','rates':'MIXED','usd':'STRONGER','oil':'FALLING','risk':'RISK-OFF','geopolitical':'ELEVATED','calendar24h':'HIGH','reasons':['Mixed signals: neutral.'],'warnings':[],'nextHigh':data['events'][0]}
 data['marketContexts']={key:{**data['marketContext'],'name':name,'bias':'NEUTRAL','explanation':name+' fixture explanation.','regimes':[['Rates','MIXED']]} for key,name in [('MGC','GOLD'),('MCL','OIL'),('MNQ','NASDAQ'),('MYM','DOW')]}
 for event in data['events']:
  if event['at'] is None:event['scheduled_date']=now.astimezone(ZoneInfo('Europe/Berlin')).date().isoformat()
 data['news'] += [{'id':str(i),'title':'Oil supply and Fed rates '+str(i),'source':'EIA' if i%2 else 'BBC Welt','url':'https://example.org/'+str(i),'publishedAt':iso(now-timedelta(minutes=i+1))} for i in range(20)]
 if refresh_count:
  data['news'].append({'id':'fresh','title':'NEW OIL FEED ITEM','source':'EIA','url':'https://example.org/fresh','publishedAt':iso(now+timedelta(seconds=1))})
 if timezone_example:
  data['news']=[{'id':str(i),'title':'Oil timezone sample '+t,'source':'EIA','url':'https://example.org/berlin/'+str(i),'publishedAt':'2026-10-15T'+t+':00Z'} for i,t in enumerate(['02:55','01:30','01:00'])]
 data['sync']={'calendarStatus':'OK','lastSyncAt':iso(now),'reports':[]}
 result['body']=json.dumps(data);return result
ui.bridge=fixture
checks=[]
def check(name,condition):
 assert condition,name
 checks.append(name)
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ['TRADING_TEST_CHROMIUM'],headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1366,'height':1024},timezone_id='America/Los_Angeles');errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.evaluate('''() => {const timer=window.setInterval;window.setInterval=(fn,ms)=>{if(ms===60000)window.newsRefreshTest=fn;return timer(fn,ms);};}''')
 ui.mount(page)
 check('Broad USD ticker, not DXY ticker',page.locator('#tickers').inner_text().find('Broad USD Index')>=0)
 check('Rule based context visible','GOLD MACRO BIAS' in page.locator('#view').inner_text() and 'MIXED' in page.locator('#view').inner_text())
 for key in ['news','market','calendar']:
  check(key+' Berlin label', 'Zeiten: Berlin' in page.locator('[data-context-panel="'+key+'"]').inner_text())
 expected_news=now.astimezone(ZoneInfo('Europe/Berlin')).strftime('%d.%m., %H:%M')
 check('News Berlin despite LA browser and NY preference',expected_news in page.locator('.news-mini small').first.inner_text())
 expected_event=(now+timedelta(hours=1)).astimezone(ZoneInfo('Europe/Berlin')).strftime('%d.%m., %H:%M')
 check('Calendar Berlin despite LA browser and NY preference',expected_event in page.locator('[data-context-panel="calendar"]').inner_text())
 check('Market context event Berlin',expected_event in page.locator('[data-context-panel="market"]').inner_text())
 for key,name in [('MCL','OIL'),('MNQ','NASDAQ'),('MYM','DOW'),('MGC','GOLD')]:
  page.locator('#chart-market').select_option(key);page.wait_for_timeout(200)
  check(name+' context switch',name+' MACRO BIAS' in page.locator('#view').inner_text() and 'NEWS RADAR · '+name in page.locator('#view').inner_text())
 page.locator('#chart-market').select_option('MCL');page.wait_for_timeout(200)
 page.locator('[data-action="news-filter"][data-id="all"]').click();page.wait_for_timeout(200)
 page.evaluate('''() => {window.chartBeforeRefresh=document.querySelector('#chart-host canvas');document.querySelector('.news-scroll').scrollTop=150;}''')
 scroll=page.locator('.news-scroll').evaluate('(e)=>e.scrollTop');request_start=len(requests)
 page.evaluate('async()=>{await window.newsRefreshTest();}')
 check('60s refresh requests saved news only',requests[request_start:]==['/api/trading?resource=news'])
 check('Chart canvas survives refresh',page.evaluate("window.chartBeforeRefresh===document.querySelector('#chart-host canvas')"))
 check('Instrument retained',page.locator('#chart-market').input_value()=='MCL')
 check('News filter retained',page.locator('[data-action="news-filter"][data-id="all"]').get_attribute('class')=='selected')
 check('Radar scroll retained',abs(page.locator('.news-scroll').evaluate('(e)=>e.scrollTop')-scroll)<2)
 check('Newest item stays first',page.locator('.news-mini a').first.inner_text()=='NEW OIL FEED ITEM')
 check('No duplicate refreshed item',page.locator('.news-mini a').filter(has_text='NEW OIL FEED ITEM').count()==1)
 page.evaluate('async()=>{await window.newsRefreshTest();}')
 check('Repeated refresh no duplicates',page.locator('.news-mini a').filter(has_text='NEW OIL FEED ITEM').count()==1)
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
 timezone_example=True
 page.evaluate('async()=>{await window.newsRefreshTest();}')
 labels=page.locator('.news-mini small[title]').all_text_contents()
 check('OIL 04:55 03:30 03:00 Berlin screenshot case',all(t in labels[i] for i,t in enumerate(['15.10., 04:55','15.10., 03:30','15.10., 03:00'])))
 check('UTC original tooltip',page.locator('.news-mini small[title]').first.get_attribute('title')=='UTC: 2026-10-15T02:55:00.000Z')
 page.set_viewport_size({'width':1366,'height':1024});page.screenshot(path=str(out/'oil-berlin-timezone.png'),full_page=True)
 check('No JS errors',not errors);browser.close()
print(json.dumps({'passed':len(checks),'checks':checks}))
