# MTBSA-Project

A small, scalable website that makes the South Australian mountain bike community easier to navigate online.

Phase 1 is a "mum friendly" race calendar: every SA MTB race in one place, a page per race in plain English, and a button out to the official entry page.

## What's in here

| File | What it is |
| --- | --- |
| `races.csv` | **All the races.** Open it in Excel or Google Sheets to add or change one. |
| `index.html` + `home.js` | Home page: hero, the next three races, quick links and About. |
| `calendar.html` + `app.js` | The month calendar and race pages, built from `races.csv`. |
| `nav.js` | Opens the menu on phones. The header and footer are the same on every page, so change them on all pages together. |
| `og-image.png` | The picture that shows when the site is shared in Facebook, Messenger or a group chat. |
| `new-to-racing.html` | Beginner guide: race types, licences, entering, what to bring. |
| `links.html` | Official SA sites, clubs and trail links. |
| `where-to-ride.html` | SA trail parks in plain English, with directions. |
| `race-day-checklist.html` + `race-day-checklist.pdf` | The packing checklist. If you change the list, ask Claude to remake the PDF too. |
| `gear.html` + `gear.js` + `gear.csv` | Gear guide with filters for type, skill level, price and brand. Add gear as rows in `gear.csv`. |
| `icons/`, `favicon.svg`, `site.webmanifest` | The app icon for browser tabs and phone home screens. |
| `weather.js` | Race-day weather and fire danger on race pages and the race lists. Free, no keys. See below. |
| `functions/api/fire-danger.js` | A tiny free Cloudflare helper that backs up the fire danger feed if the browser can't reach the CFS directly. |
| `analytics.js` | Visitor stats with PostHog (no cookies). Feeds the private stats dashboard. The PostHog project token goes at the top. |
| `style.css` | How everything looks (works in light and dark mode, and on phones). |

## Adding a race

Add a row to `races.csv`. The columns are:

- `id`: a short unique name with no spaces, e.g. `ambc-r01-eagle-2027`
- `date` / `end_date`: in `YYYY-MM-DD` format. Leave `end_date` empty for one-day events
- `name`, `venue`, `region`, `organiser`, `organiser_url`
- `level`: `Beginner`, `Club`, `School`, `State` or `National` (sets the colour on the calendar)
- `type`: e.g. Cross-country, Downhill, Enduro, Marathon
- `ages`, `cost`, `licence`: short plain-English answers
- `summary`: one to three sentences in your own words (don't copy the organiser's text)
- `entry_url`: the official entry page

Races show on a month calendar, coloured by level. Past races stay in the file and show as finished, so people can see how the season usually runs.

## Race-day weather and fire danger

Each upcoming race page shows the weather forecast (about two weeks out) and the CFS fire danger rating and total fire ban status for its fire ban district (about four days out). Races in the next two weeks also get a small weather chip in the lists, plus a red chip if there's a fire ban or extreme fire danger.

- Weather comes from [Open-Meteo](https://open-meteo.com/), which is free with no account.
- Fire danger and fire bans come from the SA CFS, which gets them from the Bureau of Meteorology.
- The site works out where a race is from its venue name (the `VENUES` list in `weather.js`), or from its region if the venue isn't known. If you add a new venue, add a line there. Or add `lat`, `lon` and `fire_district` columns to `races.csv` to pin a race exactly.

## Adding gear

Add a row to `gear.csv`. The columns are:

- `id`: a short unique name with no spaces
- `name`, `brand`
- `section`: `Rider gear`, `Bike parts` or `Bikes` (sets which tab it shows under)
- `category`: e.g. Helmets, Tyres, Brakes, Bikes (sets the drawing and the Type filter)
- `skill`: `Beginner`, `Intermediate` or `Racer`
- `price_aud` (and `rrp_aud` if it's on sale), `shop`, `shop_url`, `checked` (date you checked the price)
- `what_it_is`, `good_for`, `watch_out`: short plain-English notes
- `our_take`: a one or two sentence verdict, shown at the top of the pop-up
- `tested`: put `yes` once you've actually ridden or used it. It adds a "Tested by us" badge.

If you ever use affiliate links, say so clearly on the page.

## Web address and search

The site's home is **https://mtbsa.com.au**. Every page's `<head>` already points there:

- `<link rel="canonical">` tells Google the one true address for each page.
- `og:url` and `og:image` make link previews in Facebook, Messenger and group chats show the picture and title. (Until the domain is live, the picture won't show in previews.)
- `robots.txt` and `sitemap.xml` tell search engines which pages to read. **If you add a new page, add it to `sitemap.xml` too.**
- The calendar adds upcoming races in Google's event format, so they can show as events in search.
- `404.html` is the "page not found" page.
- `_headers` keeps the temporary `pages.dev` address out of Google and adds some basic safety settings. Only Cloudflare reads it.

mountainbikingsa.com.au and mountainbikingsouthaustralia.com.au redirect to mtbsa.com.au. Those redirects are set in Cloudflare, not in this repo.

## Visitor stats

Visits are counted anonymously by GoatCounter (no cookies). Only the account owner can see them, at https://mtbsa.goatcounter.com/ after logging in. The counting script is the `gc.zgo.at/count.js` line at the bottom of each page.

## Daily site check

Every morning at 9 AM Adelaide time a free GitHub Action (`.github/workflows/daily-site-check.yml`) checks the club race calendars and AusCycling against `races.csv`, gear prices against the shops in `gear.csv`, and every link on the site.

- **Fixed automatically** (saved straight to `main`): race dates the organiser changed, links that moved for good, and exact prices from Shopify shops (99 Bikes, The Odd Spoke).
- **Waits for you** in the **Site check** tab on the private stats dashboard: new races (check the details, then Add), races that look cancelled (Remove or Dismiss), and broken links (paste a new link, or Dismiss).

The results live on the `site-check-data` branch, which Cloudflare skips. To run a check now: **Actions → Daily site check → Run workflow**.

## Running it

It's a plain static site with no build step. **Cloudflare Pages** hosts it for free and republishes it within a minute of any change to `main`. In Cloudflare the build settings are: framework **None**, build command **empty**, build output directory **`/`**.

To preview on your own computer, run `python3 -m http.server` in this folder and open http://localhost:8000.
