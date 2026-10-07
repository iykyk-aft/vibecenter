# Denver prospector

Find Denver small businesses with sub-par websites, rank them by how much a rebuild/modernization would help, and draft personalized outreach. Nothing is ever sent automatically.

```
discover ──► audit ──► deep ──► score ──► report ──► draft
 OSM list    HTTP/HTML  browser   rank     CSV+HTML   emails
 + yours     signals    + shots                       (you send)
                 ▲
        web-search enrichment (out/enrichment.json)
```

## Quick start

```bash
cd prospector
npm install                       # playwright-core only; uses an installed Chromium
export CHROMIUM_PATH=/path/to/chrome   # skip if PLAYWRIGHT_BROWSERS_PATH is set or `npx playwright install chromium` was run

node src/cli.mjs discover         # every named shop/office/restaurant/clinic/etc. in Denver, minus chains
node src/cli.mjs audit            # fast check of every site (hundreds in minutes)
node src/cli.mjs deep --top 150   # real-browser mobile + desktop screenshots of the worst-scoring sites
node src/cli.mjs report           # out/prospects.csv + out/report.html
cp sender.example.json out/sender.json   # fill in, then:
node src/cli.mjs draft            # out/drafts/*.md + out/drafts.csv
```

Everything is written to `out/` (gitignored: it holds scraped contact data, and this repo auto-commits on session stop).
Open `out/report.html` for the ranked, filterable list with screenshots.

## Needs open outbound network

`discover` calls OpenStreetMap's Overpass API and `audit`/`deep` fetch every business's website. Run it on your own machine, or in a cloud session whose environment has **Network access: Full**. The default restricted policy returns 403 for arbitrary hosts.

## What "sub-par" means

Each issue adds points (capped at 100); see `RULES` in `src/score.mjs`. Highlights:

| Signal | Source |
|---|---|
| No website / only Facebook, Yelp, etc. / site down / parked | OSM tags + fetch |
| No HTTPS or bad certificate | fetch |
| No viewport tag, page zoomed out or scrolling sideways on a phone, tiny text/tap targets | real Chromium (iPhone 13 emulation) |
| Slow load, heavy page, broken images, console errors | real Chromium |
| Stale © year, Flash, frames, `<font>`/`<center>`, table layout, old jQuery/WordPress, GoDaddy/Weebly builder | HTML |
| No click-to-call / form / booking, missing title, meta description, H1, social tags | HTML |
| Google PageSpeed score (optional: set `PSI_API_KEY`) | PageSpeed Insights |

`rank` = score + small bonuses for having an email/phone/hours and for higher-ticket categories. Tiers: **hot** ≥ 55, **warm** ≥ 30, **cold** otherwise.

## Adding businesses found elsewhere

```bash
# CSV columns: name,website,address,phone,email,category
node src/cli.mjs discover --manual my-list.csv            # OSM + your list
node src/cli.mjs discover --manual my-list.csv --no-osm   # only your list
```

## Web-search enrichment

OSM has no review counts and misses many sites. `node src/cli.mjs queue` writes `out/enrich-queue.json` (top prospects with no email, or "no/dead site" cases worth verifying). Research each by web search and record what you find in `out/enrichment.json`:

```json
{ "node-123456": { "website": "https://found-it.example", "email": "owner@x.example", "contactName": "Maria", "stillOpen": true, "notes": "" } }
```

`website` turns a "no website" lead into an audit target (re-run `audit`), `stillOpen: false` removes a business, and `email` / `contactName` flow into the drafts.

## Outreach notes

Drafts cite specific, checkable findings and carry an opt-out line and your physical address (CAN-SPAM requires both for commercial email, even B2B). Keep subjects honest, honor "no thanks" replies, and review each draft before sending. This is not legal advice.

## Politeness

One homepage (plus one contact page when no email is found) per site, one visit per host, 12 requests in flight overall. The Overpass query is a single request with mirror fallback.

## Tests

```bash
npm test    # unit tests + fixture-site audits + real-Chromium checks (skips browser tests if no Chromium)
```
