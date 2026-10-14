from playwright.sync_api import sync_playwright
from ui_render_helpers import mount,root
import json,urllib.request,sys,os,shutil
from pathlib import Path
out=Path(os.environ.get('TRADING_TEST_OUTPUT',str(root/'trading-core'/'evidence')));out.mkdir(parents=True,exist_ok=True)
initial=json.loads(urllib.request.urlopen('http://127.0.0.1:3090/api/trading?resource=bootstrap').read())
if not initial.get('demo') or initial.get('mode')!='MEMORY_TEST':raise SystemExit('UI-Test schreibt ausschließlich in einen ausdrücklich gestarteten, flüchtigen --demo-Server.')
checks=[];errors=[]
def check(name,fn):
 try:fn();checks.append({'check':name,'status':'PASS'})
 except Exception as e:checks.append({'check':name,'status':'FAIL','detail':str(e)});raise
with sync_playwright() as p:
 b=p.chromium.launch(executable_path=os.environ.get('TRADING_TEST_CHROMIUM') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
 c=b.new_context(viewport={'width':1366,'height':1024},device_scale_factor=1,timezone_id='Europe/Berlin',has_touch=True)
 page=c.new_page();page.on('pageerror',lambda e:errors.append(str(e)));mount(page)
 check('Initial canvas render and explicit synthetic banner',lambda: page.get_by_text('DEMO · SYNTHETISCHE DATEN.').wait_for())
 page.screenshot(path=str(out/'ipad-cockpit-demo.png'),full_page=True)
 for v in ['charts','plans','journal','analytics','news','playbook','settings','overview']:
  page.locator('.tabs [data-view="'+v+'"]').click();page.wait_for_timeout(180)
  check('Tab '+v,lambda: page.locator('#view').wait_for())
 page.locator('#create-plan').click();page.wait_for_timeout(80)
 for name,value in {'entry':'4388','stop':'4383','target':'4408','zoneLow':'4387','zoneHigh':'4389','quantity':'5','costPerContract':'1.2','reason':'UI Test: alter Demand, Limit vor dem Retest.','invalidation':'Unter dem Struktur-Tief.','overrideReason':'Testet Kosten und bestätigte Ausführung.'}.items():
  page.locator('[name="'+name+'"]').fill(value)
 page.locator('#modal [type="submit"]').click();page.wait_for_timeout(500)
 check('Plan save closes modal',lambda: (__import__('builtins').exec('assert not page.locator("#modal").evaluate("e=>e.open")',{'page':page})))
 state=json.loads(urllib.request.urlopen('http://127.0.0.1:3090/api/trading?resource=bootstrap').read())
 plan=next(x for x in state['plans'] if x['reason'].startswith('UI Test:'))
 check('Immutable decision snapshot persisted',lambda: (__import__('builtins').exec('assert any(s["planId"]==pid for s in state["snapshots"])',{'state':state,'pid':plan['id']})))
 page.locator('[data-action="detail"][data-id="'+plan['id']+'"]').first.click();page.wait_for_timeout(50)
 page.locator('[data-action="execution-entry"]').click();page.wait_for_timeout(50)
 print('execution modal',page.locator('#modal-body').inner_text()[:700])
 page.screenshot(path=str(out/'ipad-execution-form.png'),full_page=False)
 for field,value in {'price':'4388','quantity':'5','fee':'2'}.items():page.locator('#modal [name="'+field+'"]').fill(value)
 # Use the exact form default, including a fill in the plan's second.
 page.locator('#modal input[type="checkbox"]').check();page.locator('#modal [type="submit"]').click();page.wait_for_timeout(400)
 if page.locator('#modal').evaluate('e=>e.open'):print('SAVE DEBUG',page.locator('#modal').inner_text(),page.locator('#toast').inner_text())
 check('Manual actual entry saved',lambda: (__import__('builtins').exec('assert not page.locator("#modal").evaluate("e=>e.open")',{'page':page})))
 page.locator('.tabs [data-view="charts"]').click();page.wait_for_timeout(350)
 page.locator('[data-action="chart-zone"]').click();canvas=page.locator('#chart-host canvas');canvas.click(position={'x':110,'y':180});canvas.click(position={'x':220,'y':230});page.wait_for_timeout(500)
 check('Touch zone persists',lambda: page.get_by_text('Zeichnung gespeichert.',exact=True).wait_for())
 page.locator('#replay').fill('45');page.locator('#replay').dispatch_event('input');page.wait_for_timeout(100)
 check('Replay is labelled',lambda: page.locator('#chart-note').filter(has_text='REPLAY').wait_for())
 page.locator('.tabs [data-view="overview"]').click();page.wait_for_timeout(250)
 for width,height,name in [(1180,820,'ipad-landscape'),(1024,768,'ipad-1024'),(820,1180,'ipad-portrait'),(390,844,'phone')]:
  page.set_viewport_size({'width':width,'height':height});page.wait_for_timeout(150)
  layout=page.evaluate('()=>({width:innerWidth,doc:document.documentElement.scrollWidth})')
  check(name+' no document overflow',lambda l=layout: (__import__('builtins').exec('assert l["doc"]<=l["width"]+2',{'l':l})))
  page.screenshot(path=str(out/(name+'-demo.png')),full_page=True)
 check('No JS runtime errors',lambda: (__import__('builtins').exec('assert not errors',{'errors':errors})))
 b.close()
result={'method':'Offline Chromium rendering of the real modules (IIFE test bundling); network calls bridged only to the real localhost HTTP API. Not a native ES-module loader, Safari/device or hosted E2E certification.','checks':checks,'pageErrors':errors}
(out/'ui-tests.json').write_text(json.dumps(result,indent=2,ensure_ascii=False),encoding='utf-8');print(json.dumps(result,indent=2,ensure_ascii=False))
