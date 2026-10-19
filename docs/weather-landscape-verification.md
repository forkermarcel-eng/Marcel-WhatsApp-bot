# Weather landscape release — 2026-10-19

Scope: standalone weather workspace only. No backend, API, database, scheduler or other workspace changes.

## Photographs

Twelve local weather/day-night photographs, each in desktop (1600×1000) and mobile (720×960) WebP variants; approximately 3.3 MB total for all 24 files. Only the selected responsive image is requested. All are Wikimedia Commons photographs with individual CC BY, CC BY-SA, CC0 or public-domain metadata. Full author, source, license and modification notices are in `Brain/assets/weather/LICENSES.md` and `credits.json`; the active credit and license are also displayed in the weather footer. These illustrate weather, not the selected city's terrain.

## Solar state

`Brain/weather-solar.js` implements NOAA's general solar equations (https://gml.noaa.gov/grad/solcalc/solareqns.PDF). Latitude, longitude and the forecast's valid UTC timestamp determine elevation, sunrise and sunset. Apparent sunrise threshold: −0.833°; civil twilight extends to −6°. Polar day/night and the date line are handled. UI clock and solar times are formatted in the weather response's IANA timezone, including DST. When coordinates are missing, the MET symbol suffix is the explicit fallback. Twilight uses the night photograph with a warm transition treatment.

## Local browser evidence

An isolated Chrome browser rendered the production weather component and styles with actual MET Norway snapshots fetched on 2026-10-19. No production database was used. Phoenix (clear/day), Medellín (rain/day), Berlin (clear/night), Singapore (cloud/night) and a genuine later daytime cloudy forecast sample were verified. Snow was explicitly isolated test data, marked in its screenshot; no live snow claim is made.

At 1440×900, the current card measured 1248 CSS pixels wide; all five day cards ended at y≈837 and were visible without scrolling. At 390×844 the card remained 326 pixels wide, used the mobile image, and had no document horizontal overflow. Image `object-fit` was `cover`; image decoding succeeded. Real geocoding search, globe-place reset, hourly expansion, touch swiping and reduced motion passed. No browser JavaScript errors occurred.

Screenshots in local `tmp/weather-verification/`: `sun-photo.png`, `rain-photo.png`, `night-photo.png`, `mobile-photo.png`, plus cloud and isolated snow cases. `photo-results.json` records dimensions and selected image paths. Video capture was attempted; Playwright's matching FFmpeg download timed out, so no successful recording is claimed.

Five pure presentation/solar tests, 13 night-build tests and seven web-UI regression tests passed. Missing daily condition symbols remain explicitly unavailable; actual min/max values are retained. No third-party image lookup is performed on a place change.

No authenticated production browser was available; local evidence is not production visual acceptance. Deployment status is checked separately after release.
