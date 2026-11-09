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
| `gear.html` + `gear.js` + `gear.csv` | Gear guide with filters for type, skill level, price and brand. Add gear as rows in `gear.csv`. |
| `icons/`, `favicon.svg`, `site.webmanifest` | The app icon for browser tabs and phone home screens. |
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

## When the domain is bought

The share-preview tags (`og:url` and `og:image` in each page's `<head>`) use the full GitHub Pages address. Swap that address for the new domain so link previews keep working.

## Visitor stats

Visits are counted anonymously by GoatCounter (no cookies). Only the account owner can see them, at https://mtbsa.goatcounter.com/ after logging in. The counting script is the `gc.zgo.at/count.js` line at the bottom of each page.

## Running it

It's a plain static site with no build step. GitHub Pages hosts it for free: **Settings → Pages → Deploy from branch → `main` / root**.

To preview on your own computer, run `python3 -m http.server` in this folder and open http://localhost:8000.
