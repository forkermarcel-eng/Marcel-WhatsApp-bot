import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {preflight} from '../preflight.js';

test('read-only preflight marks missing production configuration without network access',async()=>{
 const r=await preflight({env:{},production:true});assert.equal(r.mode,'READ_ONLY');assert.equal(r.ready,false);assert.ok(r.checks.some(x=>x.name==='Datenbank-Zugang'&&x.status==='FAIL'));
});
test('preflight separates secrets and does not disclose them',async()=>{
 const secret='same-token-but-long-enough-1234567890';const r=await preflight({env:{TRADING_ENABLED:'true',DATABASE_URL:'hidden',TRADING_API_SECRET:secret,TRADING_INGEST_TOKEN:secret},production:true});assert.equal(r.ready,false);assert.ok(!JSON.stringify(r).includes(secret));
});
test('execution form preserves timestamp precision and label is a real manual fill',async()=>{
 const text=await readFile(new URL('../../Trading/trading.js',import.meta.url),'utf8');assert.match(text,/seconds\?23:16/);assert.match(text,/Ausführungszeit \(Geräte-Ortszeit\).*?step="0\.001"/);assert.match(text,/MANUAL|Tatsächliche/);
});
