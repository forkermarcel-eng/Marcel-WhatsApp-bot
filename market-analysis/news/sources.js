// Separate analysis descriptors. Existing source registries/workers stay intact.
const rows = [
  ['fed', 'Federal Reserve', 'US', 'rss', 'https://www.federalreserve.gov/feeds/press_all.xml'],
  ['ecb', 'EZB', 'EU', 'rss', 'https://www.ecb.europa.eu/rss/press.html'],
  ['boj', 'Bank of Japan', 'JP', 'rss', 'https://www.boj.or.jp/en/rss/whatsnew.xml'],
  ['eia', 'EIA', 'US', 'rss', 'https://www.eia.gov/rss/todayinenergy.xml'],
  ['bls-calendar', 'BLS', 'US', 'calendar-ics', 'https://www.bls.gov/schedule/news_release/bls.ics'],
  ['bea-calendar', 'BEA', 'US', 'calendar-ics', 'https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics'],
  ['fed-calendar', 'Federal Reserve', 'US', 'calendar-fed', 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'],
  ['ecb-calendar', 'EZB', 'EU', 'calendar-ecb', 'https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html'],
  ['fred', 'FRED', 'US', 'fred-json', 'https://api.stlouisfed.org/fred/series/observations'],
  ['bls', 'BLS', 'US', 'bls-json', 'https://api.bls.gov/publicAPI/v2/timeseries/data/'],
  ['bea', 'BEA', 'US', 'structured', 'https://apps.bea.gov/api/data'],
  ['eurostat', 'Eurostat', 'EU', 'structured', 'https://ec.europa.eu/eurostat/'],
  ['treasury', 'US Treasury', 'US', 'structured', 'https://home.treasury.gov/treasury-daily-interest-rate-xml-feed'],
];
export function analysisSource(id) {
  const row = rows.find(x => x[0] === id);
  if (!row) throw Error('Unknown analysis source.');
  const [sourceId, name, country, format, url] = row;
  return {id: sourceId, name, country, format, url,
    networkImplemented: format === 'rss' || format.startsWith('calendar-'),
    active: false, rights: 'NOT_CONFIRMED', consensusProvided: false};
}
export const sourceIds = Object.freeze(rows.map(x => x[0]));
