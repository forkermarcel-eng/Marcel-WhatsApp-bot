import unittest, tempfile, importlib.util, pathlib, json
from types import SimpleNamespace
p=pathlib.Path(__file__).resolve().parents[1]/'workers'/'databento_feed.py'
spec=importlib.util.spec_from_file_location('feed',p);feed=importlib.util.module_from_spec(spec);spec.loader.exec_module(feed)
class FeedTests(unittest.TestCase):
 def test_exact_symbols(self):
  self.assertEqual(feed.validate_symbols('MGCZ6,MNQZ6,MYMZ6'),['MGCZ6','MNQZ6','MYMZ6'])
  for s in ['GC1!','MGC','XAUUSD','MGCZ6,https://evil']:
   with self.assertRaises(ValueError):feed.validate_symbols(s)
 def test_fixed_prices(self):
  r=SimpleNamespace(ts_event=1789689600000000000,open=4400100000000,high=4401200000000,low=4398900000000,close=4400300000000,volume=45)
  b=feed.to_bar(r,'MGCZ6');self.assertEqual(b['bars'][0]['open'],4400.1);self.assertEqual(b['resolution'],60);self.assertEqual(b['instrument'],'MGC');self.assertTrue(b['bars'][0]['time'].endswith('Z'))
 def test_durable_dedup_outbox(self):
  with tempfile.TemporaryDirectory() as d:
   path=str(pathlib.Path(d)/'test.sqlite');box=feed.Outbox(path);key=box.push({'a':1});box.push({'a':1});self.assertEqual(box.count(),1);box.close();box=feed.Outbox(path);self.assertEqual(box.peek()[0],key);box.ack(key);self.assertEqual(box.count(),0);box.close()
 def test_post_headers_not_execution(self):
  got=[]
  class R:
   def __enter__(self):return self
   def __exit__(self,*a):pass
   def read(self,n):return b'{"ok":true}'
  def fake(req,timeout):got.append(req);return R()
  feed.post_payload('https://own.example/trading-api?resource=ingest','test-token','test-id','{"bars":[]}',fake)
  self.assertEqual(got[0].get_header('Authorization'),'Bearer test-token');self.assertEqual(got[0].get_method(),'POST')
if __name__=='__main__':unittest.main()
