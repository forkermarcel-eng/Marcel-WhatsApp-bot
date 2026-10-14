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

Railway inventory: one running cooperative-kindness backend; no context worker.
The existing workers/context.js now exports its timer and remains CLI-compatible.
registerTradingRoutes starts it when the existing TRADING_ENABLED and
TRADING_NEWS_ENABLED are true. Default 10 minutes, bounded 5–10 minutes.
First backend tick after the interval permits the controlled initial sync.
Manual/API and scheduled sync share one in-flight promise per repository.

Source cadence persists in existing settings.contextSourceCache: news 10 minutes,
GDELT 1 hour, calendars 6 hours, Treasury daily, H.10 release cadence.
ETag/Last-Modified/304; exponential outage/429 backoff including Retry-After.
No full response bodies persisted. No new queue, schema, service or credentials.
Logs expose source status/timestamps/counts only. Old data survives outages.

## Context interpretation

Four independently derived contexts; no AI. Gold: real yields/USD/safe haven;
Nasdaq: real yields/risk/tech export risk; Dow: rates/risk/energy/trade risk;
Oil: USD/risk/supply-disruption/OPEC headlines. Mixed or insufficient signals
stay NEUTRAL. Headline-derived risks are explicitly claims, not verified facts.
No inventory or industrial-activity measurements are invented. Macro readings
are daily observations and futures are last observed UTC daily closes, not live.
Calendar remains complete; per-instrument relevance is a projection.
