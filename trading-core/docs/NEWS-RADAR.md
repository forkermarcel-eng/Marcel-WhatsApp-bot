# News Radar / Instrument Context

## Canonical time and relevance

Server and browser share Trading/news-context.js. Sort descending by the first
valid timezone-explicit published_at / publishedAt, then seen_at / seenAt,
fetched_at / fetchedAt / observedAt; stable ID tie-break. PostgreSQL applies the
same timestamp precedence BEFORE LIMIT (no DDL). Invalid timestamps never crash
the query. No created_at insertion ordering for news.

Relevance is a transparent instrument / macro / geopolitical / authority /
recency score. It filters, never reorders. Radar offers Relevant, All, Macro,
Geopolitics, up to 15 scrollable headlines. Berlin display, UTC comparison.
Missing publication times are labelled “Erfasst”; date-only index labels remain
metadata, not fabricated precise publication times.

All News/Calendar/Market Context clocks use IANA Europe/Berlin, de-DE and a
24-hour clock, independent of browser/server zone and journal/chart preferences.
Panels say “Zeiten: Berlin”; headline tooltips expose the original UTC instant.
Sorting uses UTC instants, never formatted German clock strings. Date-only
observations/events remain dates (German format), not fabricated midnight times.
RSS/Atom requires explicit ISO offsets or valid RFC822/2822 zones; missing or
unknown zones and invalid dates leave publishedAt null and use labelled seen time.
The existing official US calendar parsers retain America/New_York conversions,
including weeks when US and European DST differ. Trading Economics is a
source-specific documented UTC exception even without a suffix:
https://docs.tradingeconomics.com/economic_calendar/schema/ (Date field).
No timezone assumption is inferred from the reader host or publisher name.

Same URL is deduplicated. Same publisher/day normalized headlines collapse
punctuation and Breaking/Update prefixes. Different publishers and meaningful
wording differences remain. No historical DB rows are deleted.

## Official sources checked 2026-10-15

Existing Fed, ECB, BBC World/Business, EIA Today in Energy and BoJ remain.
Added:

- EIA Press: https://www.eia.gov/tools/rssfeeds/ → press_rss.xml; relative links.
- DOE: https://www.energy.gov/listings/energy-news → /rss/energygov/2193718.
- UN News Peace/Security:
  https://news.un.org/feed/subscribe/en/news/topic/peace-and-security/feed/rss.xml
- IEA: https://www.iea.org/news (structured listing titles/links/date labels only).
- Treasury OFAC: https://ofac.treasury.gov/recent-actions (listing only).
- GDELT DOC ArtList: optional discovery, not publication timestamp authority.
  https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/

Direct OPEC press index, NATO official RSS, State RSS returned 403; not integrated
and no bypass attempted. No unverified Reuters/AP feed or full article scraping.
GDELT returned 429 in live read-only verification; existing news is retained.

## Existing worker, no new service

Railway inventory: one cooperative-kindness backend; no separate worker service.
The existing workers/context.js now exports its timer and remains CLI-compatible.
registerTradingRoutes starts it when the existing TRADING_ENABLED and
TRADING_NEWS_ENABLED are true. Its fixed 60-second tick checks source deadlines;
it is not a 60-second download interval. First backend tick is after one minute.
Manual/API and scheduled sync share one in-flight promise per repository.

Source cadence persists in existing settings.contextSourceCache: official news
120 seconds, normal RSS 240 seconds, GDELT 1 hour, calendars 30 minutes,
Treasury daily, H.10 release cadence. At most four concurrent requests, including
multi-URL calendars; completed news sources commit before the slowest source ends.
ETag/Last-Modified/304; exponential outage/429 backoff including Retry-After.
Healthy news feeds allow five seconds of timer jitter at their deadline;
failure backoff and slower source deadlines are never shortened.
Source state includes last_checked_at, last_success_at, last_new_item_at,
last_http_status, etag, last_modified, consecutive_failures, next_allowed_poll_at.
HTTP 304 does not parse or write product rows; only source-state settings update.
Entirely cached ticks do not write anything. Repeated identical HTTP 200 news
does not rewrite unchanged headlines or advance last_new_item_at.
No full response bodies persisted. No new queue, schema, service or credentials.
Logs expose source status/timestamps/counts/duration only. Old data survives outages.

The visible frontend reads saved GET resource=news every 60 seconds; it does not
trigger source fetches or reload bootstrap/chart/journal. Only context panels are
replaced, preserving instrument, news/calendar filters and scroll. Modal editing
and hidden tabs defer refresh. Publication order remains independent of relevance.

## Context interpretation

Four independently derived contexts; no AI. Gold: real yields/USD/safe haven;
Nasdaq: real yields/risk/tech export risk; Dow: rates/risk/energy/trade risk;
Oil: USD/risk/supply-disruption/OPEC headlines. Mixed or insufficient signals
stay NEUTRAL. Headline-derived risks are explicitly claims, not verified facts.
No inventory or industrial-activity measurements are invented. Macro readings
are daily observations and futures are last observed UTC daily closes, not live.
Calendar remains complete; per-instrument relevance is a projection.
