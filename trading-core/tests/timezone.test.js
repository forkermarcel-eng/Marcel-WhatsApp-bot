import test from 'node:test';
import assert from 'node:assert/strict';
import {berlinTime,newsTime,newsTimestamp,sortedNews,calendarTime,calendarTimestamp,compareCalendar,sourceDateLabel} from '../../Trading/news-context.js';
import {parsePublishedTime,parseRSS} from '../server/providers.js';
import {eastern,parseICS} from '../server/official-context.js';
import {syncSources} from '../server/context-sync.js';
import {FileRepository} from '../server/repository.js';

test('UTC to Berlin uses real summer/winter rules and 24-hour clock',()=>{
 assert.equal(berlinTime('2026-01-15T08:00:00Z'),'15.01., 09:00');
 assert.equal(berlinTime('2026-10-15T08:00:00Z'),'15.10., 10:00');
 assert.equal(berlinTime('2026-10-15T08:00:00Z','full'),'15.10.2026, 10:00');
 assert.equal(berlinTime('2026-10-15T21:05:00Z','clock'),'23:05');
 assert.equal(berlinTime('2026-10-15T22:00:00Z','clock'),'00:00');
});
test('Berlin date crosses midnight without changing the UTC source value',()=>{
 const value='2026-12-31T23:42:00Z';assert.equal(berlinTime(value),'01.01., 00:42');assert.equal(value,'2026-12-31T23:42:00Z');
});
test('New York CPI 08:30 converts through UTC, including mismatched DST weeks',()=>{
 for(const [day,utc,display] of [
  ['2026-01-15','13:30','15.01., 14:30'],['2026-07-15','12:30','15.07., 14:30'],
  ['2026-03-06','13:30','06.03., 14:30'],['2026-03-09','12:30','09.03., 13:30'],
  ['2026-03-30','12:30','30.03., 14:30'],['2026-10-23','12:30','23.10., 14:30'],
  ['2026-10-26','12:30','26.10., 13:30'],['2026-11-02','13:30','02.11., 14:30']
 ]){const at=eastern(day,'8:30 AM');assert.equal(at,day+'T'+utc+':00.000Z');assert.equal(calendarTime({at}),display);}
});
test('Actual ICS parser keeps UTC instant and displays Berlin in the DST gap',async()=>{
 const input='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:cpi-test\r\nDTSTART;TZID=America/New_York:20261026T083000\r\nSUMMARY:Consumer Price Index\r\nEND:VEVENT\r\nEND:VCALENDAR';
 const [row]=await parseICS(input,'BLS','2026-10-15T00:00:00Z');
 assert.equal(row.scheduled_at_utc,'2026-10-26T12:30:00.000Z');assert.equal(calendarTime(row),'26.10., 13:30');
 await assert.rejects(()=>parseICS(input.replace('America/New_York','Unknown/Zone'),'BLS','2026-10-15T00:00:00Z'),/Zeitzone/);
});
test('RSS/Atom explicit ISO/RFC822 offsets and standard Eastern tokens normalize to UTC',()=>{
 for(const value of ['2026-10-15T08:00:00Z','2026-10-15T10:00:00+02:00','Thu, 15 Oct 2026 10:00:00 +0200','Thu, 15 Oct 2026 04:00:00 EDT','Thu, 15 Oct 2026 08:00:00 GMT','Thu, 15 Oct 2026 08:00:00 UTC'])assert.equal(parsePublishedTime(value),'2026-10-15T08:00:00.000Z',value);
 assert.equal(parsePublishedTime('Thu, 15 Jan 2026 03:00:00 EST'),'2026-01-15T08:00:00.000Z');
});
test('Missing/unknown source timezone and invalid dates stay unknown; seen time is labelled',()=>{
 for(const value of ['2026-10-15T08:00:00','Thu, 15 Oct 2026 08:00:00','Thu, 15 Oct 2026 08:00:00 XYZ','2026-02-30T08:00:00Z','2026-10-15T08:00:00+99:00','bad','']){
  assert.equal(parsePublishedTime(value),null,value);
  const [row]=parseRSS('<rss><item><title>Oil</title><link>https://example.org/oil</link><pubDate>'+value+'</pubDate></item></rss>',{name:'Fixture'},'2026-10-15T09:42:00Z');
  assert.equal(row.publishedAt,null);assert.equal(row.observedAt,'2026-10-15T09:42:00Z');assert.equal(newsTime(row),'Erfasst 15.10., 11:42');
 }
 assert.equal(newsTime({publishedAt:'invalid',seen_at:'2026-10-15T09:42:00Z'}),'Erfasst 15.10., 11:42');
 assert.equal(berlinTime('2026-10-15T08:00:00'),'Zeit unbekannt');
});
test('News order remains UTC-based even when repeated Berlin DST hour reverses wall-clock order',()=>{
 const rows=[{id:'early',url:'https://example.org/a',publishedAt:'2026-10-25T00:55:00Z'},{id:'later',url:'https://example.org/b',publishedAt:'2026-10-25T01:05:00Z'}];
 assert.equal(newsTime(rows[0]),'25.10., 02:55');assert.equal(newsTime(rows[1]),'25.10., 02:05');
 assert.deepEqual(sortedNews(rows).map(n=>n.id),['later','early']);assert.ok(newsTimestamp(rows[1])>newsTimestamp(rows[0]));
});
test('Calendar sorting uses instants, not ISO lexical order or Berlin strings',()=>{
 const a={id:'a',at:'2026-10-15T10:00:00+02:00'},b={id:'b',at:'2026-10-15T08:30:00Z'};
 assert.deepEqual([b,a].sort(compareCalendar).map(x=>x.id),['a','b']);assert.equal(calendarTime(a),'15.10., 10:00');
 assert.equal(calendarTimestamp({scheduled_at_utc:'2026-10-15T08:00:00Z'}),Date.parse('2026-10-15T08:00:00Z'));
});
test('Date-only observations/events retain source date without invented midnight',()=>{
 assert.equal(sourceDateLabel('2026-10-15'),'15.10.2026');assert.equal(sourceDateLabel('2026-02-30'),'Datum unbekannt');
 assert.equal(calendarTime({scheduled_date:'2026-10-15'}),'15.10.2026 · Uhrzeit nicht veröffentlicht');
 assert.equal(calendarTimestamp({scheduled_date:'2026-10-15'}),null);
});
test('Screenshot example: OIL 04:55 / 03:30 / 03:00 are explicitly Berlin',()=>{
 assert.deepEqual(['02:55','01:30','01:00'].map(t=>newsTime({publishedAt:'2026-10-15T'+t+':00Z'})),['15.10., 04:55','15.10., 03:30','15.10., 03:00']);
});
test('Trading Economics documented UTC Date remains a source-specific exception, not a generic guess',async()=>{
 const repo=new FileRepository();await syncSources(repo,{TRADING_ECONOMIC_CALENDAR_KEY:'fixture-only'},{feeds:[],parseRSS,read:async url=>{
  if(!String(url).includes('tradingeconomics.com'))throw Error('fixture offline');
  return JSON.stringify([{CalendarId:1,Date:'2026-10-16T08:30:00',Event:'CPI',Importance:3}]);
 }},'2026-10-15T00:00:00Z');
 const [event]=await repo.list('events');assert.equal(event.at,'2026-10-16T08:30:00.000Z');assert.equal(calendarTime(event),'16.10., 10:30');
});
