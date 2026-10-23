import {load} from 'cheerio';
import {parseOfficialCalendar, calendarEvent} from '../../brain-world/finance-sources.js';
import {requireValue} from '../instruments.js';
import {canonicalURL, parseEventTime} from './events.js';

function bounded(raw, allowHTML = false) {
  requireValue(typeof raw === 'string' && Buffer.byteLength(raw) <= 2000000, 'Source payload exceeds limit.');
  requireValue(!/<!ENTITY/i.test(raw) && (allowHTML || !/<!DOCTYPE/i.test(raw)), 'XML declarations with entities are not accepted.');
}
export async function parseSource(raw, source, {series = null, fetchedAt} = {}) {
  bounded(raw, ['calendar-fed', 'calendar-ecb'].includes(source.format));
  if (source.format === 'rss') {
    const $ = load(raw, {xmlMode: true});
    requireValue($('rss,feed,rdf\\:RDF').length > 0, 'Invalid RSS/Atom document.');
    requireValue($('item,entry').length <= 250, 'Too many news entries.');
    return $('item,entry').toArray().map(el => {
      const entry = $(el);
      const titleDoc = load(entry.find('title').first().text()); titleDoc('script,style').remove();
      const title = titleDoc.text().replace(/\s+/g, ' ').trim();
      let link = entry.find('link[rel="alternate"]').attr('href') || entry.find('link').first().attr('href') || entry.find('link').first().text();
      if (source.id === 'boj' && link.startsWith('http://www.boj.or.jp/')) link = link.replace('http:', 'https:');
      const url = canonicalURL(link);
      requireValue(url && new URL(url).hostname.replace(/^www\./, '') === new URL(source.url).hostname.replace(/^www\./, ''), 'Article link leaves official source.');
      return {kind: 'news', externalId: entry.find('guid,id').first().text() || url, title, url,
        publishedAt: entry.find('pubDate,published,dc\\:date').first().text() || null,
        updatedAt: entry.find('updated').first().text() || null};
    });
  }
  if (source.format.startsWith('calendar-')) {
    const feed = {id: source.id, name: source.name, country: source.country, zone: source.country === 'EU' ? 'Europe/Berlin' : 'America/New_York', format: source.format.slice(9), url: source.url};
    const events = await parseOfficialCalendar(raw, feed, fetchedAt);
    requireValue(events.length <= 250, 'Too many calendar events.');
    // The existing helper converts DATE through a zone. Preserve raw civil dates
    // here instead, without changing the protected Finance calendar component.
    const allDay = new Map();
    if (feed.format === 'ics') {
      const unfolded = raw.replace(/\r?\n[ \t]/g, '');
      for (const match of unfolded.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)) {
        const uid = match[1].match(/^UID:(.+)\r?$/m)?.[1]?.trim();
        const date = match[1].match(/^DTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})\r?$/m);
        if (!date) continue;
        requireValue(uid && !uid.includes('\\'), 'All-day event needs an unambiguous UID.');
        const civil = `${date[1]}-${date[2]}-${date[3]}`; parseEventTime(civil);
        const id = calendarEvent(feed, '', civil, null, fetchedAt, uid).id;
        requireValue(!allDay.has(id) || allDay.get(id) === civil, 'Conflicting all-day calendar dates.');
        allDay.set(id, civil);
      }
    }
    return events.map(e => ({kind: 'calendar', externalId: e.id, title: e.title, url: e.url,
      scheduledAt: allDay.get(e.id) ?? e.at ?? e.scheduled_date, timezone: feed.zone, country: e.country, publishedAt: null}));
  }
  let body; try { body = JSON.parse(raw); } catch { throw Error('Invalid structured source payload.'); }
  if (source.format === 'structured') {
    requireValue(Array.isArray(body.records) && body.records.length <= 250, 'Expected bounded normalized records.');
    return body.records;
  }
  requireValue(series && typeof series.id === 'string' && series.unit && series.title, 'Explicit series mapping is required.');
  const base = {kind: 'macro', title: series.title, seriesId: series.id, unit: series.unit,
    type: series.type, country: series.country ?? source.country, currency: series.currency ?? null, url: series.sourceURL ?? source.url};
  if (source.format === 'fred-json') {
    requireValue(Array.isArray(body.observations) && body.observations.length <= 250 &&
      Number(body.offset ?? 0) === 0 && Number(body.count ?? body.observations.length) === body.observations.length, 'Incomplete or invalid FRED observations.');
    return body.observations.map(x => ({...base, externalId: series.id + ':' + x.date, period: x.date,
      actual: x.value, publishedAt: null, updatedAt: x.realtime_start ?? null}));
  }
  if (source.format === 'bls-json') {
    requireValue(body.status === 'REQUEST_SUCCEEDED' && Array.isArray(body.Results?.series), 'BLS reports failure.');
    const matching = body.Results.series.filter(x => x.seriesID === series.id);
    requireValue(matching.length === 1 && Array.isArray(matching[0].data) && matching[0].data.length <= 250, 'BLS series missing or too large.');
    return matching[0].data.map(x => {
      requireValue(/^\d{4}$/.test(x.year) && /^M(?:0[1-9]|1[0-2])$/.test(x.period), 'Only explicit monthly BLS periods supported.');
      const period = x.year + '-' + x.period.slice(1);
      return {...base, externalId: series.id + ':' + period, period, actual: x.value, publishedAt: null};
    });
  }
  throw Error('Source format not implemented.');
}
