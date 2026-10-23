import {DateTime} from 'luxon';
import {requireValue,utcMillis} from './instruments.js';

// Explicit dated source calendar, not a guessed NYSE/24x5/holiday calendar.
function instant(date,time,zone,offsetMinutes) {
  requireValue(/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') && /^\d{2}:\d{2}$/.test(time ?? ''),'Invalid session civil time.');
  const wall = date+'T'+time;
  const parsed = DateTime.fromISO(wall,{zone});
  requireValue(parsed.isValid && parsed.toFormat("yyyy-MM-dd'T'HH:mm") === wall,'Invalid or nonexistent session time.');
  const possible = parsed.getPossibleOffsets();
  const matches = offsetMinutes === undefined ? possible : possible.filter(x=>x.offset === offsetMinutes);
  requireValue(matches.length === 1,'Ambiguous session time needs an explicit offset.');
  return matches[0].toUTC().toISO();
}
export function normalizeAnalysisCalendar({from,to,zone,reference,days,intervalMs} = {}) {
  const start = utcMillis(from),end = utcMillis(to);
  requireValue(start<end && end-start<=370*86400000 && typeof reference === 'string' && reference.trim(),'Explicit calendar coverage/reference required.');
  requireValue(DateTime.now().setZone(zone).isValid && typeof zone === 'string','Invalid session timezone.');
  requireValue(Number.isInteger(intervalMs) && intervalMs>=60000 && intervalMs<=86400000,'Invalid calendar interval.');
  requireValue(Array.isArray(days) && days.length<=400,'Calendar capacity exceeded.');
  const windows = [],dates = new Set();
  for(const day of days) {
    requireValue(!dates.has(day.date),'Duplicate calendar date.');dates.add(day.date);
    requireValue(/^\d{4}-\d{2}-\d{2}$/.test(day.date ?? '') && DateTime.fromISO(day.date).isValid,'Invalid calendar date.');
    if(day.closed === true) continue;
    requireValue(day.closed === false,'Each calendar date must explicitly state open/closed.');
    const open = instant(day.date,day.open,zone,day.openOffsetMinutes);
    const close = instant(day.closeDate ?? day.date,day.close,zone,day.closeOffsetMinutes);
    const a = utcMillis(open),b = utcMillis(close);
    requireValue(a<b && b-a<=48*3600000 && a%intervalMs===0 && b%intervalMs===0,'Invalid/alignment of session window.');
    windows.push({id:day.date,start:open,end:close});
  }
  // Coverage must enumerate every touched local date, including weekends/holidays.
  let day = DateTime.fromMillis(start,{zone}).startOf('day');
  const last = DateTime.fromMillis(end-1,{zone}).startOf('day');
  while(day<=last) {requireValue(dates.has(day.toISODate()),'Session calendar has an unclassified date.');day=day.plus({days:1});}
  windows.sort((a,b)=>utcMillis(a.start)-utcMillis(b.start));
  requireValue(windows.every((w,i)=>!i || utcMillis(windows[i-1].end)<=utcMillis(w.start)),'Session windows overlap.');
  return {from,to,zone,reference,windows};
}
