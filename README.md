# MTBSA-Project

A small, scalable website that makes the South Australian mountain bike community easier to navigate online.

Phase 1 is a "mum friendly" race calendar: every SA MTB race in one place, a page per race in plain English, and a button out to the official entry page.

## What's in here

| File | What it is |
| --- | --- |
| `races.csv` | **All the races.** Open it in Excel or Google Sheets to add or change one. |
| `index.html` + `app.js` | The calendar page and the code that reads `races.csv`. |
| `new-to-racing.html` | Beginner guide: race types, licences, entering, what to bring. |
| `links.html` | Official SA sites, clubs and trail links. |
| `style.css` | How everything looks (works in light and dark mode, and on phones). |

## Adding a race

Add a row to `races.csv`. The columns are:

- `id`: a short unique name with no spaces, e.g. `ambc-r01-eagle-2027`
- `date` / `end_date`: in `YYYY-MM-DD` format. Leave `end_date` empty for one-day events
- `name`, `type`, `venue`, `region`, `organiser`, `organiser_url`
- `beginner_friendly`: `yes` or `no`
- `ages`, `cost`, `licence`: short plain-English answers
- `summary`: one to three sentences in your own words (don't copy the organiser's text)
- `entry_url`: the official entry page

Past races hide themselves automatically, but stay in the file so people can see how the season usually runs.

## Running it

It's a plain static site with no build step. GitHub Pages hosts it for free: **Settings → Pages → Deploy from branch → `main` / root**.

To preview on your own computer, run `python3 -m http.server` in this folder and open http://localhost:8000.
