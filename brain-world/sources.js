// Official publisher feeds. Country is publisher coverage, never an event location.
export const sources=[
 ['tagesschau','tagesschau','https://www.tagesschau.de/infoservices/alle-meldungen-100~rss2.xml','DE','de','Welt'],
 ['dlf','Deutschlandfunk','https://www.deutschlandfunk.de/nachrichten-100.rss','DE','de','Welt'],
 ['heise','heise','https://www.heise.de/rss/heise-atom.xml','DE','de','Technologie'],
 ['golem','Golem','https://rss.golem.de/rss.php?feed=RSS2.0','DE','de','Technologie'],
 ['apollo','Apollo News','https://apollo-news.net/feed/','DE','de','Politik'],
 ['nius','NIUS','https://nius.de/rss','DE','de','Politik'],
 ['dw','Deutsche Welle','https://rss.dw.com/rdf/rss-de-all','DE','de','Welt'],
 ['bbc','BBC World','https://feeds.bbci.co.uk/news/world/rss.xml','GB','en','Welt'],
 ['guardian','The Guardian','https://www.theguardian.com/world/rss','GB','en','Welt'],
 ['npr','NPR','https://feeds.npr.org/1001/rss.xml','US','en','Welt'],
 ['cbc','CBC','https://www.cbc.ca/webfeed/rss/rss-topstories','CA','en','Welt'],
 ['france24','France 24','https://www.france24.com/en/rss','FR','en','Welt'],
 ['aljazeera','Al Jazeera','https://www.aljazeera.com/xml/rss/all.xml','QA','en','Welt'],
 ['africanews','Africanews','https://www.africanews.com/feed/rss','CG','en','Welt'],
 ['nation','Nation Kenya','https://nation.africa/kenya/rss.xml','KE','en','Welt'],
 ['standard','The Standard Kenya','https://www.standardmedia.co.ke/rss/headlines.php','KE','en','Welt'],
 ['dailymaverick','Daily Maverick','https://www.dailymaverick.co.za/dmrss/','ZA','en','Welt'],
 ['cna','CNA','https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml','SG','en','Welt'],
 ['japantimes','The Japan Times','https://www.japantimes.co.jp/feed/','JP','en','Welt'],
 ['abc','ABC Australia','https://www.abc.net.au/news/feed/51120/rss.xml','AU','en','Welt'],
 ['rnz','Radio New Zealand','https://www.rnz.co.nz/rss/national.xml','NZ','en','Welt'],
 ['elpais','El País América','https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/america/portada','ES','es','Welt'],
 ['elcolombiano','El Colombiano','https://www.elcolombiano.com/rss/portada.xml','CO','es','Welt'],
 ['eltiempo','El Tiempo','https://www.eltiempo.com/rss/mundo.xml','CO','es','Welt'],
 ['moscowtimes','The Moscow Times','https://www.themoscowtimes.com/rss/news','NL','en','Welt'],
 ['bbc-health','BBC Gesundheit','https://feeds.bbci.co.uk/news/health/rss.xml','GB','en','Gesundheit'],
 ['bbc-science','BBC Wissenschaft','https://feeds.bbci.co.uk/news/science_and_environment/rss.xml','GB','en','Wissenschaft'],
 ['bbc-business','BBC Wirtschaft','https://feeds.bbci.co.uk/news/business/rss.xml','GB','en','Wirtschaft'],
 ['bbc-sport','BBC Sport','https://feeds.bbci.co.uk/sport/rss.xml','GB','en','Sport'],
 ['guardian-culture','Guardian Kultur','https://www.theguardian.com/culture/rss','GB','en','Kultur'],
 ['guardian-food','Guardian Essen','https://www.theguardian.com/food/rss','GB','en','Ernährung'],
 ['guardian-travel','Guardian Reisen','https://www.theguardian.com/travel/rss','GB','en','Reisen'],
 ['guardian-life','Guardian Lifestyle','https://www.theguardian.com/lifeandstyle/rss','GB','en','Lifestyle']
 ,['usgs','U.S. Geological Survey','https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.atom','US','en','Naturereignisse']
].map(([id,name,url,country,language,category])=>({id,name,url,country,language,category}));
// Endpoints below were checked against the publisher and parsed before activation.
sources.push(...[
 ['zdf','ZDFheute','https://www.zdfheute.de/rss/zdf/nachrichten','Welt'],
 ['welt','WELT','https://www.welt.de/feeds/latest.rss','Welt'],
 ['spiegel','DER SPIEGEL','https://www.spiegel.de/schlagzeilen/index.rss','Welt'],
 ['zeit','ZEIT ONLINE','https://newsfeed.zeit.de/index','Welt'],
 ['ntv','ntv','https://www.n-tv.de/rss','Welt'],
 ['br24','BR24','https://nachrichtenfeeds.br.de/rdf/boards/QXAPkQJ','Welt'],
 ['rbb24','rbb24','https://www.rbb24.de/panorama/index.xml/feed=rss.xml','Welt'],
 ['mdr','MDR','https://www.mdr.de/nachrichten/index~rss2.xml','Welt'],
 ['swr','SWR Aktuell','https://www.swr.de/~rss/swraktuell/index.xml','Welt'],
 ['t3n','t3n','https://t3n.de/rss.xml','Technologie'],
 ['computerbase','ComputerBase','https://www.computerbase.de/rss/news.xml','Technologie'],
 ['scinexx','scinexx','https://www.scinexx.de/feed/','Wissenschaft'],
 ['aerzteblatt','Deutsches Ärzteblatt','https://www.aerzteblatt.de/rss/news','Gesundheit']
].map(([id,name,url,category])=>({id,name,url,category,country:'DE',language:'de',...(id==='br24'?{coverage:{regions:['Bayern']}}:{}),...(id==='rbb24'?{coverage:{regions:['Berlin','Brandenburg']},bookmarkPolicy:'link-only'}:{}),...(id==='mdr'?{coverage:{regions:['Sachsen','Sachsen-Anhalt','Thüringen']}}:{}),...(id==='swr'?{coverage:{regions:['Baden-Württemberg','Rheinland-Pfalz']}}:{})})));
sources.push(...[
 ['bild','BILD','https://www.bild.de/feed/alles.xml','Welt'],
 ['ndr','NDR','https://www.ndr.de/index~rss2.xml','Welt'],
 ['ndr-ns','NDR Niedersachsen','https://www.ndr.de/nachrichten/niedersachsen/index~rss2.xml','Welt'],
 ['sportschau','Sportschau','https://www.sportschau.de/index~rss2.xml','Sport'],
 ['gala','GALA','https://www.gala.de/feed/standard-rss/','Unterhaltung'],
 ['brigitte','BRIGITTE','https://www.brigitte.de/feed.rss','Lifestyle'],
 ['essen','ESSEN & TRINKEN','https://www.essen-und-trinken.de/feed/rss/','Ernährung'],
 ['tagesschau-inland','tagesschau Inland','https://www.tagesschau.de/inland/index~rss2.xml','Politik']
].map(([id,name,url,category])=>({id,name,url,category,country:'DE',language:'de',...(id.startsWith('ndr')?{bookmarkPolicy:'link-only'}:{}),...(id==='ndr-ns'?{coverage:{regions:['Niedersachsen']}}:{}),...(id==='tagesschau-inland'?{coverage:{eventCountry:'DE'}}:{})})));
export const sourceChecks=[
 {name:'FOCUS online',reason:'Beim Prüflauf HTTP 403; nicht aktiviert.'},
 {name:'WDR',reason:'Geprüfte Nachrichtenadressen liefern HTTP 404; nicht aktiviert.'},
 {name:'kicker',reason:'Beim Prüflauf HTTP 403; Sport wird über Sportschau und weitere aktive Quellen abgedeckt.'}
];
