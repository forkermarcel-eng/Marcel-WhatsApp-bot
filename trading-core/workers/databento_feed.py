#!/usr/bin/env python3
"""Independent Databento OHLCV feed -> PRIVATE Marcel Trading ingestion.

No broker connectivity, no order functions. A durable SQLite outbox retries
application outages. Set exact raw contract symbols; no silent rolling.
The SDK and exchange entitlement are installed/provided by the operator.
"""
from __future__ import annotations
import os, json, time, sqlite3, hashlib, logging, threading, signal
from decimal import Decimal
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from pathlib import Path

LOG = logging.getLogger('marcel.marketdata')
ROOTS = ('MGC','MNQ','MYM','MCL','MBT','NKD')
MONTHS = 'FGHJKMNQUVXZ'

def validate_symbols(value: str) -> list[str]:
    import re
    symbols = [s.strip().upper() for s in value.split(',') if s.strip()]
    if not symbols or len(symbols) > 8:
        raise ValueError('1–8 exakte Futures-Kontrakte konfigurieren.')
    for s in symbols:
        if not any(re.fullmatch(root+'['+MONTHS+'][0-9]{1,4}',s) for root in ROOTS):
            raise ValueError('Ungültiger exakter Micro-/Nikkei-Kontrakt: '+s)
    return list(dict.fromkeys(symbols))

def to_bar(record, symbol: str) -> dict:
    """Databento fixed-point prices 1e-9, event timestamp in UTC nanoseconds."""
    ts = int(record.ts_event)
    if ts <= 0: raise ValueError('Ungültiger Zeitstempel')
    stamp = datetime.fromtimestamp(ts//1_000_000_000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
    price = lambda v: float(Decimal(int(v))/Decimal(1_000_000_000))
    bar = dict(time=stamp,open=price(record.open),high=price(record.high),low=price(record.low),close=price(record.close),volume=int(record.volume))
    if not (bar['low']>0 and bar['high']>=max(bar['open'],bar['close']) and bar['low']<=min(bar['open'],bar['close']) and bar['volume']>=0):
        raise ValueError('Ungültige OHLCV-Preise')
    instrument = next((r for r in ROOTS if symbol.startswith(r)),None)
    if not instrument: raise ValueError('Unbekanntes Instrument')
    return dict(instrument=instrument,contract=symbol,resolution=60,bars=[bar])

class Outbox:
    def __init__(self,path: str):
        Path(path).parent.mkdir(parents=True,exist_ok=True)
        self.db=sqlite3.connect(path,check_same_thread=False)
        os.chmod(path,0o600)
        self.lock=threading.Lock()
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS queue(id TEXT PRIMARY KEY, payload TEXT NOT NULL, created REAL NOT NULL)')
        self.db.commit()
    def push(self,payload: dict):
        raw=json.dumps(payload,sort_keys=True,separators=(',',':'))
        key=hashlib.sha256(raw.encode()).hexdigest()
        with self.lock:
            self.db.execute('INSERT OR IGNORE INTO queue VALUES(?,?,?)',(key,raw,time.time()));self.db.commit()
        return key
    def peek(self):
        with self.lock: return self.db.execute('SELECT id,payload FROM queue ORDER BY created,id LIMIT 1').fetchone()
    def ack(self,key):
        with self.lock: self.db.execute('DELETE FROM queue WHERE id=?',(key,));self.db.commit()
    def count(self):
        with self.lock: return self.db.execute('SELECT count(*) FROM queue').fetchone()[0]
    def close(self): self.db.close()

class FatalFeedError(RuntimeError): pass

def post_payload(endpoint: str,token: str,key: str,payload: str,opener=urlopen):
    req=Request(endpoint,data=payload.encode(),method='POST',headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','X-Idempotency-Key':key})
    try:
        with opener(req,timeout=20) as response:
            result=json.loads(response.read(1_000_000))
            if not result.get('ok'): raise FatalFeedError('Ingestion wurde nicht bestätigt.')
    except HTTPError as e:
        if e.code in (400,401,403,404,405,413,415,422):
            raise FatalFeedError('Ingestion HTTP '+str(e.code)+': Konfiguration/Daten prüfen, Outbox bleibt erhalten.') from None
        raise

def main():
    logging.basicConfig(level=logging.INFO,format='%(asctime)s %(levelname)s %(message)s')
    env=os.environ; key=env.get('TRADING_DATABENTO_KEY'); token=env.get('TRADING_INGEST_TOKEN')
    endpoint=env.get('TRADING_INGEST_URL','')
    parsed=urlsplit(endpoint)
    if parsed.scheme!='https' or parsed.username or parsed.password or parsed.path!='/trading-api':
        raise SystemExit('TRADING_INGEST_URL muss https://EIGENES-BACKEND/trading-api?resource=ingest sein.')
    if parsed.query!='resource=ingest':raise SystemExit('URL-Query muss exakt resource=ingest sein.')
    if not key or not token:raise SystemExit('Databento-Schlüssel und separater Ingest-Token fehlen.')
    symbols=validate_symbols(env.get('TRADING_FEED_SYMBOLS',''))
    try: import databento as db
    except ImportError:raise SystemExit('pip install -r trading-core/workers/requirements.txt ausführen.')
    box=Outbox(env.get('TRADING_FEED_OUTBOX','./trading-data/market-outbox.sqlite'))
    stop=threading.Event(); fatal=[]; client=None
    def shutdown(*_):
        stop.set()
        if client:
            try:client.stop()
            except Exception:pass
    for name in (signal.SIGINT,signal.SIGTERM):signal.signal(name,shutdown)
    def deliver():
        delay=1
        while not stop.is_set():
            row=box.peek()
            if not row:stop.wait(1);continue
            try:post_payload(endpoint,token,*row);box.ack(row[0]);delay=1
            except FatalFeedError as e:fatal.append(str(e));LOG.error('%s',e);shutdown();break
            except (HTTPError,URLError,TimeoutError,OSError,ValueError):
                LOG.warning('Backend nicht erreichbar/temporärer Fehler. %d Kerzen bleiben in der Outbox.',box.count())
                stop.wait(delay);delay=min(delay*2,60)
    thread=threading.Thread(target=deliver,daemon=True);thread.start()
    mappings={};seen=time.monotonic()
    def on_record(record):
        nonlocal seen
        seen=time.monotonic(); name=type(record).__name__
        if name=='SymbolMappingMsg':
            incoming=str(getattr(record,'stype_in_symbol',''));outgoing=str(getattr(record,'stype_out_symbol',''))
            symbol=incoming if incoming in symbols else outgoing if outgoing in symbols else None
            if symbol:mappings[int(record.instrument_id)]=symbol
        elif name=='OHLCVMsg':
            symbol=mappings.get(int(record.instrument_id))
            if not symbol:raise FatalFeedError('OHLCV ohne aufgelösten Rohkontrakt; kein Raten des Symbols.')
            box.push(to_bar(record,symbol))
            if box.count()>50000:raise FatalFeedError('Outbox >50.000: Backend reparieren, bevor weitere Daten laufen.')
        elif name=='ErrorMsg':raise FatalFeedError('Databento meldet Fehler. SDK-/Entitlement-Konfiguration prüfen.')
    def on_error(exc):fatal.append(type(exc).__name__);LOG.error('Feed gestoppt: %s (keine Secrets geloggt)',type(exc).__name__);shutdown()
    try:
        client=db.Live(key=key,heartbeat_interval_s=30)
        client.subscribe(dataset='GLBX.MDP3',schema='ohlcv-1m',stype_in='raw_symbol',symbols=symbols)
        client.add_callback(on_record,on_error)
        client.start();LOG.info('Unabhängiger OHLCV-Feed gestartet: %s. Keine Brokerverbindung.',','.join(symbols))
        while not stop.wait(5):
            if time.monotonic()-seen>100:raise FatalFeedError('Keine Daten/Heartbeat seit 100 Sekunden; externer Prozessmonitor kann neu starten.')
    except Exception as e:
        LOG.error('Feed beendet: %s (Credentials nicht ausgegeben)',type(e).__name__);fatal.append(type(e).__name__)
    finally:
        shutdown();thread.join(timeout=25);LOG.info('Noch %d Einträge in dauerhafter Outbox.',box.count());box.close()
    if fatal:raise SystemExit(1)

if __name__=='__main__':main()
