# Finance information center — 2026-10-19

## Implemented scope

Standalone finance workspace only: title/earth banner, compact market grid, calendar, source-linked rule-based important headlines and four compact specialist-news cards. No general news filters, headline slider, candlestick chart, strategy or execution controls. The general news workspace is unchanged. Refresh reads stored data every 60 seconds while visible; closing the finance view disposes its timer. Failed refresh preserves displayed timestamps.

The authenticated existing world route gains GET `op=finance`. Existing world scheduling invokes the finance cache update alongside world synchronization; failures remain independent and logged. Only the existing `marcel_world.cache` record `finance-headlines:v1` is written. No new tables, migrations, accounts or paid services. Trading events, observations and candles are read only.

## Sources and rights

- finanzen.net news and analysis: https://www.finanzen.net/rss/news and https://www.finanzen.net/rss/analysen. Publisher permission: https://www.finanzen.net/dienste/rss — linked headlines only. Both returned HTTP 403 in the actual local verification. Retried on the existing schedule; last valid headlines may be retained with cache/error labels.
- FinanzNachrichten.de economy and market reports: https://www.finanznachrichten.de/rss-nachrichten-wirtschaft-konjunktur and https://www.finanznachrichten.de/rss-marktberichte. Official index and permission: https://www.finanznachrichten.de/service/rss.htm — linked headlines, at most once per ten minutes. Both worked and supplied 25 deduplicated German headlines. No article text or images are stored or republished. The compact cards use original neutral typography, not unlicensed article photographs.
- Handelsblatt: https://www.handelsblatt.com/rss-feeds/ requires express permission for commercial reuse. Not activated. WirtschaftsWoche, Financial Times and Investing.com are not activated without an established redistribution entitlement; no scraping bypass.
- ECB RSS availability verified at https://www.ecb.europa.eu/home/html/rss.en.html. Existing ECB/Fed context synchronization is retained. No extra ECB calendar is invented and no press release publication date is treated as an upcoming policy event.

News cache cadence: ten minutes, conditional HTTP validators, bounded requests, per-source failures and Retry-After support. Headline retention: 72 hours, pruned on refresh and filtered on read. No requests occur on an individual card click.

## Calendar

Existing official Trading calendar collection: BLS, BEA, Federal Reserve/FOMC, Census, EIA and Treasury Auctions; active-source IDs and deduplication are respected. BLS/BEA ICS, FOMC and Census endpoints were actually fetched and parsed. The stored calendar supplied four upcoming US events at verification time.

Eurostat's own page https://ec.europa.eu/eurostat/news/euro-indicators/release-calendar advertises `/eurostat/o/calendars/eventsJson`. Its public JSON endpoint was verified with ISO start/end and Europe/Luxembourg timezone parameters. This adds five relevant upcoming EU events, cached for 30 minutes through the existing scheduler. Stable record IDs replace moved/cancelled schedules on the next successful refresh. Source failures preserve prior data and original timestamps. Commission-owned data reuse: https://commission.europa.eu/legal-notice_en (CC BY 4.0 unless otherwise stated). Eurostat attribution is displayed, and translations are indicated with original titles available in details.

Dates without confirmed time remain `Zeit offen` even if the JSON happens to contain an internal timestamp. All timed events use Europe/Berlin formatting including DST. Example verified: 12:30 UTC → 14:30 Berlin on 20 October 2026. Forecast/previous/actual values are shown only if supplied; absent fields explicitly say `Nicht geliefert`. Past scheduled time is not proof of actual release. Importance retains documented upstream rules; Eurostat uses a transparent rule (GDP/inflation/unemployment high; other Euro indicators medium).

FRED API key was not present in the existing service configuration; no account or key was created. Existing Treasury and H.10 official observations already cover selected rates/dollar indicators.

## Markets and actual data

Existing Massive configuration names were verified without exposing values. Read-only production snapshot: 117 calendar records, seven official observations and 4000 recent candle rows. The dashboard selects eight indicators: US 10Y, US 2Y, US real 10Y, Fed Broad Dollar Index (explicitly not DXY), plus Nasdaq, Dow, WTI and gold micro futures. Last verified official observation date: 16 October 2026; Massive historical candles: 13 October 2026. Futures are labelled as contracts, not cash indices, with historical/stale flags and source/basis details. Changes are absolute changes between stored samples; yields use percentage points. No DAX, Brent or EUR/USD quote is fabricated. Daily observations show their actual date precision, not an invented midnight publication time. Sparklines use only stored time series.

## Newsletter preparation

Free finanzen.net newsletters are documented at https://www.finanzen.net/newsletter and https://hilfe.finanzen.net/hc/de/articles/6322458099100-News-Newsletter. Subscription, an owned mailbox and reuse permission are required before ingestion. No mailbox, registration or IMAP connection was created. A future authorized IMAP adapter can normalize permitted messages to the finance channel fields `id,title,url,source,publishedAt,rights`; credentials must remain server-side and newsletter storage must honor its own retention/license conditions. RSS and official calendars work independently.

## Validation and safeguards

Four finance tests, 13 world tests, 13 night-build tests and seven UI tests passed. Browser verification used actual stored production market/calendar data plus freshly fetched financial RSS and Eurostat data; no synthetic financial values. At 1440px the dashboard measured 1274px, at 390px its market panel measured 344px; neither overflowed horizontally. Verified all five sections, absent former filters, historical labels, original-article links, expandable missing-value details, refresh and independent failure fallback. Screenshots: local `tmp/weather-verification/finance-desktop.png` and `finance-mobile.png`.

Before release a fresh private full PostgreSQL custom dump was created without modifying production, saved as `%TEMP%/marcel-production-finance-20261019.dump` (18,481,058 bytes at creation); `pg_restore --list` verified 662 archive lines. This is an archive validation, not a new full restore test. No personal content or credentials was printed. No database schema change is required. An authenticated production browser was unavailable, so local screenshots are not claimed as production visual acceptance.
