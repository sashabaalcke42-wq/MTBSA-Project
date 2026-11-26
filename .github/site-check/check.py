"""Daily site check for mtbsa.com.au.

Looks at the race calendars, gear shops and links the site uses, and writes a
list of suggested changes to a JSON file. The private stats dashboard shows
that list with "Add" and "Dismiss" buttons. Nothing on the site changes until
a suggestion is added there.

Standard library only, so it needs nothing installed.

  python3 .github/site-check/check.py --dry-run            # print, write nothing
  python3 .github/site-check/check.py --out results.json --decisions decisions.json
"""

import argparse
import concurrent.futures
import csv
import datetime as dt
import hashlib
import html
import io
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
ADELAIDE = ZoneInfo("Australia/Adelaide")
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0 Safari/537.36 mtbsa-daily-site-check")

# Club calendars always watched, on top of any found in the site's files.
CALENDARS = {
    "ambc": "Adelaide Mountain Bike Club",
    "gesa": "Gravity Enduro SA",
    "insideline": "Inside Line MTB Club",
}
AUSCYCLING_SA = "https://auscycling.org.au/events?state=sa"
MTB_WORDS = re.compile(
    r"mtb|mountain|enduro|downhill|gravity|xco|xcc|xcm|cross-country|marathon|"
    r"dirt|trail|e-mtb|pump", re.I)
CANCELLED = re.compile(r"cancel|postpon", re.I)

# Hosts that aren't pages people click (fonts, analytics, schema markup).
# calendar.google.com is the "add to Google Calendar" button, built in alerts.js.
SKIP_HOSTS = {"fonts.googleapis.com", "fonts.gstatic.com", "schema.org",
              "www.w3.org", "gc.zgo.at", "calendar.google.com"}
SKIP_HOST_SUFFIXES = (".posthog.com", ".goatcounter.com")
# These always turn away automatic visitors, so their links can't be checked.
BLOCKS_ROBOTS = ("facebook.com", "instagram.com")
URL_RE = re.compile(r"https?://[^\s\"'<>()`,]+")
SCAN_GLOBS = ["*.html", "*.csv", "*.js"]


# ---------------------------------------------------------------- fetching

class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Lets fetch() follow redirects itself, so it knows if a page moved for good."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_opener = urllib.request.build_opener(_NoRedirects)


class Page:
    def __init__(self, status, url, final, text="", codes=()):
        self.status, self.url, self.final, self.text = status, url, final, text
        self.codes = list(codes)
        self.permanent = bool(codes) and all(c in (301, 308) for c in codes)


def fetch(url, timeout=25):
    """Returns a Page. status 0 means it didn't load at all."""
    codes, current = [], url
    for _ in range(8):
        req = urllib.request.Request(current, headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/json,*/*;q=0.8",
            "Accept-Language": "en-AU,en;q=0.9",
        })
        try:
            with _opener.open(req, timeout=timeout) as r:
                body = r.read(3_000_000).decode("utf-8", "replace")
                return Page(r.status, url, current, body, codes)
        except urllib.error.HTTPError as e:
            loc = e.headers.get("Location") if e.code in (301, 302, 303, 307, 308) else None
            if not loc:
                return Page(e.code, url, current, codes=codes)
            codes.append(e.code)
            current = urllib.parse.urljoin(current, loc)
        except Exception as e:  # DNS, timeout, TLS, reset
            return Page(0, url, current, f"{type(e).__name__}: {e}", codes)
    return Page(0, url, current, "Too many redirects", codes)


def fetch_retry(url):
    p = fetch(url)
    if p.status in (0, 500, 502, 503, 504):
        time.sleep(8)
        p = fetch(url)
    return p


# ---------------------------------------------------------------- site data

def read_csv(name):
    with open(ROOT / name, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def site_files():
    for g in SCAN_GLOBS:
        yield from sorted(ROOT.glob(g))


def site_text():
    return "\n".join(f.read_text(encoding="utf-8", errors="replace") for f in site_files())


def files_containing(s):
    return [f.name for f in site_files() if s in f.read_text(encoding="utf-8", errors="replace")]


def entryboss_id(url):
    m = re.search(r"entryboss\.cc/races/(\d+)", url or "")
    return m.group(1) if m else None


def parse_day(text):
    m = re.search(r"(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})", text)
    if not m:
        return None
    try:
        return dt.datetime.strptime(" ".join(m.groups()), "%d %b %Y").date()
    except ValueError:
        return None


def nice(d):
    return d.strftime("%a %-d %b %Y") if d else "?"


def to_date(s):
    try:
        return dt.date.fromisoformat((s or "").strip())
    except ValueError:
        return None


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60]


# ---------------------------------------------------------------- suggestions

class Findings:
    def __init__(self):
        self.items = []

    def add(self, kind, group, title, detail="", url="", change=None, key=None):
        # The id stays the same while the suggestion is the same, so a dismissed
        # one stays dismissed. If the details change (a race moves again), it's new.
        sid = kind + "-" + hashlib.sha1(
            json.dumps([kind, key or title, change], sort_keys=True).encode()
        ).hexdigest()[:12]
        if any(i["id"] == sid for i in self.items):
            return
        self.items.append({"id": sid, "kind": kind, "group": group, "title": title,
                           "detail": detail, "url": url, "change": change})


def guess_type(name, cal):
    n = name.lower()
    if re.search(r"xcm|marathon|\bhour\b", n):
        return "Marathon"
    if re.search(r"\bxc|short track|cross", n):
        return "Cross-country"
    if re.search(r"enduro|gesa", n) or cal == "gesa":
        return "Enduro"
    if re.search(r"\bdh\b|downhill|descent", n) or cal == "insideline":
        return "Downhill"
    return "See entry page"


def guess_level(name, cal):
    n = name.lower()
    if "national" in n:
        return "National"
    if "state" in n or "champs" in n or "championship" in n or cal == "gesa":
        return "State"
    if "first descent" in n or "junior" in n or "beginner" in n or "come and try" in n:
        return "Beginner"
    return "Club"


def new_race_row(races, name, day, venue, organiser, organiser_url, entry_url, level, rtype):
    region = ""
    for r in races:
        v = r.get("venue", "").split("(")[0].strip().lower()
        if v and v != "see entry page" and v in (venue or "").lower():
            region = r["region"]
            break
    base = slug(f"{name}-{day.year}") or f"race-{day.isoformat()}"
    ids = {r["id"] for r in races}
    rid, n = base, 2
    while rid in ids:
        rid, n = f"{base}-{n}", n + 1
    what = f"{rtype} race" if rtype != "See entry page" else "Race"
    return {
        "id": rid, "date": day.isoformat(), "end_date": "", "name": name,
        "level": level, "type": rtype, "venue": venue or "See entry page",
        "region": region or "South Australia", "organiser": organiser,
        "organiser_url": organiser_url, "ages": "All ages", "cost": "See entry page",
        "licence": "AusCycling membership",
        "summary": f"{what} run by {organiser}. Check the entry page for categories and times.",
        "entry_url": entry_url, "entries_open": "", "entries_close": "",
    }


ROW_RE = re.compile(
    r'fixture-date">\s*(.*?)\s*</div>.*?href="/races/(\d+)"[^>]*>(.*?)</a>'
    r'(?:\s*</div>\s*<div[^>]*fixture-course[^>]*>(.*?)</div>)?', re.S)


def check_calendars(races, text, today, out):
    by_id = {entryboss_id(r.get("entry_url")): r for r in races if entryboss_id(r.get("entry_url"))}
    cals = set(CALENDARS)
    cals.update(re.findall(r"https://entryboss\.cc/calendar/([a-z0-9_-]+)", text))
    for cal in sorted(cals):
        cal_url = f"https://entryboss.cc/calendar/{cal}"
        page = fetch_retry(cal_url)
        rows = ROW_RE.findall(page.text) if page.status == 200 else []
        if not rows:
            out.add("source", "sources", f"Couldn't read the {cal} race calendar today",
                    "If this shows up a few days in a row, the page may have changed and "
                    "the check needs a tweak.", cal_url, key=f"{cal}:{today}")
            continue
        org = CALENDARS.get(cal) or next(
            (r["organiser"] for r in races if r.get("organiser_url", "").rstrip("/") == cal_url), cal)
        for date_txt, rid, name, course in rows:
            day = parse_day(html.unescape(date_txt))
            name = html.unescape(re.sub(r"<[^>]+>", "", name)).strip()
            course = html.unescape(re.sub(r"<[^>]+>", "", course or "")).strip()
            url = f"https://entryboss.cc/races/{rid}"
            ours = by_id.get(rid)
            if ours:
                our_day = to_date(ours["date"])
                upcoming = bool((day and day >= today) or (our_day and our_day >= today))
                if day and our_day and day != our_day and upcoming:
                    change = {"op": "csv_set", "file": "races.csv", "key": "id", "value": ours["id"],
                              "expect": {"date": ours["date"]}, "set": {"date": day.isoformat()}}
                    end = to_date(ours.get("end_date"))
                    if end:
                        change["set"]["end_date"] = (end + (day - our_day)).isoformat()
                    out.add("race_date", "calendar", f"{ours['name']} has moved to {nice(day)}",
                            f"The site says {nice(our_day)}. The organiser's calendar now says {nice(day)}.",
                            url, change)
                if upcoming and CANCELLED.search(name) and not CANCELLED.search(ours["name"]):
                    out.add("race_cancelled", "calendar", f"{ours['name']} may be cancelled or postponed",
                            f"The organiser's calendar now calls it \"{name}\". Have a look: Remove takes "
                            "it off the site. If it's only postponed, Dismiss this and the new date "
                            "will show up here once the organiser sets one.", url,
                            {"op": "csv_delete", "file": "races.csv", "key": "id", "value": ours["id"]},
                            key=rid + name)
            elif day and day >= today and not CANCELLED.search(name):
                row = new_race_row(races, name, day, course, org, cal_url, url,
                                   guess_level(name, cal), guess_type(name, cal))
                out.add("race_new", "calendar", f"New race: {name} on {nice(day)}",
                        f"On the {org} calendar but not on the site yet. Check the details "
                        "before adding.", url,
                        {"op": "csv_append", "file": "races.csv", "row": row}, key=rid)


# "Entries open on Wednesday 9 December 2026" (AusCycling) or
# "Entries open  Tue, 24 Feb 2026 7:00 PM ACDT" (EntryBoss).
ENTRY_WORDS = {
    "entries_open": re.compile(r"\bEntries\s+(?:will\s+)?open(?:s)?(?:\s+on)?\b", re.I),
    "entries_close": re.compile(r"\bEntries\s+(?:will\s+)?close(?:s)?(?:\s+on)?\b", re.I),
}


def page_words(raw):
    body = re.sub(r"<script.*?</script>|<style.*?</style>", " ", raw, flags=re.S)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", body)))


def entry_dates(words):
    """Finds the entries open and close dates in a page's text. Missing ones are left out."""
    found = {}
    for col, rx in ENTRY_WORDS.items():
        for m in rx.finditer(words):
            # The date has to come straight after the words, not somewhere later on.
            after = re.sub(r"^[\s:,-]*(?:[A-Za-z]+day|Mon|Tue|Wed|Thu|Fri|Sat|Sun)?[\s,]*", "",
                           words[m.end():m.end() + 60])
            day = parse_day(after) if re.match(r"\d{1,2}\s+[A-Za-z]{3}", after) else None
            if day:
                found[col] = day
                break
    return found


def suggest_entry_dates(r, got, source, url, out):
    """Adds a suggestion when the organiser's entry dates differ from races.csv."""
    set_ = {c: d.isoformat() for c, d in got.items() if d.isoformat() != (r.get(c) or "")}
    if not set_ or "entries_open" not in r:
        return
    bits = []
    if "entries_open" in set_:
        bits.append(f"open {nice(got['entries_open'])}")
    if "entries_close" in set_:
        bits.append(f"close {nice(got['entries_close'])}")
    out.add("race_entries", "calendar", f"Entries for {r['name']} " + " and ".join(bits),
            f"From the {source} page.", url,
            {"op": "csv_set", "file": "races.csv", "key": "id", "value": r["id"],
             "expect": {c: r.get(c, "") for c in set_}, "set": set_})


def check_entryboss_entries(races, today, out):
    """Reads when entries open and close from each upcoming race's EntryBoss page."""
    todo = [r for r in races if entryboss_id(r.get("entry_url"))
            and to_date(r.get("end_date") or r["date"]) and to_date(r.get("end_date") or r["date"]) >= today]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        pages = list(pool.map(lambda r: (r, fetch_retry(r["entry_url"])), todo))
    for r, p in pages:
        if p.status == 200:
            suggest_entry_dates(r, entry_dates(page_words(p.text)), "EntryBoss", r["entry_url"], out)


AC_DATE = re.compile(
    r"\b([A-Z][a-z]{2}) (\d{1,2})(?:\s*[–-]\s*(?:([A-Z][a-z]{2}) )?(\d{1,2}))?, (\d{4})\b")


def auscycling_page(url):
    """Returns (title, start, end, entry_dates) from an AusCycling event page, or None."""
    p = fetch_retry(url)
    if p.status != 200:
        return None
    body = re.sub(r"<script.*?</script>|<style.*?</style>", " ", p.text, flags=re.S)
    title = re.search(r"<h1[^>]*>(.*?)</h1>", body, re.S)
    title = html.unescape(re.sub(r"<[^>]+>", "", title.group(1))).strip() if title else ""
    entries = entry_dates(page_words(body))
    m = AC_DATE.search(html.unescape(re.sub(r"<[^>]+>", " ", body)))
    if not m:
        return title, None, None, entries
    mon, d1, mon2, d2, yr = m.groups()
    try:
        start = dt.datetime.strptime(f"{mon} {d1} {yr}", "%b %d %Y").date()
        end = dt.datetime.strptime(f"{mon2 or mon} {d2} {yr}", "%b %d %Y").date() if d2 else None
    except ValueError:
        return title, None, None, entries
    return title, start, end, entries


def check_auscycling(races, text, today, out):
    for r in races:
        url = (r.get("entry_url") or "").strip()
        our_day = to_date(r["date"])
        if "auscycling.org.au/events/" not in url or not our_day or our_day < today:
            continue
        got = auscycling_page(url)
        if not got:
            continue  # the link check reports broken pages
        _, day, end, entries = got
        suggest_entry_dates(r, entries, "AusCycling", url, out)
        if day and day != our_day:
            change = {"op": "csv_set", "file": "races.csv", "key": "id", "value": r["id"],
                      "expect": {"date": r["date"]}, "set": {"date": day.isoformat()}}
            if end:
                change["set"]["end_date"] = end.isoformat()
            out.add("race_date", "calendar", f"{r['name']} has moved to {nice(day)}",
                    f"The site says {nice(our_day)}. AusCycling now says {nice(day)}.", url, change)

    page = fetch_retry(AUSCYCLING_SA)
    if page.status != 200:
        out.add("source", "sources", "Couldn't read the AusCycling SA events page today",
                "If this shows up a few days in a row, the page may have changed.",
                AUSCYCLING_SA, key=str(today))
        return
    slugs = sorted(set(re.findall(
        r'href="(?:https://auscycling\.org\.au)?/events/([a-z0-9-]+)"', page.text)))
    for s in slugs:
        url = f"https://auscycling.org.au/events/{s}"
        if not MTB_WORDS.search(s) or url in text:
            continue
        years = [int(y) for y in re.findall(r"20\d\d", s)]
        if years and max(years) < today.year:
            continue
        got = auscycling_page(url)
        title = (got and got[0]) or s.replace("-", " ").title()
        day = got[1] if got else None
        if day and day < today:
            continue
        level = "National" if "national" in s else "State"
        row = new_race_row(races, title, day or today, "See entry page", "AusCycling",
                           "https://auscycling.org.au/", url, level, guess_type(title, ""))
        if not day:
            row["date"] = ""  # couldn't read it: the dashboard asks for it
        elif got and got[2]:
            row["end_date"] = got[2].isoformat()
        for col, d in (got[3] if got else {}).items():
            row[col] = d.isoformat()
        change = {"op": "csv_append", "file": "races.csv", "row": row}
        out.add("race_new", "calendar",
                f"New on AusCycling SA: {title}" + (f" on {nice(day)}" if day else ""),
                "A mountain bike event on AusCycling's SA list that isn't on the site yet. "
                "It may not be a race, so have a look first.", url, change, key=s)


# ---------------------------------------------------------------- gear prices

def shop_price(url):
    """Returns (price, rrp, in_stock) or None if the shop's page can't tell us."""
    parts = urllib.parse.urlsplit(url)
    if "/products/" in parts.path:  # Shopify shops publish a small JSON file per product
        js = urllib.parse.urlunsplit(parts._replace(path=parts.path.rstrip("/") + ".js", query=""))
        p = fetch_retry(js)
        if p.status == 200:
            try:
                j = json.loads(p.text)
                price = j["price"] / 100
                cmp_ = (j.get("compare_at_price") or 0) / 100
                return price, (cmp_ if cmp_ > price else None), bool(j.get("available", True))
            except (ValueError, KeyError, TypeError):
                pass
    # Other shops' pages often list several prices (other sizes, related
    # products), so guessing from them gave wrong prices. Skip those.
    return None


def money(v):
    return f"${v:,.2f}".replace(".00", "")


def same_money(a, b):
    try:
        return abs(float(a) - float(b)) < 0.005
    except (TypeError, ValueError):
        return False


def check_gear(gear, today, out):
    rows = [g for g in gear if (g.get("shop_url") or "").startswith("http")]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda g: (g, shop_price(g["shop_url"])), rows))
    for g, got in results:
        if not got:
            continue
        price, rrp, stock = got
        label = f"{g['brand']} {g['name']}".strip()
        if not same_money(price, g.get("price_aud")):
            try:
                was = money(float(g["price_aud"]))
            except (TypeError, ValueError):
                was = "no price"
            out.add("gear_price", "gear", f"{label} is now {money(price)} at {g['shop']}",
                    f"The site says {was}." + (f" It's on sale from {money(rrp)}." if rrp else ""),
                    g["shop_url"],
                    {"op": "csv_set", "file": "gear.csv", "key": "id", "value": g["id"],
                     "expect": {"price_aud": g["price_aud"]},
                     "set": {"price_aud": f"{price:g}", "rrp_aud": "" if rrp is None else f"{rrp:g}",
                             "checked": today.isoformat()}})
        # Stock isn't reported: shops often show "sold out" online for things
        # that are in their stores, so it gave too many false alarms.


# ---------------------------------------------------------------- links

def collect_links():
    found = set()
    for f in site_files():
        t = f.read_text(encoding="utf-8", errors="replace")
        if f.suffix == ".csv":
            for row in csv.reader(io.StringIO(t)):
                found.update(c.strip() for c in row if c.strip().startswith("http"))
        else:
            found.update(re.findall(r'(?:href|src)="(https?://[^"]+)"', t))
            found.update(URL_RE.findall(t))
    urls = set()
    for u in found:
        u = html.unescape(u).rstrip(".,;:'\"")
        parts = urllib.parse.urlsplit(u)
        host = parts.hostname or ""
        if host in SKIP_HOSTS or host.endswith(SKIP_HOST_SUFFIXES):
            continue
        if "google." in host and parts.path.startswith("/maps"):
            continue  # map searches always load
        if "#" in u or "{" in u or "$" in u:
            continue
        if host.endswith("mtbsa.com.au") and parts.path.endswith((".png", ".svg", ".ico", ".pdf")):
            continue
        urls.add(u)
    return sorted(u for u in urls if u + "/" not in urls)


def ask_url(url):
    """A change the dashboard finishes: the person pastes the new link."""
    files = files_containing(url)
    return {"op": "replace_text", "files": files, "from": url, "to": "", "ask": "url"} if files else None


def check_links(urls, out):
    blocked = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        pages = list(pool.map(fetch_retry, urls))
    for p in pages:
        url = p.url
        a, b = urllib.parse.urlsplit(url), urllib.parse.urlsplit(p.final)
        used = ", ".join(files_containing(url)) or "the site"
        host = (a.hostname or "").lower()
        if p.status in (400, 401, 403, 429) or host.endswith(BLOCKS_ROBOTS):
            # Sites that turn away automatic checks; not a real break.
            blocked += 1
        elif p.status == 0 or p.status >= 400:
            why = ("the site didn't answer" if p.status == 0 else
                   "page not found" if p.status in (404, 410) else f"error {p.status}")
            out.add("link_broken", "links", f"Broken link: {url}",
                    f"It didn't work today ({why}). It's used in {used}. Paste a working link to "
                    "swap it in, or Dismiss if it's just having a bad day.", url,
                    ask_url(url), key=url)
        elif a.path.strip("/") and not b.path.strip("/"):
            out.add("link_home", "links", f"Link now goes to a home page: {url}",
                    f"It now ends up at {p.final}, so the page it pointed to has probably gone. "
                    f"It's used in {used}. Paste a better link to swap it in.", url,
                    ask_url(url), key=url)
        elif "/products/" in a.path and "/products/" not in b.path:
            out.add("link_home", "links", f"Shop link no longer goes to the product: {url}",
                    f"It now ends up at {p.final}. It's used in {used}. Paste the product's new "
                    "link to swap it in.", url, ask_url(url), key=url)
        elif p.permanent and p.final.rstrip("/") != url.rstrip("/") and b.hostname:
            files = files_containing(url)
            if files:
                out.add("link_moved", "links", f"Link has moved: {url}",
                        f"It now lives at {p.final}. Adding swaps the old address for the new one "
                        f"in {', '.join(files)}.", p.final,
                        {"op": "replace_text", "files": files, "from": url, "to": p.final})
    return blocked


# ---------------------------------------------------------------- auto-fix

# Changes that come straight from the organiser or shop (including when entries
# open and close), so the morning check
# makes them itself. New races and heads-ups still wait for the dashboard.
AUTO_KINDS = {"race_date", "race_entries", "link_moved", "gear_price"}


def csv_records(text):
    """Splits CSV text into (fields, start, end) for each record."""
    out, i, n = [], 0, len(text)
    while i < n:
        start, fields, field, quoted = i, [], "", False
        while True:
            if i >= n:
                fields.append(field)
                break
            ch = text[i]
            if quoted:
                if ch == '"' and text[i + 1:i + 2] == '"':
                    field += '"'; i += 2
                elif ch == '"':
                    quoted = False; i += 1
                else:
                    field += ch; i += 1
                continue
            if ch == '"' and field == "":
                quoted = True; i += 1
            elif ch == ",":
                fields.append(field); field = ""; i += 1
            elif ch == "\r" and text[i + 1:i + 2] == "\n":
                fields.append(field); i += 2
                break
            elif ch == "\n":
                fields.append(field); i += 1
                break
            else:
                field += ch; i += 1
        if fields != [""]:
            out.append((fields, start, i))
    return out


def csv_quote(v):
    v = "" if v is None else str(v)
    if re.search(r'[",\r\n]', v) or v != v.strip():
        return '"' + v.replace('"', '""') + '"'
    return v


def csv_set(text, key, value, set_, expect):
    """Changes one row and leaves every other line exactly as it was."""
    recs = csv_records(text)
    header = recs[0][0]
    k = header.index(key)
    for fields, start, end in recs[1:]:
        if len(fields) > k and fields[k] == value:
            for col, want in expect.items():
                if col in header and (fields[header.index(col)] if header.index(col) < len(fields) else "") != (want or ""):
                    return None  # changed since the check looked
            new = [fields[c] if c < len(fields) else "" for c in range(len(header))]
            for col, v in set_.items():
                if col in header:
                    new[header.index(col)] = str(v)
            ending = re.search(r"\r?\n$", text[start:end])
            return text[:start] + ",".join(csv_quote(v) for v in new) + (ending.group(0) if ending else "") + text[end:]
    return None


def apply_change(change):
    """Applies one change to the files in this checkout. Returns the files changed."""
    op = change.get("op")
    files = change.get("files") if op == "replace_text" else [change.get("file")]
    changed = []
    for name in files or []:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+\.(csv|html|js)", name or ""):
            return []
        path = ROOT / name
        if not path.exists():
            return []
        text = path.read_text(encoding="utf-8")
        if op == "csv_set":
            new = csv_set(text, change["key"], change["value"], change.get("set", {}), change.get("expect", {}))
        elif op == "replace_text":
            new = text.replace(change["from"], change["to"]) if change["from"] in text else None
        else:
            new = None
        if new is not None and new != text:
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(new)
            changed.append(name)
    return changed


def auto_fix(suggestions, now):
    """Makes the safe fixes. Returns (fixed, still_to_look_at)."""
    fixed, rest = [], []
    for s in suggestions:
        if s["kind"] in AUTO_KINDS and s.get("change") and apply_change(s["change"]):
            fixed.append({"id": s["id"], "kind": s["kind"], "group": s["group"],
                          "title": s["title"], "url": s.get("url", ""),
                          "at": now.isoformat(timespec="seconds")})
        else:
            rest.append(s)
    return fixed, rest


# ---------------------------------------------------------------- main

def right_time(now):
    """Two crons are booked; only run on the one that's 8 AM in Adelaide."""
    if os.environ.get("EVENT_NAME") != "schedule":
        return True
    offset = now.utcoffset().total_seconds() / 3600
    want = {"30 21 * * *": 10.5, "30 22 * * *": 9.5}.get(os.environ.get("SCHEDULE", "").strip())
    return want is None or want == offset


def run(today, decided):
    races, gear, text = read_csv("races.csv"), read_csv("gear.csv"), site_text()
    out = Findings()
    check_calendars(races, text, today, out)
    check_auscycling(races, text, today, out)
    check_entryboss_entries(races, today, out)
    check_gear(gear, today, out)
    links = collect_links()
    blocked = check_links(links, out)
    order = {"calendar": 0, "gear": 1, "links": 2, "sources": 3}
    suggestions = sorted((s for s in out.items if s["id"] not in decided),
                         key=lambda s: (order.get(s["group"], 9), s["title"]))
    return suggestions, {"links": len(links), "blocked": blocked,
                         "races": len(races), "gear": len(gear)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", help="where to write results.json")
    ap.add_argument("--decisions", help="decisions.json from the dashboard (added/dismissed)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--auto-fix", action="store_true",
                    help="make the safe fixes in this checkout (dates, moved links, exact prices)")
    ap.add_argument("--commit-message", help="where to write a commit message for the fixes")
    args = ap.parse_args()

    now = dt.datetime.now(ADELAIDE)
    if not right_time(now):
        print(f"Not 8 AM in Adelaide on this schedule ({now:%H:%M %Z}), skipping.")
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as f:
                f.write("skipped=true\n")
        return

    decided = {}
    if args.decisions and Path(args.decisions).exists():
        try:
            decided = json.loads(Path(args.decisions).read_text()).get("decisions", {})
        except ValueError:
            decided = {}

    suggestions, checked = run(now.date(), decided)
    fixed = []
    if args.auto_fix and not args.dry_run:
        fixed, suggestions = auto_fix(suggestions, now)
        for f in fixed:
            decided[f["id"]] = {"action": "auto", "at": f["at"], "title": f["title"]}
        if args.decisions and fixed:
            Path(args.decisions).write_text(json.dumps({"decisions": decided}, indent=1) + "\n", encoding="utf-8")
        if args.commit_message and fixed:
            lines = [f"Daily site check: {len(fixed)} automatic fix" + ("es" if len(fixed) > 1 else ""), ""]
            lines += [f"- {f['title']}" for f in fixed]
            Path(args.commit_message).write_text("\n".join(lines) + "\n", encoding="utf-8")
    result = {
        "generated": now.isoformat(timespec="seconds"),
        "generated_text": now.strftime("%A %-d %B %Y, %-I:%M %p"),
        "checked": checked,
        "suggestions": suggestions,
        "auto_fixed": fixed,
    }
    for f in fixed:
        print(f"[fixed] {f['title']}")
    for s in suggestions:
        print(f"[{s['group']}] {s['title']}")
    print(f"{len(suggestions)} suggestion(s), {checked['links']} links checked, "
          f"{checked['blocked']} skipped because they block robots.")
    if args.out and not args.dry_run:
        Path(args.out).write_text(json.dumps(result, indent=1, ensure_ascii=False) + "\n",
                                  encoding="utf-8")


if __name__ == "__main__":
    main()
