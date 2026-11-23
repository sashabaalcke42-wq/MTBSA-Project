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
SKIP_HOSTS = {"fonts.googleapis.com", "fonts.gstatic.com", "schema.org",
              "www.w3.org", "gc.zgo.at"}
SKIP_HOST_SUFFIXES = (".posthog.com", ".goatcounter.com")
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
        "entry_url": entry_url,
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
                            f"The organiser's calendar now calls it \"{name}\". Have a look and "
                            "ask Claude to update or remove it.", url, key=rid + name)
            elif day and day >= today and not CANCELLED.search(name):
                row = new_race_row(races, name, day, course, org, cal_url, url,
                                   guess_level(name, cal), guess_type(name, cal))
                out.add("race_new", "calendar", f"New race: {name} on {nice(day)}",
                        f"On the {org} calendar but not on the site yet. Check the details "
                        "before adding.", url,
                        {"op": "csv_append", "file": "races.csv", "row": row}, key=rid)


AC_DATE = re.compile(
    r"\b([A-Z][a-z]{2}) (\d{1,2})(?:\s*[–-]\s*(?:([A-Z][a-z]{2}) )?(\d{1,2}))?, (\d{4})\b")


def auscycling_page(url):
    """Returns (title, start, end) from an AusCycling event page, or None."""
    p = fetch_retry(url)
    if p.status != 200:
        return None
    body = re.sub(r"<script.*?</script>|<style.*?</style>", " ", p.text, flags=re.S)
    title = re.search(r"<h1[^>]*>(.*?)</h1>", body, re.S)
    title = html.unescape(re.sub(r"<[^>]+>", "", title.group(1))).strip() if title else ""
    m = AC_DATE.search(html.unescape(re.sub(r"<[^>]+>", " ", body)))
    if not m:
        return title, None, None
    mon, d1, mon2, d2, yr = m.groups()
    try:
        start = dt.datetime.strptime(f"{mon} {d1} {yr}", "%b %d %Y").date()
        end = dt.datetime.strptime(f"{mon2 or mon} {d2} {yr}", "%b %d %Y").date() if d2 else None
    except ValueError:
        return title, None, None
    return title, start, end


def check_auscycling(races, text, today, out):
    for r in races:
        url = (r.get("entry_url") or "").strip()
        our_day = to_date(r["date"])
        if "auscycling.org.au/events/" not in url or not our_day or our_day < today:
            continue
        got = auscycling_page(url)
        if not got:
            continue  # the link check reports broken pages
        _, day, end = got
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
        change = None
        if day:
            level = "National" if "national" in s else "State"
            row = new_race_row(races, title, day, "See entry page", "AusCycling",
                               "https://auscycling.org.au/", url, level, guess_type(title, ""))
            if got[2]:
                row["end_date"] = got[2].isoformat()
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
    p = fetch_retry(url)
    if p.status != 200:
        return None
    m = (re.search(r'property="product:price:amount"\s+content="([\d.]+)"', p.text)
         or re.search(r'itemprop="price"\s+content="([\d.]+)"', p.text)
         or re.search(r'"@type"\s*:\s*"Offer".{0,400}?"price"\s*:\s*"?([\d.]+)', p.text, re.S))
    if not m:
        return None
    stock = not re.search(r'schema\.org/OutOfStock|"availability"\s*:\s*"OutOfStock"', p.text)
    return float(m.group(1)), None, stock


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
        if not stock:
            out.add("gear_stock", "gear", f"{label} looks sold out at {g['shop']}",
                    "You might want to point it to another shop or swap it for something similar.",
                    g["shop_url"], key=g["id"])


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


def check_links(urls, out):
    blocked = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        pages = list(pool.map(fetch_retry, urls))
    for p in pages:
        url = p.url
        a, b = urllib.parse.urlsplit(url), urllib.parse.urlsplit(p.final)
        used = ", ".join(files_containing(url)) or "the site"
        if p.status in (401, 403, 429):  # sites that block robots; not a real break
            blocked += 1
        elif p.status == 0 or p.status >= 400:
            why = ("the site didn't answer" if p.status == 0 else
                   "page not found" if p.status in (404, 410) else f"error {p.status}")
            out.add("link_broken", "links", f"Broken link: {url}",
                    f"It didn't work today ({why}). It's used in {used}.", url, key=url)
        elif a.path.strip("/") and not b.path.strip("/"):
            out.add("link_home", "links", f"Link now goes to a home page: {url}",
                    f"It now ends up at {p.final}, so the page it pointed to has probably gone. "
                    f"It's used in {used}.", url, key=url)
        elif "/products/" in a.path and "/products/" not in b.path:
            out.add("link_home", "links", f"Shop link no longer goes to the product: {url}",
                    f"It now ends up at {p.final}. It's used in {used}.", url, key=url)
        elif p.permanent and p.final.rstrip("/") != url.rstrip("/") and b.hostname:
            files = files_containing(url)
            if files:
                out.add("link_moved", "links", f"Link has moved: {url}",
                        f"It now lives at {p.final}. Adding swaps the old address for the new one "
                        f"in {', '.join(files)}.", p.final,
                        {"op": "replace_text", "files": files, "from": url, "to": p.final})
    return blocked


# ---------------------------------------------------------------- main

def right_time(now):
    """Two crons are booked; only run on the one that's 9 AM in Adelaide."""
    if os.environ.get("EVENT_NAME") != "schedule":
        return True
    offset = now.utcoffset().total_seconds() / 3600
    want = {"30 22 * * *": 10.5, "30 23 * * *": 9.5}.get(os.environ.get("SCHEDULE", "").strip())
    return want is None or want == offset


def run(today, decided):
    races, gear, text = read_csv("races.csv"), read_csv("gear.csv"), site_text()
    out = Findings()
    check_calendars(races, text, today, out)
    check_auscycling(races, text, today, out)
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
    args = ap.parse_args()

    now = dt.datetime.now(ADELAIDE)
    if not right_time(now):
        print(f"Not 9 AM in Adelaide on this schedule ({now:%H:%M %Z}), skipping.")
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
    result = {
        "generated": now.isoformat(timespec="seconds"),
        "generated_text": now.strftime("%A %-d %B %Y, %-I:%M %p"),
        "checked": checked,
        "suggestions": suggestions,
    }
    for s in suggestions:
        print(f"[{s['group']}] {s['title']}")
    print(f"{len(suggestions)} suggestion(s), {checked['links']} links checked, "
          f"{checked['blocked']} skipped because they block robots.")
    if args.out and not args.dry_run:
        Path(args.out).write_text(json.dumps(result, indent=1, ensure_ascii=False) + "\n",
                                  encoding="utf-8")


if __name__ == "__main__":
    main()
